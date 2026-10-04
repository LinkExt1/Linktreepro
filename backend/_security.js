const crypto = require('crypto');

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim().slice(0, 100);
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim().slice(0, 100);
  return 'unknown';
}
function getOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.trim()) return origin.trim().replace(/\/$/, '');
  const referer = req.headers.referer;
  if (typeof referer === 'string' && referer.trim()) { try { return new URL(referer).origin; } catch (_) {} }
  return '';
}
function getAllowedOrigins(req) {
  const allowed = new Set(String(process.env.APP_ORIGIN || '').split(',').map(v => v.trim().replace(/\/$/, '')).filter(Boolean));
  const host = String(req.headers.host || '').trim().replace(/\/$/, '');
  if (host) allowed.add(`https://${host}`);
  const vu = String(process.env.VERCEL_URL || '').trim().replace(/\/$/, '');
  if (vu) allowed.add(`https://${vu}`);
  const vp = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim().replace(/\/$/, '');
  if (vp) allowed.add(`https://${vp}`);
  allowed.add('https://nkext1.github.io');
  allowed.add('https://linktreepro.vercel.app');
  return allowed;
}
function isVercelPreviewOrigin(origin) {
  try {
    const u = new URL(origin);
    // Prévisualisations Vercel : *.vercel.app
    return u.protocol === 'https:' && (u.hostname === 'vercel.app' || u.hostname.endsWith('.vercel.app'));
  } catch (_) {
    return false;
  }
}
function originAllowed(req) {
  const origin = getOrigin(req);
  if (!origin) {
    const host = String(req.headers.host || '').trim().replace(/\/$/, '');
    return !!host && getAllowedOrigins(req).has(`https://${host}`);
  }
  if (getAllowedOrigins(req).has(origin)) return true;
  if (isVercelPreviewOrigin(origin)) return true;
  return false;
}
function setCorsHeaders(req, res) {
  const origin = getOrigin(req);
  if (origin && getAllowedOrigins(req).has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}
function handleCors(req, res) {
  if (!originAllowed(req)) return false;
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}
function validUid(uid) { return typeof uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(uid); }
function hashRateKey(action, uid, ip) {
  const salt = String(process.env.RATE_LIMIT_SALT || 'linkext-rate-limit-change-me');
  return crypto.createHash('sha256').update(`${salt}:${action}:${uid}:${ip}`).digest('hex');
}
async function enforceRateLimit(db, { action, uid = 'public', ip, limit, windowSeconds }) {
  const key = hashRateKey(action, uid, ip);
  const ref = db.collection('public_rate_limits').doc(key);
  const now = Date.now(), windowMs = windowSeconds * 1000;
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const d = snap.exists ? snap.data() : {};
    const startedAt = Number(d.startedAt || 0), count = Number(d.count || 0);
    if (!startedAt || now - startedAt >= windowMs) {
      tx.set(ref, { action, uid, startedAt: now, count: 1, expiresAt: new Date(now + windowMs) });
      return { allowed: true, retryAfter: windowSeconds };
    }
    const blockedUntil = Number(d.blockedUntil || 0);
    if (blockedUntil > now) return { allowed: false, retryAfter: Math.max(1, Math.ceil((blockedUntil - now) / 1000)), blocked: true };
    if (count >= limit) {
      const lockMs = 3 * 60 * 60 * 1000;
      tx.set(ref, { action, uid, startedAt, count, blockedUntil: now + lockMs, expiresAt: new Date(now + lockMs) }, { merge: true });
      return { allowed: false, retryAfter: Math.ceil(lockMs / 1000), blocked: true };
    }
    tx.update(ref, { count: count + 1, expiresAt: new Date(startedAt + windowMs) });
    return { allowed: true, retryAfter: 0 };
  });
}

async function enforceSensitiveRateLimit(db, { action, uid = 'public', ip, bypass = false }) {
  if (bypass) return { allowed: true, retryAfter: 0, bypassed: true };
  const byIp = await enforceRateLimit(db, { action: `${action}:ip`, uid: 'public', ip, limit: 5, windowSeconds: 600 });
  if (!byIp.allowed) return byIp;
  if (uid && uid !== 'public') {
    const byUser = await enforceRateLimit(db, { action: `${action}:user`, uid, ip: 'user', limit: 5, windowSeconds: 600 });
    if (!byUser.allowed) return byUser;
  }
  return { allowed: true, retryAfter: 0 };
}

function getAdminApp() {
  const admin = require('firebase-admin');
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID, clientEmail = process.env.FIREBASE_CLIENT_EMAIL, privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!projectId || !clientEmail || !privateKey) throw new Error('FIREBASE_ADMIN_CONFIG_MISSING');
  admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) });
  return admin.app();
}
async function verifyBearerUser(req) {
  const admin = require('firebase-admin');
  const h = req.headers.authorization || '';
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) throw new Error('AUTH_REQUIRED');
  const token = h.slice(7).trim();
  if (!token) throw new Error('AUTH_REQUIRED');
  return admin.auth(getAdminApp()).verifyIdToken(token);
}
async function verifyAdmin(req) {
  const decoded = await verifyBearerUser(req);
  if (decoded.admin !== true) throw new Error('ADMIN_REQUIRED');
  return decoded;
}
async function requireActiveUser(db, uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) throw new Error('PROFILE_NOT_FOUND');
  const status = String(snap.data()?.accountStatus || 'active');
  if (status !== 'active') { if(status==='suspended') throw new Error('ACCOUNT_SUSPENDED'); if(status==='disabled') throw new Error('ACCOUNT_DISABLED'); throw new Error('ACCOUNT_BANNED'); }
  return snap;
}
module.exports = {
  getAdminApp, getClientIp, getOrigin, originAllowed, setCorsHeaders, handleCors,
  validUid, enforceRateLimit, enforceSensitiveRateLimit, verifyBearerUser, verifyAdmin, requireActiveUser
};
