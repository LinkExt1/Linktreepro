const { getAdminApp, handleCors, verifyBearerUser, validUid } = require('./_security');

module.exports = async (req, res) => {
  const c = handleCors(req, res); if (c) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  try {
    const decoded = await verifyBearerUser(req);
    const uid = decoded.uid;
    if (!validUid(uid)) return res.status(401).json({ ok: false, error: 'Utilisateur invalide.' });
    const db = getAdminApp().firestore();
    const ref = db.collection('users').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: 'Profil introuvable.' });
    await ref.update({ displayedViews: 0, publicViews: 0, updatedAt: new Date() });
    return res.status(200).json({ ok: true, displayedViews: 0 });
  } catch (e) {
    if (e.message === 'AUTH_REQUIRED') return res.status(401).json({ ok: false, error: 'Authentification requise.' });
    console.error('reset-views:', e);
    return res.status(500).json({ ok: false, error: 'Impossible de réinitialiser les vues.' });
  }
};
