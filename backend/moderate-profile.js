const { getAdminApp, handleCors, verifyBearerUser, validUid } = require('./_security');
const { moderateProfileData, getAiConfig } = require('./ai-moderator');

async function addEmailToBlacklist(db, email, reason, durationDays) {
  const normalized = String(email || '').trim().toLowerCase();
  const days = Number(durationDays);
  if (!normalized || !Number.isFinite(days) || days <= 0) return false;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 86400000);
  const id = Buffer.from(normalized).toString('base64url');
  await db.collection('blacklisted_emails').doc(id).set({
    email: normalized,
    createdAt: now,
    expiresAt,
    reason: String(reason || '').slice(0, 500)
  }, { merge: true });
  return true;
}

async function writeAudit(db, entry) {
  try {
    await db.collection('moderation_audit_logs').add({ ...entry, createdAt: new Date() });
  } catch (e) {
    console.error('moderation_audit_logs:', e && e.message ? e.message : e);
  }
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
    const ref = db.collection('users').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: 'Profil introuvable.' });
    const profile = snap.data() || {};
    const isAdmin = decoded.admin === true || String(profile.role || '').toLowerCase() === 'admin';
    if (isAdmin) return res.status(200).json({ ok: true, skipped: true, adminExempt: true, status: 'ACTIVE' });

    const cfg = await getAiConfig();
    const moderation = await moderateProfileData(profile, { isAdmin: false });

    if (moderation.unavailable === true || moderation.skipped === true) {
      const behavior = String(cfg.unavailableBehavior || '').trim();
      if (behavior === 'manual_review' || moderation.reviewRequired === true) {
        await ref.set({
          accountStatus: 'PENDING_REVIEW',
          status: 'PENDING_REVIEW',
          isSuspended: false,
          isBanned: false,
          moderationReview: { createdAt: new Date(), source: 'ai_unavailable' }
        }, { merge: true });
        return res.status(200).json({ ok: true, status: 'PENDING_REVIEW', reviewRequired: true });
      }
      if (behavior === 'allow' || moderation.action === 'ALLOW') {
        await ref.set({ accountStatus: 'active', status: 'ACTIVE', isSuspended: false, isBanned: false, moderationReview: null }, { merge: true });
        return res.status(200).json({ ok: true, status: 'ACTIVE', unavailable: true });
      }
      return res.status(200).json({ ok: true, status: String(profile.accountStatus || 'active').toUpperCase(), deferred: true });
    }

    if (!moderation.flagged && moderation.action !== 'BLOCK' && moderation.action !== 'CORRECTION_PENDING') {
      await ref.set({
        accountStatus: 'active',
        status: 'ACTIVE',
        isSuspended: false,
        isBanned: false,
        moderationCorrection: null,
        moderationReview: null,
        moderationValidatedAt: new Date()
      }, { merge: true });
      return res.status(200).json({ ok: true, status: 'ACTIVE', validated: true });
    }

    const sanction = cfg.moderation && typeof cfg.moderation === 'object' ? cfg.moderation : {};
    const configuredStatus = String(sanction.defaultStatus || '').trim().toLowerCase();
    const duration = Number(sanction.defaultDurationDays);
    const nextCountBase = Number(profile.suspensionCount || 0);
    const nextCount = nextCountBase + 1;
    const threshold = Number(sanction.maxAllowed ?? sanction.recurrenceThreshold);
    const autoBan = configuredStatus === 'suspended' && Number.isFinite(threshold) && threshold > 0 && nextCount >= threshold;
    const finalStatus = autoBan || configuredStatus === 'banned' ? 'banned' : 'suspended';
    const now = new Date();
    const reason = String(moderation.reason || moderation.report || '').slice(0, 500);
    const report = String(moderation.report || moderation.reason || '').slice(0, 5000);
    const fields = Array.isArray(moderation.fields) ? moderation.fields.slice(0, 30) : [];
    const endsAt = finalStatus === 'suspended' && Number.isFinite(duration) && duration > 0
      ? new Date(now.getTime() + duration * 86400000)
      : null;

    const write = {
      accountStatus: finalStatus === 'banned' ? 'banned' : 'CORRECTION_PENDING',
      status: finalStatus === 'banned' ? 'BANNED' : 'CORRECTION_PENDING',
      isSuspended: finalStatus !== 'banned',
      isBanned: finalStatus === 'banned',
      suspensionCount: nextCount,
      suspensionReason: reason,
      banReason: reason,
      banReasonReport: report,
      suspendedAt: now,
      suspensionEndsAt: endsAt,
      bannedAt: finalStatus === 'banned' ? now : null,
      moderationCorrection: finalStatus === 'banned' ? null : {
        required: true,
        fields,
        report,
        reason,
        createdAt: now
      },
      moderationIncident: {
        fields,
        report,
        reason,
        source: moderation.source || 'ai',
        model: moderation.model || null,
        confidence: moderation.confidence ?? null,
        createdAt: now
      },
      moderationReview: null
    };

    await ref.set(write, { merge: true });
    if (finalStatus === 'banned') {
      try { await app.auth().updateUser(uid, { disabled: true }); } catch (e) { console.warn('auth disable after moderation:', e.message); }
      await addEmailToBlacklist(db, decoded.email || profile.email || '', reason, sanction.blacklistAfterDays);
    }

    await writeAudit(db, {
      uid,
      email: String(decoded.email || profile.email || ''),
      action: finalStatus === 'banned' ? 'BANNED' : 'SUSPENDED',
      reason,
      report,
      fields,
      source: moderation.source || 'ai',
      model: moderation.model || null,
      confidence: moderation.confidence ?? null
    });

    return res.status(200).json({
      ok: true,
      status: finalStatus === 'banned' ? 'BANNED' : 'CORRECTION_PENDING',
      suspended: finalStatus !== 'banned',
      banned: finalStatus === 'banned',
      suspensionCount: nextCount,
      report,
      fields
    });
  } catch (e) {
    console.error('moderate-profile:', e && e.stack ? e.stack : e);
    return res.status(200).json({ ok: false, deferred: true, error: 'Analyse différée indisponible.' });
  }
};
