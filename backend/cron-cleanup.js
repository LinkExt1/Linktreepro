const cloudinary = require('cloudinary').v2;
const { getAdminApp } = require('./_security');
const { getModerationConfig } = require('./moderation-config');

async function deleteCollection(db, ref, batchSize = 300) {
  while (true) {
    const s = await ref.limit(batchSize).get();
    if (s.empty) break;
    const b = db.batch();
    s.docs.forEach((d) => b.delete(d.ref));
    await b.commit();
    if (s.size < batchSize) break;
  }
}

async function cloudDelete(uid) {
  const { CLOUDINARY_CLOUD_NAME: cn, CLOUDINARY_API_KEY: ak, CLOUDINARY_API_SECRET: as } = process.env;
  if (!cn || !ak || !as) return;
  cloudinary.config({ cloud_name: cn, api_key: ak, api_secret: as, secure: true });
  try {
    await cloudinary.api.delete_resources_by_prefix(`linkext/${uid}/`, { resource_type: 'image', type: 'upload', invalidate: true });
  } catch (e) {
    console.warn('cron Cloudinary:', e.message);
  }
}

async function purgeExpiredOtps(db) {
  const now = new Date();
  let purged = 0;
  try {
    // otp_challenges expirés
    const challenges = await db.collection('otp_challenges').where('expiresAt', '<=', now).limit(200).get();
    if (!challenges.empty) {
      const batch = db.batch();
      challenges.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      purged += challenges.size;
    }
  } catch (e) {
    console.warn('purge otp_challenges:', e.message);
  }
  try {
    const requests = await db.collection('otp_requests').where('expiresAt', '<=', now).limit(200).get();
    if (!requests.empty) {
      const batch = db.batch();
      requests.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      purged += requests.size;
    }
  } catch (e) {
    console.warn('purge otp_requests:', e.message);
  }
  try {
    const verifs = await db.collection('appeal_verifications').where('expiresAt', '<=', now).limit(200).get();
    if (!verifs.empty) {
      const batch = db.batch();
      verifs.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      purged += verifs.size;
    }
  } catch (e) {
    console.warn('purge appeal_verifications:', e.message);
  }
  return purged;
}


async function restoreExpiredSuspensions(db) {
  let restored = 0;
  try {
    const now = new Date();
    const snap = await db.collection('users').where('accountStatus', '==', 'suspended').limit(100).get();
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const raw = data.suspensionEndsAt;
      const endsAt = raw?.toDate ? raw.toDate() : new Date(raw || 0);
      if (!Number.isFinite(endsAt.getTime()) || endsAt.getTime() > now.getTime()) continue;
      await doc.ref.update({
        accountStatus: 'active',
        isBanned: false,
        suspendedAt: null,
        suspensionEndsAt: null,
        banReason: '',
        banReasonReport: ''
      });
      try {
        await db.collection('moderation_audit_logs').add({
          uid: doc.id,
          action: 'SANCTION_EXPIREE',
          source: 'scheduled_cleanup',
          createdAt: now
        });
      } catch (_) {}
      restored++;
    }
  } catch (e) {
    console.warn('restoreExpiredSuspensions:', e.message);
  }
  return restored;
}

module.exports = async (req, res) => {
  const auth = String(req.headers.authorization || '');
  const secret = String(process.env.CRON_SECRET || '');
  if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ ok: false, error: 'Non autorisé.' });
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  try {
    const db = getAdminApp().firestore();
    const moderationConfig = await getModerationConfig();
    const cleanupDays = Number(moderationConfig.sanction?.cleanupDeleteAfterDays);
    const blacklistDays = Number(moderationConfig.sanction?.blacklistAfterDays);
    const now = new Date();
    const cutoff = Number.isFinite(cleanupDays) && cleanupDays > 0 ? new Date(now.getTime() - cleanupDays * 86400000) : null;
    const expiry = Number.isFinite(blacklistDays) && blacklistDays > 0 ? new Date(now.getTime() + blacklistDays * 86400000) : null;

    const otpPurged = await purgeExpiredOtps(db);
    const suspensionExpiry = await restoreExpiredSuspensions(db);

    const snap = cutoff
      ? await db.collection('users').where('accountStatus', '==', 'suspended').where('suspendedAt', '<=', cutoff).limit(50).get()
      : { docs: [] };
    let deleted = 0;
    for (const doc of snap.docs) {
      const d = doc.data() || {};
      const uid = doc.id;
      const email = String(d.email || '').trim().toLowerCase();
      await deleteCollection(db, doc.ref.collection('visitor_logs'));
      await deleteCollection(db, doc.ref.collection('leads'));
      await doc.ref.delete();
      try {
        await getAdminApp().auth().deleteUser(uid);
      } catch (e) {
        if (e.code !== 'auth/user-not-found') console.warn('Auth cleanup:', e.message);
      }
      await cloudDelete(uid);
      if (email && expiry) {
        await db.collection('blacklisted_emails').doc(Buffer.from(email).toString('base64url')).set({
          email,
          expiresAt: expiry,
          createdAt: new Date(),
          reason: 'suspension_cleanup'
        });
      }
      deleted++;
    }
    return res.status(200).json({ ok: true, deleted, otpPurged, suspensionExpiry });
  } catch (e) {
    console.error('cron-cleanup:', e && e.message ? e.message : e);
    return res.status(500).json({ ok: false, error: 'Nettoyage impossible.' });
  }
};
