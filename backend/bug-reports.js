const {
  getAdminApp,
  handleCors,
  verifyAdmin,
  verifyBearerUser,
  validUid,
  enforceRateLimit,
  getClientIp
} = require('./_security');
const { getModerationConfig } = require('./moderation-config');

function cleanMessage(value) {
  return String(value || '').trim().slice(0, 1000);
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return ['pending', 'in_progress', 'resolved', 'rejected'].includes(status) ? status : '';
}

function serializeDoc(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    uid: String(data.uid || data.userId || ''),
    message: String(data.message || ''),
    status: String(data.status || 'pending'),
    pagePath: String(data.pagePath || ''),
    userAgent: String(data.userAgent || ''),
    createdAt: data.createdAt?.toDate?.()?.toISOString?.() || data.createdAt || data.timestamp?.toDate?.()?.toISOString?.() || data.timestamp || null,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() || data.updatedAt || null
  };
}

module.exports = async (req, res) => {
  const cors = handleCors(req, res);
  if (cors) return;

  try {
    const db = getAdminApp().firestore();

    if (req.method === 'POST') {
      const decoded = await verifyBearerUser(req);
      if (!validUid(decoded.uid)) return res.status(401).json({ ok: false, error: 'Utilisateur invalide.' });
      const message = cleanMessage(req.body?.message);
      if (message.length < 10) return res.status(400).json({ ok: false, error: 'Le signalement doit contenir au moins 10 caractères.' });

      const rate = await enforceRateLimit(db, {
        action: 'bug_report',
        uid: decoded.uid,
        ip: getClientIp(req),
        limit: 10,
        windowSeconds: 3600
      });
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfter));
        return res.status(429).json({ ok: false, error: 'Trop de signalements depuis cette origine.' });
      }

      const ref = await db.collection('bug_reports').add({
        uid: decoded.uid,
        message,
        pagePath: String(req.body?.pagePath || '').slice(0, 300),
        userAgent: String(req.body?.userAgent || '').slice(0, 500),
        createdAt: new Date(),
        status: 'pending'
      });
      return res.status(201).json({ ok: true, id: ref.id });
    }

    await verifyAdmin(req);

    if (req.method === 'GET') {
      const moderationConfig = await getModerationConfig();
      const configuredLimit = Number(moderationConfig.sanction?.bugLogDisplayLimit);
      const requestedLimit = Number(req.query?.limit);
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(200, Math.floor(requestedLimit))
        : (Number.isFinite(configuredLimit) && configuredLimit > 0 ? Math.min(200, Math.floor(configuredLimit)) : 6);
      let snap;
      try {
        snap = await db.collection('bug_reports').orderBy('createdAt', 'desc').limit(limit).get();
      } catch (_) {
        snap = await db.collection('bug_reports').limit(limit).get();
      }
      const reports = snap.docs.map(serializeDoc).sort((a, b) => {
        const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bt - at;
      }).slice(0, limit);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ ok: true, reports, limit });
    }

    if (req.method === 'DELETE' && (req.body?.all === true || String(req.query?.all || '') === 'true')) {
      let deleted = 0;
      while (true) {
        const batchSnap = await db.collection('bug_reports').limit(400).get();
        if (batchSnap.empty) break;
        const batch = db.batch();
        batchSnap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        deleted += batchSnap.size;
        if (batchSnap.size < 400) break;
      }
      return res.status(200).json({ ok: true, deleted, all: true });
    }

    const id = String(req.body?.id || req.query?.id || '').trim();
    if (!id || id.length > 200) return res.status(400).json({ ok: false, error: 'Signalement invalide.' });
    const ref = db.collection('bug_reports').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: 'Signalement introuvable.' });

    if (req.method === 'PATCH') {
      const status = normalizeStatus(req.body?.status);
      if (!status) return res.status(400).json({ ok: false, error: 'Statut de signalement invalide.' });
      await ref.update({ status, updatedAt: new Date() });
      return res.status(200).json({ ok: true, status });
    }

    if (req.method === 'DELETE') {
      await ref.delete();
      return res.status(200).json({ ok: true, deleted: true });
    }

    res.setHeader('Allow', 'GET,POST,PATCH,DELETE,OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  } catch (e) {
    if (e.message === 'AUTH_REQUIRED') return res.status(401).json({ ok: false, error: 'Authentification requise.' });
    if (e.message === 'ADMIN_REQUIRED') return res.status(403).json({ ok: false, error: 'Accès administrateur requis.' });
    console.error('bug-reports:', e && e.message ? e.message : e);
    return res.status(500).json({ ok: false, error: 'Impossible de gérer les signalements.' });
  }
};
