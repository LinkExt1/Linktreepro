const { getAdminApp, originAllowed, handleCors, validUid } = require('./_security');

const PUBLIC_FIELDS = [
  'displayName', 'username', 'bio', 'photoURL', 'accountStatus', 'maintenance',
  'integrations', 'visitorAnalyticsEnabled', 'likesEnabled', 'likes', 'displayedViews', 'publicViews',
  'leadCaptureEnabled', 'verified', 'status', 'flash', 'links',
  'redirectUnique', 'redirect_message', 'featuredLink', 'testimonials',
  'seo', 'theme', 'visualTheme', 'primaryColor', 'themePrimaryColor',
  'backgroundImage', 'themeBackgroundImage', 'catalogEnabled', 'products', 'donationMethods'
];

function stripPrivateMediaMetadata(value) {
  if (Array.isArray(value)) return value.map(stripPrivateMediaMetadata);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'imagePublicId' || key === 'photoPublicId' || key === 'public_id') continue;
    output[key] = stripPrivateMediaMetadata(item);
  }
  return output;
}

function pickPublicProfile(data) {
  const result = {};
  for (const key of PUBLIC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(data, key)) result[key] = stripPrivateMediaMetadata(data[key]);
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
  const corsHandled = handleCors(req, res);
  if (corsHandled) return;
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
    const db = app.firestore();
    let snap = await db.collection('users').doc(uid).get();

    // Les URLs /username et /p/uid utilisent le même endpoint public.
    // Si l'identifiant n'est pas un document UID, on résout le nom d'utilisateur
    // sans exposer le document Firestore au navigateur.
    if (!snap.exists) {
      const username = String(uid).trim();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) {
        return res.status(404).json({ ok: false, error: 'Profil introuvable.' });
      }
      const byUsername = await db.collection('users')
        .where('username', '==', username)
        .limit(1)
        .get();
      if (byUsername.empty) return res.status(404).json({ ok: false, error: 'Profil introuvable.' });
      snap = byUsername.docs[0];
    }

    const data = snap.data() || {};
    const normalizedStatus = String(data.accountStatus || data.status || 'active').trim().toLowerCase();

    if (['banned', 'suspended', 'disabled', 'correction_pending', 'pending_review'].includes(normalizedStatus)) {
      return res.status(404).json({ ok: false, error: 'Profil introuvable ou compte suspendu.' });
    }

    const profile = pickPublicProfile(data);
    if (String(req.query?.contact || '') === '1') {
      res.setHeader('Cache-Control', 'private, no-store');
      const rawPublicPhone = typeof data.publicPhoneNumber === 'string' ? data.publicPhoneNumber : '';
      if (rawPublicPhone) profile.publicPhoneNumber = rawPublicPhone.slice(0, 40);
    }
    if (String(req.query?.contact || '') !== '1') res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ ok: true, profile });
  } catch (error) {
    console.error('Erreur API public profile:', error);
    return res.status(500).json({ ok: false, error: 'Impossible de charger le profil.' });
  }
};
