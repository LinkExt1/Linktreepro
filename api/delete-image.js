const cloudinary = require('cloudinary').v2;
const {
  getAdminApp,
  getClientIp,
  handleCors,
  validUid,
  verifyBearerUser,
  enforceRateLimit
} = require('./_security');

function cleanPublicId(value) {
  return String(value || '').trim().replace(/^\/+|\/+$/g, '');
}

module.exports = async (req, res) => {
  const corsHandled = handleCors(req, res);
  if (corsHandled) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    const decoded = await verifyBearerUser(req);
    const uid = decoded.uid;
    if (!validUid(uid)) return res.status(401).json({ ok: false, error: 'Utilisateur invalide.' });

    const app = getAdminApp();
    const db = app.firestore();
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists || userSnap.data()?.accountStatus === 'banned') {
      return res.status(403).json({ ok: false, error: 'Compte non autorisé.' });
    }

    const rate = await enforceRateLimit(db, {
      action: 'delete-image', uid, ip: getClientIp(req), limit: 30, windowSeconds: 60
    });
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfter));
      return res.status(429).json({ ok: false, error: 'Trop de suppressions. Réessayez plus tard.' });
    }

    const body = req.body || {};
    const publicId = cleanPublicId(body.public_id);
    if (!publicId || publicId.length > 400) {
      return res.status(400).json({ ok: false, error: 'public_id invalide.' });
    }

    const expectedPrefix = `linkext/${uid}/`;
    if (!publicId.startsWith(expectedPrefix)) {
      return res.status(403).json({ ok: false, error: 'Image non autorisée.' });
    }

    const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
    const apiKey = String(process.env.CLOUDINARY_API_KEY || '').trim();
    const apiSecret = String(process.env.CLOUDINARY_API_SECRET || '').trim();
    if (!cloudName || !apiKey || !apiSecret) {
      console.error('Cloudinary suppression : variables serveur manquantes.');
      return res.status(500).json({ ok: false, error: 'Configuration Cloudinary serveur incomplète.' });
    }

    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
    const deleted = result?.result === 'ok' || result?.result === 'not found';
    if (!deleted) {
      console.error('Cloudinary destroy inattendu:', result);
      return res.status(502).json({ ok: false, error: 'Cloudinary n’a pas confirmé la suppression.' });
    }
    return res.status(200).json({ ok: true, result: result.result });
  } catch (error) {
    if (error.message === 'AUTH_REQUIRED') {
      return res.status(401).json({ ok: false, error: 'Authentification requise.' });
    }
    console.error('Erreur API suppression Cloudinary:', error);
    return res.status(500).json({ ok: false, error: 'Impossible de supprimer l’image.' });
  }
};
