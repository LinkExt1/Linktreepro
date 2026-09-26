const { getAdminApp, originAllowed, validUid } = require('./_security');

const PUBLIC_FIELDS = [
  'displayName', 'bio', 'photoURL', 'accountStatus', 'maintenance',
  'integrations', 'visitorAnalyticsEnabled', 'likesEnabled', 'likes',
  'leadCaptureEnabled', 'verified', 'status', 'flash', 'links',
  'redirectUnique', 'redirect_message', 'featuredLink', 'testimonials',
  'seo', 'theme', 'visualTheme', 'primaryColor', 'themePrimaryColor',
  'backgroundImage', 'themeBackgroundImage', 'catalogEnabled', 'products'
];

function pickPublicProfile(data) {
  const result = {};
  for (const key of PUBLIC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(data, key)) result[key] = data[key];
  }

  // Le numéro privé n'est jamais retourné sauf lorsqu'un catalogue WhatsApp
  // actif en a réellement besoin sur la page publique.
  if (result.catalogEnabled === true && Array.isArray(result.products) && result.products.length) {
    const raw = typeof data.phoneNumber === 'string' ? data.phoneNumber : '';
    const normalized = raw.replace(/[^0-9]/g, '');
    if (normalized.length >= 7 && normalized.length <= 15) result.publicWhatsAppNumber = normalized;
  }

  return result;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }
  if (!originAllowed(req)) return res.status(403).json({ ok: false, error: 'Origine refusée.' });

  const rawId = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
  const uid = typeof rawId === 'string' ? rawId.trim() : '';
  if (!validUid(uid)) return res.status(400).json({ ok: false, error: 'ID utilisateur invalide.' });

  try {
    const app = getAdminApp();
    const snap = await app.firestore().collection('users').doc(uid).get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: 'Profil introuvable.' });
    const data = snap.data() || {};

    if (data.accountStatus === 'banned') {
      return res.status(404).json({ ok: false, error: 'Profil introuvable ou compte suspendu.' });
    }

    const profile = pickPublicProfile(data);
    if (String(req.query?.contact || '') === '1') {
      const rawPhone = typeof data.phoneNumber === 'string' ? data.phoneNumber : '';
      profile.publicPhoneNumber = rawPhone.slice(0, 40);
    }
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ ok: true, profile });
  } catch (error) {
    console.error('Erreur API public profile:', error);
    return res.status(500).json({ ok: false, error: 'Impossible de charger le profil.' });
  }
};
