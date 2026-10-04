const { getAdminApp, handleCors, verifyBearerUser, validUid } = require('./_security');
const { getAiConfig } = require('./ai-moderator');

const BLOCKED_KEYS = new Set([
  'role', 'accountStatus', 'status', 'banReason', 'banReasonReport', 'adminContactLink', 'createdAt', 'uid',
  'views', 'totalViews', 'badgeRawViews', 'badgeWindowViews', 'badgeWindowStartAt',
  'badgeEvaluationStartAt', 'badgeResetAt', 'badgeManual', 'verified',
  'isBanned', 'isSuspended', 'bannedAt', 'suspendedAt', 'suspensionEndsAt',
  'suspensionReason', 'moderationIncident', 'moderationCorrection', 'suspensionCount',
  'moderationReview', 'moderationCompletedAt'
]);

function correctionSatisfied(correction, clean) {
  if (!correction?.required) return true;
  const fields = Array.isArray(correction.fields) ? correction.fields : [];
  const baseline = correction.baselineHashes && typeof correction.baselineHashes === 'object' ? correction.baselineHashes : {};
  return fields.some(field => Object.prototype.hasOwnProperty.call(clean, field) && hash(clean[field]) !== baseline[field]);
}

function hash(value) {
  let serialized;
  try { serialized = JSON.stringify(value ?? null); } catch (_) { serialized = String(value ?? ''); }
  return require('crypto').createHash('sha256').update(serialized).digest('hex');
}

