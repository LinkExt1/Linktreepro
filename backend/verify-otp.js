const crypto = require('crypto');
const { getAdminApp, handleCors, verifyBearerUser } = require('./_security');

function hash(v) {
  return crypto.createHash('sha256').update(`${process.env.RATE_LIMIT_SALT || 'linkext'}:${v}`).digest('hex');
}

module.exports = async (req, res) => {
  const c = handleCors(req, res);
  if (c) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  try {
    const decoded = await verifyBearerUser(req);
    const challenge = String(req.body?.challenge || '');
    const code = String(req.body?.code || '').trim().toUpperCase();

    // Code OTP : 5 caractères alphanumériques (A-Z0-9)
    if (!/^[A-Z0-9]{5}$/.test(code) || !challenge) {
      return res.status(400).json({ ok: false, error: 'Code OTP invalide. Entrez les 5 caractères reçus par e-mail.' });
    }

    const db = getAdminApp().firestore();
    const ref = db.collection('otp_challenges').doc(challenge);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(400).json({ ok: false, error: 'Code expiré ou invalide.' });
    }

    const d = snap.data() || {};
    if (d.uid !== decoded.uid || d.email !== String(decoded.email || '').toLowerCase()) {
      return res.status(403).json({ ok: false, error: 'Vérification refusée.' });
    }

    const expires = d.expiresAt?.toDate ? d.expiresAt.toDate() : new Date(d.expiresAt);
    if (expires.getTime() < Date.now()) {
      return res.status(400).json({ ok: false, error: 'Code expiré. Demandez un nouveau code.' });
    }
    if (Number(d.attempts || 0) >= 5) {
      return res.status(429).json({ ok: false, error: 'Nombre maximal de tentatives atteint.' });
    }

    if (hash(code) !== d.codeHash) {
      await ref.update({ attempts: Number(d.attempts || 0) + 1 });
      try {
        await db.collection('otp_requests').doc(d.email).update({ attempts: Number(d.attempts || 0) + 1 });
      } catch (_) {}
      return res.status(400).json({ ok: false, error: 'Code incorrect.' });
    }

    await ref.delete();
    try {
      await db.collection('otp_requests').doc(d.email).delete();
    } catch (_) {}

    await db.collection('appeal_verifications').doc(decoded.uid).set({
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      email: String(decoded.email || '').toLowerCase()
    });

    return res.status(200).json({ ok: true, verified: true });
  } catch (e) {
    if (e.message === 'AUTH_REQUIRED') return res.status(401).json({ ok: false, error: 'Authentification requise.' });
    console.error('verify-otp:', e);
    return res.status(500).json({ ok: false, error: 'Vérification impossible.' });
  }
};
