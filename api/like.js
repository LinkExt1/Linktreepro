const admin = require('firebase-admin');
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

  if (!originAllowed(req)) {
    return res.status(403).json({ ok: false, error: 'Origine refusée.' });
  }

  const rawId = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
  const uid = typeof rawId === 'string' ? rawId.trim() : '';
  if (!validUid(uid)) return res.status(400).json({ ok: false, error: 'ID utilisateur invalide.' });

  try {
    const app = getAdminApp();
    const db = app.firestore();
    const userRef = db.collection('users').doc(uid);

    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ ok: false, error: 'Profil introuvable.' });
    const user = userSnap.data() || {};

    if (user.accountStatus === 'banned') {
      return res.status(404).json({ ok: false, error: 'Profil introuvable.' });
    }
    if (user.likesEnabled === false) {
      return res.status(409).json({ ok: false, error: 'Les J’aime sont désactivés.' });
    }

    const rate = await enforceRateLimit(db, {
      action: 'like',
      uid,
      ip: getClientIp(req),
      limit: 5,
      windowSeconds: 60
    });

    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfter));
      return res.status(429).json({ ok: false, error: 'Trop de tentatives. Réessayez plus tard.' });
    }

    const updated = await db.runTransaction(async transaction => {
      const snap = await transaction.get(userRef);
      if (!snap.exists) throw new Error('PROFILE_NOT_FOUND');
      const data = snap.data() || {};
      if (data.accountStatus === 'banned' || data.likesEnabled === false) throw new Error('LIKE_DISABLED');

      const currentLikes = Number(data.likes || 0);
      const nextLikes = currentLikes + 1;
      transaction.update(userRef, { likes: nextLikes });
      return nextLikes;
    });

    return res.status(200).json({ ok: true, likes: updated });
  } catch (error) {
    console.error('Erreur API like:', error);
    if (error.message === 'PROFILE_NOT_FOUND' || error.message === 'LIKE_DISABLED') {
      return res.status(409).json({ ok: false, error: 'J’aime indisponible.' });
    }
    return res.status(500).json({ ok: false, error: 'Impossible d’enregistrer le J’aime.' });
  }
};
