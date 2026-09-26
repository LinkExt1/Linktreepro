const admin = require('firebase-admin');
const {
  getAdminApp,
  getClientIp,
  originAllowed,
  validUid,
  enforceRateLimit
} = require('./_security');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }
  if (!originAllowed(req)) return res.status(403).json({ ok: false, error: 'Origine refusée.' });

  const rawId = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
  const rawLinkId = Array.isArray(req.query?.link) ? req.query.link[0] : req.query?.link;
  const uid = typeof rawId === 'string' ? rawId.trim() : '';
  const linkId = typeof rawLinkId === 'string' ? rawLinkId.trim() : '';

  if (!validUid(uid) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(linkId)) {
    return res.status(400).json({ ok: false, error: 'Paramètres invalides.' });
  }

  try {
    const app = getAdminApp();
    const db = app.firestore();
    const userRef = db.collection('users').doc(uid);
    const rate = await enforceRateLimit(db, {
      action: 'click', uid, ip: getClientIp(req), limit: 30, windowSeconds: 60
    });
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfter));
      return res.status(429).json({ ok: false, error: 'Trop de clics.' });
    }

    const result = await db.runTransaction(async transaction => {
      const snap = await transaction.get(userRef);
      if (!snap.exists) throw new Error('NOT_FOUND');
      const data = snap.data() || {};
      if (data.accountStatus === 'banned') throw new Error('NOT_FOUND');
      const links = Array.isArray(data.links) ? data.links.map(link => ({ ...link })) : [];
      const index = links.findIndex(link => link && link.id === linkId);
      if (index < 0) throw new Error('LINK_NOT_FOUND');
      links[index].clicks = Number(links[index].clicks || 0) + 1;
      transaction.update(userRef, { links });
      return links[index].clicks;
    });

    return res.status(200).json({ ok: true, clicks: result });
  } catch (error) {
    console.error('Erreur API click:', error);
    if (error.message === 'NOT_FOUND' || error.message === 'LINK_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'Lien introuvable.' });
    }
    return res.status(500).json({ ok: false, error: 'Impossible d’enregistrer le clic.' });
  }
};
