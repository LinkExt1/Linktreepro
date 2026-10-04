const crypto = require('crypto');
const { getAdminApp, getClientIp, handleCors } = require('./_security');

function hashKey(value) {
  const salt = String(process.env.RATE_LIMIT_SALT || 'linkext-auth-rate-limit-change-me');
  return crypto.createHash('sha256').update(`${salt}:${value}`).digest('hex');
}

module.exports = async (req, res) => {
  const c = handleCors(req, res); if (c) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  try {
    const body = req.body || {};
    const action = String(body.action || '').trim().toLowerCase();
    const identifier = String(body.identifier || '').trim().toLowerCase();
    const phase = String(body.phase || 'check').trim().toLowerCase();
    if (action !== 'login' || !identifier || !['check','failure','success'].includes(phase)) {
      return res.status(400).json({ ok: false, error: 'Requête invalide.' });
    }
    const db = getAdminApp().firestore();
    const ip = getClientIp(req);
    const accountKey = hashKey(`account:${identifier.slice(0,128)}`);
    const ipKey = hashKey(`ip:${ip}`);
    const refs = [db.collection('auth_login_failures').doc(accountKey), db.collection('auth_login_failures').doc(ipKey)];
    const now = Date.now();
    const lockMs = 3 * 60 * 60 * 1000;
    const threshold = 5;
    if (phase === 'success') {
      await db.runTransaction(async tx => {
        for (const ref of refs) tx.set(ref, { failures: 0, blockedUntil: 0, updatedAt: new Date(now) }, { merge: true });
      });
      return res.status(200).json({ ok: true, reset: true });
    }
    if (phase === 'check') {
      const snaps = await Promise.all(refs.map(ref => ref.get()));
      const blocked = snaps.map(s => Number(s.exists ? s.data()?.blockedUntil || 0 : 0)).find(v => v > now) || 0;
      if (blocked > now) return res.status(429).json({ ok: false, error: 'Trop de tentatives. Pour des raisons de sécurité, veuillez réessayer dans 3 heures.', retryAfter: Math.ceil((blocked-now)/1000) });
      return res.status(200).json({ ok: true });
    }
    const result = await db.runTransaction(async tx => {
      let maxFailures = 0, blockedUntil = 0;
      for (const ref of refs) {
        const snap = await tx.get(ref);
        const d = snap.exists ? (snap.data() || {}) : {};
        const failures = Number(d.failures || 0);
        blockedUntil = Math.max(blockedUntil, Number(d.blockedUntil || 0));
        maxFailures = Math.max(maxFailures, failures);
      }
      const next = maxFailures + 1;
      const shouldBlock = next >= threshold;
      const until = shouldBlock ? now + lockMs : 0;
      for (const ref of refs) tx.set(ref, { failures: next, blockedUntil: until, updatedAt: new Date(now) }, { merge: true });
      return { failures: next, blockedUntil: until };
    });
    if (result.blockedUntil > now) return res.status(429).json({ ok: false, error: 'Trop de tentatives. Pour des raisons de sécurité, veuillez réessayer dans 3 heures.', retryAfter: Math.ceil((result.blockedUntil-now)/1000) });
    return res.status(200).json({ ok: true, failures: result.failures });
  } catch (e) {
    console.error('auth-rate-limit:', e);
    return res.status(500).json({ ok: false, error: 'Service de sécurité temporairement indisponible.' });
  }
};
