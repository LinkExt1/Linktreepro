const cloudinary = require('cloudinary').v2;
const {
  getAdminApp,
  originAllowed,
  handleCors,
  verifyBearerUser,
  validUid
} = require('./_security');

module.exports = async (req, res) => {
  const corsHandled = handleCors(req, res);
  if (corsHandled) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }
  if (!originAllowed(req)) return res.status(403).json({ ok: false, error: 'Origine refusée.' });

  try {
    const decoded = await verifyBearerUser(req);
    const uid = decoded.uid;
    if (!validUid(uid)) return res.status(401).json({ ok: false, error: 'Utilisateur invalide.' });

    const app = getAdminApp();
    const userSnap = await app.firestore().collection('users').doc(uid).get();
    if (!userSnap.exists || userSnap.data()?.accountStatus === 'banned') {
      return res.status(403).json({ ok: false, error: 'Compte non autorisé.' });
    }

    const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
    const apiKey = String(process.env.CLOUDINARY_API_KEY || '').trim();
    const apiSecret = String(process.env.CLOUDINARY_API_SECRET || '').trim();
    if (!cloudName || !apiKey || !apiSecret) {
      console.error('Cloudinary : variables CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET manquantes.');
      return res.status(500).json({ ok: false, error: 'Configuration Cloudinary serveur incomplète.' });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `linkext/${uid}`;
    const allowedFormats = 'jpg,jpeg,png,webp,gif';

    // Cloudinary recommande de générer la signature via son SDK afin de garantir
    // exactement la même canonisation des paramètres que l'API Upload.
    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      signature_algorithm: 'sha256'
    });

    const paramsToSign = {
      allowed_formats: allowedFormats,
      folder,
      timestamp
    };
    const signature = cloudinary.utils.api_sign_request(paramsToSign, apiSecret);


    return res.status(200).json({
      ok: true,
      cloudName,
      apiKey,
      timestamp,
      folder,
      allowedFormats,
      signature
    });
  } catch (error) {
    if (error.message === 'AUTH_REQUIRED') {
      return res.status(401).json({ ok: false, error: 'Authentification requise.' });
    }
    console.error('Erreur API Cloudinary signature:', error);
    return res.status(500).json({ ok: false, error: 'Impossible de préparer l’importation.' });
  }
};
