const {
  getAdminApp,
  getClientIp,
  originAllowed,
  handleCors,
  validUid,
  enforceRateLimit
} = require('./_security');

module.exports = async (req, res) => {
  const corsHandled = handleCors(req, res);
  if (corsHandled) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }
  if (!originAllowed(req)) return res.status(403).json({ ok: false, error: 'Origine refusée.' });

  const rawId = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
  const uid = typeof rawId === 'string' ? rawId.trim() : '';
  if (!validUid(uid)) return res.status(400).json({ ok: false, error: 'ID utilisateur invalide.' });

  try {
    const app = getAdminApp();
    const db = app.firestore();
    const userRef = db.collection('users').doc(uid);
    const rate = await enforceRateLimit(db, {
      action: 'subscribe', uid, ip: getClientIp(req), limit: 5, windowSeconds: 60
    });
    if (!rate.allowed) return res.status(429).json({ ok: false, error: 'Trop de tentatives.' });

    const body = req.body || {};
    const email = typeof body.email === 'string' ? body.email.trim().slice(0, 160) : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Email invalide.' });
    }

    const result = await db.runTransaction(async transaction => {
      const snap = await transaction.get(userRef);
      if (!snap.exists || snap.data()?.accountStatus === 'banned') throw new Error('NOT_FOUND');
      const data = snap.data() || {};
      const subscribers = Array.isArray(data.subscribers) ? data.subscribers : [];
      if (subscribers.some(item => String(item?.email || '').toLowerCase() === email.toLowerCase())) {
        return { alreadySubscribed: true, subscribers };
      }
      if (subscribers.length >= 5000) throw new Error('LIMIT');
      const updated = [...subscribers, { email, date: new Date().toISOString() }];
      transaction.update(userRef, { subscribers: updated });
      return { alreadySubscribed: false, subscribers: updated };
    });

    if (result.alreadySubscribed) return res.status(409).json({ ok: false, alreadySubscribed: true });
    return res.status(201).json({ ok: true });
  } catch (error) {
    console.error('Erreur API subscribe:', error);
    if (error.message === 'NOT_FOUND') return res.status(404).json({ ok: false, error: 'Profil introuvable.' });
    if (error.message === 'LIMIT') return res.status(409).json({ ok: false, error: 'Limite d’abonnés atteinte.' });
    return res.status(500).json({ ok: false, error: 'Impossible d’enregistrer l’abonné.' });
  }
};