module.exports = async (req, res) => {
  const cors = handleCors(req, res);
  if (cors) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  try {
    const decoded = await verifyBearerUser(req);
    const uid = decoded.uid;
    if (!validUid(uid)) return res.status(401).json({ ok: false, error: 'Utilisateur invalide.' });

    const app = getAdminApp();
    const db = app.firestore();
    const userRef = db.collection('users').doc(uid);
    const currentSnap = await userRef.get();
    const current = currentSnap.exists ? (currentSnap.data() || {}) : {};
    const body = req.body || {};
    const patch = body.data && typeof body.data === 'object' ? body.data : {};
    const clean = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!BLOCKED_KEYS.has(key)) clean[key] = value;
    }
    if (!Object.keys(clean).length) return res.status(400).json({ ok: false, error: 'Aucune donnée à sauvegarder.' });

    const isAdmin = decoded.admin === true || String(current.role || '').toLowerCase() === 'admin';
    const hasNameChange = Object.prototype.hasOwnProperty.call(clean, 'displayName') && String(clean.displayName ?? '') !== String(current.displayName ?? '');
    const hasPhotoChange = Object.prototype.hasOwnProperty.call(clean, 'photoURL') && String(clean.photoURL ?? '') !== String(current.photoURL ?? '');
    const effectiveNonLinkKeys = Object.keys(clean).filter(key => key !== 'links' && hash(clean[key]) !== hash(current[key]));
    const linksArePresent = Object.prototype.hasOwnProperty.call(clean, 'links');
    const onlyLinksChange = linksArePresent && effectiveNonLinkKeys.length === 0;
    const accountStatus = String(current.accountStatus || 'active').toUpperCase();
    const correction = current.moderationCorrection && typeof current.moderationCorrection === 'object' ? current.moderationCorrection : null;
    const completeCorrection = body.completeCorrection === true;

    if (!isAdmin) {
      const correctionMode = correction?.required === true && completeCorrection;
      if (!['ACTIVE', 'CORRECTION_PENDING', 'SUSPENDED'].includes(accountStatus) && !correctionMode) {
        return res.status(403).json({ ok: false, error: 'Modification non autorisée pour ce compte.' });
      }
      if (correction?.required && !completeCorrection) {
        return res.status(409).json({
          ok: false,
          correctionRequired: true,
          report: String(correction.report || current.banReasonReport || ''),
          fields: Array.isArray(correction.fields) ? correction.fields : [],
          error: 'Correction requise.'
        });
      }
      // Une soumission explicite du formulaire de correction termine le verrou.
      // Les drapeaux correctionRequired/flaggedFields sont réinitialisés atomiquement
      // avec la nouvelle version du profil. Il ne faut donc pas rejeter la sauvegarde
      // parce qu'un ancien baseline n'a pas changé exactement comme attendu.
      if (correction?.required && completeCorrection) {
        // Intentionnellement aucun blocage ici : la sauvegarde est la preuve de
        // soumission de la correction. La conformité éventuelle est réévaluée
        // séparément par le workflow de modération différée.
      }
    }

    const now = new Date();
    const aiConfig = isAdmin ? null : await getAiConfig();
    const write = {
      ...clean,
      accountStatus: 'active',
      status: 'ACTIVE',
      isSuspended: false,
      isBanned: false,
      suspensionReason: null,
      suspendedAt: null,
      suspensionEndsAt: null,
      moderationCorrection: null,
      correctionRequired: false,
      flaggedFields: [],
      moderationIncident: null,
      moderationReview: null,
      banReason: '',
      banReasonReport: '',
      moderationSavedAt: now
    };

    let quotaState = { dailyChangesCount: Number(current.dailyChangesCount || 0), lastChangeDate: current.lastChangeDate || null };
    const appConfigSnap = await db.collection('settings').doc('app_config').get();
    const appConfig = appConfigSnap.exists ? (appConfigSnap.data() || {}) : {};
    const maxDailyProfileChangesRaw = Number(appConfig.maxDailyProfileChanges);
    const maxDailyProfileChanges = Number.isFinite(maxDailyProfileChangesRaw) && maxDailyProfileChangesRaw >= 0 ? Math.floor(maxDailyProfileChangesRaw) : 10;
    const sensitiveProfileChange = hasNameChange || hasPhotoChange;
    await db.runTransaction(async tx => {
      const latestSnap = await tx.get(userRef);
      const latest = latestSnap.exists ? (latestSnap.data() || {}) : {};
      const today = new Date().toISOString().slice(0, 10);
      const sameDay = String(latest.lastChangeDate || '') === today;
      let dailyChangesCount = sameDay ? Number(latest.dailyChangesCount || 0) : 0;
      if (!isAdmin && sensitiveProfileChange && maxDailyProfileChanges > 0 && dailyChangesCount >= maxDailyProfileChanges) {
        throw new Error('PROFILE_DAILY_LIMIT');
      }
      if (sensitiveProfileChange) dailyChangesCount += 1;
      const quotaPatch = sensitiveProfileChange ? { dailyChangesCount, lastChangeDate: today } : {};
      tx.set(userRef, { ...write, ...quotaPatch }, { merge: true });
      quotaState = { dailyChangesCount, lastChangeDate: sensitiveProfileChange ? today : latest.lastChangeDate || null };
    });
    try { await app.auth().updateUser(uid, { disabled: false }); } catch (e) { console.warn('auth enable after profile save:', e.message); }

    return res.status(200).json({
      ok: true,
      data: clean,
      correctionCompleted: correction?.required === true && completeCorrection,
      adminExempt: isAdmin,
      moderationDeferred: !isAdmin,
      moderationDelaySeconds: Number.isFinite(Number(aiConfig?.moderationDelaySeconds)) ? Number(aiConfig.moderationDelaySeconds) : 120,
      status: 'ACTIVE',
      accountStatus: 'active',
      isSuspended: false,
      suspensionReason: null,
      suspensionCount: Number(current.suspensionCount || 0),
      dailyChangesCount: quotaState.dailyChangesCount,
      maxDailyProfileChanges,
      lastChangeDate: quotaState.lastChangeDate,
      savedAt: now.toISOString()
    });
  } catch (e) {
    if (e.message === 'PROFILE_DAILY_LIMIT') return res.status(429).json({ ok: false, error: 'Vous avez atteint la limite quotidienne de modifications.', field: 'profile' });
    if (e.message === 'AUTH_REQUIRED') return res.status(401).json({ ok: false, error: 'Authentification requise.' });
    console.error('save-profile:', e && e.message ? e.message : e);
    return res.status(500).json({ ok: false, error: 'Impossible de sauvegarder le profil.' });
  }
};
