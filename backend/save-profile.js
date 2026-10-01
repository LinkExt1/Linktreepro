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
      if (correction?.required && completeCorrection && !correctionSatisfied(correction, clean)) {
        return res.status(409).json({
          ok: false,
          correctionRequired: true,
          report: String(correction.report || current.banReasonReport || ''),
          fields: Array.isArray(correction.fields) ? correction.fields : [],
          error: 'Une modification des champs signalés est requise.'
        });
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
      moderationIncident: null,
      moderationReview: null,
      banReason: '',
      banReasonReport: '',
      moderationSavedAt: now
    };

    await userRef.set(write, { merge: true });
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
      savedAt: now.toISOString()
    });
  } catch (e) {
    if (e.message === 'AUTH_REQUIRED') return res.status(401).json({ ok: false, error: 'Authentification requise.' });
    console.error('save-profile:', e && e.message ? e.message : e);
    return res.status(500).json({ ok: false, error: 'Impossible de sauvegarder le profil.' });
  }
};
