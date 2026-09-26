const crypto = require('crypto');

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().slice(0, 100);
  }
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim().slice(0, 100);
  return 'unknown';
}

function getOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.trim()) return origin.trim().replace(/\/$/, '');
  const referer = req.headers.referer;
  if (typeof referer === 'string' && referer.trim()) {
    try { return new URL(referer).origin; } catch (_) {}
  }
  return '';
}

function getAllowedOrigins(req) {
  const allowed = new Set();
  const configured = String(process.env.APP_ORIGIN || '')
    .split(',')
    .map(value => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
  configured.forEach(origin => allowed.add(origin));

  const host = String(req.headers.host || '').trim().replace(/\/$/, '');
  if (host) allowed.add(`https://${host}`);

  const vercelUrl = String(process.env.VERCEL_URL || '').trim().replace(/\/$/, '');
  if (vercelUrl) allowed.add(`https://${vercelUrl}`);

  const productionUrl = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim().replace(/\/$/, '');
  if (productionUrl) allowed.add(`https://${productionUrl}`);

  // Compatibilité avec le domaine GitHub Pages actuellement utilisé par LinkExt.
  allowed.add('https://nkext1.github.io');
  return allowed;
}

function originAllowed(req) {
  const origin = getOrigin(req);
  if (!origin) {
    // Les requêtes same-origin peuvent ne pas contenir Origin/Referer.
    const host = String(req.headers.host || '').trim().replace(/\/$/, '');
    if (!host) return false;
    return getAllowedOrigins(req).has(`https://${host}`);
  }
  return getAllowedOrigins(req).has(origin);
}

function setCorsHeaders(req, res) {
  const origin = getOrigin(req);
  if (origin && getAllowedOrigins(req).has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

function handleCors(req, res) {
  if (!originAllowed(req)) return false;
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

function validUid(uid) {
  return typeof uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(uid);
}

function hashRateKey(action, uid, ip) {
  const salt = String(process.env.RATE_LIMIT_SALT || 'linkext-rate-limit-change-me');
  return crypto.createHash('sha256').update(`${salt}:${action}:${uid}:${ip}`).digest('hex');
}

async function enforceRateLimit(db, { action, uid, ip, limit, windowSeconds }) {
  const key = hashRateKey(action, uid, ip);
  const ref = db.collection('public_rate_limits').doc(key);
  const now = Date.now();
  const windowMs = windowSeconds * 1000;

  const result = await db.runTransaction(async transaction => {
    const snap = await transaction.get(ref);
    const existing = snap.exists ? snap.data() : {};
    const startedAt = Number(existing.startedAt || 0);
    const count = Number(existing.count || 0);

    if (!startedAt || now - startedAt >= windowMs) {
      transaction.set(ref, {
        action,
        uid,
        startedAt: now,
        count: 1,
        expiresAt: new Date(now + windowMs)
      });
      return { allowed: true, retryAfter: windowSeconds };
    }

    if (count >= limit) {
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((windowMs - (now - startedAt)) / 1000))
      };
    }

    transaction.update(ref, {
      count: count + 1,
      expiresAt: new Date(startedAt + windowMs)
    });
    return { allowed: true, retryAfter: 0 };
  });

  return result;
}

function getAdminApp() {
  const admin = require('firebase-admin');
  if (admin.apps.length) return admin.app();

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Variables Firebase Admin manquantes: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, '\n')
    })
  });

  return admin.app();
}

async function verifyBearerUser(req) {
  const admin = require('firebase-admin');
  const authHeader = req.headers.authorization || '';
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    throw new Error('AUTH_REQUIRED');
  }
  const token = authHeader.slice(7).trim();
  if (!token) throw new Error('AUTH_REQUIRED');
  const app = getAdminApp();
  return admin.auth(app).verifyIdToken(token);
}

module.exports = {
  getAdminApp,
  getClientIp,
  getOrigin,
  originAllowed,
  setCorsHeaders,
  handleCors,
  validUid,
  enforceRateLimit,
  verifyBearerUser
};
