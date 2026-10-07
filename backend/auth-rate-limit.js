const crypto = require('crypto');
const { getAdminApp, getClientIp, handleCors, originAllowed } = require('./_security');

function hashKey(value) {
  const salt = String(process.env.RATE_LIMIT_SALT || 'linkext-auth-rate-limit-change-me');
  return crypto.createHash('sha256').update(`${salt}:${value}`).digest('hex');
}

function normalizeIdentifier(value) {
  return String(value || '').trim().toLowerCase().slice(0, 128);
}

module.exports = async (req, res) => {
  const corsHandled = handleCors(req, res);
  if (corsHandled) return;

  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  if (!originAllowed(req)) {
    return res.status(403).json({ ok: false, error: 'Origine refusée.' });
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = String(body.action || '').trim().toLowerCase();
    const identifier = normalizeIdentifier(body.identifier);
    const phase = String(body.phase || 'check').trim().toLowerCase();

    if (
      action !== 'login' ||
      !identifier ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier) ||
      !['check', 'failure', 'success'].includes(phase)
    ) {
      return res.status(400).json({ ok: false, error: 'Requête invalide.' });
    }

    const db = getAdminApp().firestore();
    const ip = getClientIp(req);

    // Important : la clé combine le compte ET l'IP.
    // Une personne malveillante ne peut donc plus bloquer à distance
    // le compte d'une victime uniquement en connaissant son adresse email.
    const accountIpKey = hashKey(`account-ip:${identifier}:${ip}`);
    const ipKey = hashKey(`ip:${ip}`);

    const refs = [
      db.collection('auth_login_failures').doc(accountIpKey),
      db.collection('auth_login_failures').doc(ipKey)
    ];

    const now = Date.now();
    const lockMs = 3 * 60 * 60 * 1000;
    const threshold = 5;

    if (phase === 'success') {
      await db.runTransaction(async tx => {
        for (const ref of refs) {
          tx.set(ref, {
            failures: 0,
            blockedUntil: 0,
            updatedAt: new Date(now)
          }, { merge: true });
        }
      });
      return res.status(200).json({ ok: true, reset: true });
    }

    if (phase === 'check') {
      const snaps = await Promise.all(refs.map(ref => ref.get()));
      const blocked = snaps
        .map(s => Number(s.exists ? s.data()?.blockedUntil || 0 : 0))
        .find(v => v > now) || 0;

      if (blocked > now) {
        return res.status(429).json({
          ok: false,
          error: 'Trop de tentatives. Pour des raisons de sécurité, veuillez réessayer dans 3 heures.',
          retryAfter: Math.ceil((blocked - now) / 1000)
        });
      }

      return res.status(200).json({ ok: true });
    }

    const result = await db.runTransaction(async tx => {
      let maxFailures = 0;
      let blockedUntil = 0;

      for (const ref of refs) {
        const snap = await tx.get(ref);
        const data = snap.exists ? (snap.data() || {}) : {};
        const failures = Number(data.failures || 0);
        blockedUntil = Math.max(blockedUntil, Number(data.blockedUntil || 0));
        maxFailures = Math.max(maxFailures, failures);
      }

      const next = maxFailures + 1;
      const shouldBlock = next >= threshold;
      const until = shouldBlock ? now + lockMs : 0;

      for (const ref of refs) {
        tx.set(ref, {
          failures: next,
          blockedUntil: until,
          updatedAt: new Date(now)
        }, { merge: true });
      }

      return { failures: next, blockedUntil: until };
    });

    if (result.blockedUntil > now) {
      return res.status(429).json({
        ok: false,
        error: 'Trop de tentatives. Pour des raisons de sécurité, veuillez réessayer dans 3 heures.',
        retryAfter: Math.ceil((result.blockedUntil - now) / 1000)
      });
    }

    return res.status(200).json({
      ok: true,
      failures: result.failures
    });
  } catch (error) {
    // Ne jamais retourner error.message : il pourrait révéler la configuration
    // Firebase ou une information interne au serveur.
    console.error('auth-rate-limit error:', error?.message || error);
    return res.status(500).json({
      ok: false,
      error: 'Service de sécurité temporairement indisponible.'
    });
  }
};
