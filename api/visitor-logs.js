const admin = require('firebase-admin');
const {
  getAdminApp,
  handleCors,
  validUid,
  verifyBearerUser
} = require('./_security');

function parseLimit(value, fallback = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

module.exports = async (req, res) => {
  const corsHandled = handleCors(req, res);
  if (corsHandled) return;
  if (!['GET', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, DELETE, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    const decoded = await verifyBearerUser(req);
    const uid = decoded.uid;
    if (!validUid(uid)) return res.status(401).json({ ok: false, error: 'Utilisateur invalide.' });

    const requestedUid = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
    if (requestedUid && requestedUid !== uid) {
      return res.status(403).json({ ok: false, error: 'Accès refusé.' });
    }

    const app = getAdminApp();
    const db = app.firestore();
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists || userSnap.data()?.accountStatus === 'banned') {
      return res.status(403).json({ ok: false, error: 'Compte non autorisé.' });
    }

    const logsRef = userRef.collection('visitor_logs');
    if (req.method === 'DELETE') {
      let deleted = 0;
      while (true) {
        const snap = await logsRef.limit(400).get();
        if (snap.empty) break;
        const batch = db.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        deleted += snap.size;
        if (snap.size < 400) break;
      }
      return res.status(200).json({ ok: true, deleted });
    }

    const limit = parseLimit(req.query?.limit, 100);
    const snap = await logsRef.orderBy('timestamp', 'desc').limit(limit).get();
    const logs = snap.docs.map(doc => {
      const data = doc.data() || {};
      const timestamp = data.timestamp?.toDate ? data.timestamp.toDate().toISOString() : (data.timestamp || null);
      return { id: doc.id, country: data.country || 'XX', timestamp, dateStr: data.dateStr || '', hourStr: data.hourStr || '' };
    });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ ok: true, logs });
  } catch (error) {
    if (error.message === 'AUTH_REQUIRED') return res.status(401).json({ ok: false, error: 'Authentification requise.' });
    console.error('Erreur API visitor logs:', error);
    return res.status(500).json({ ok: false, error: 'Impossible de charger l’historique des visites.' });
  }
};
