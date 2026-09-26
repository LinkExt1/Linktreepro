const admin = require('firebase-admin');

function getAdminApp() {
  if (admin.apps.length) return admin.app();

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Variables Firebase Admin manquantes: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY'
    );
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

function validUid(uid) {
  return typeof uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(uid);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const rawId = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
  const uid = typeof rawId === 'string' ? rawId.trim() : '';

  if (!validUid(uid)) {
    return res.status(400).json({ ok: false, error: 'ID utilisateur invalide.' });
  }

  try {
    const app = getAdminApp();
    const db = app.firestore();
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({ ok: false, error: 'Profil introuvable.' });
    }

    const user = userSnap.data() || {};
    if (user.accountStatus === 'banned' || user.visitorAnalyticsEnabled === false) {
      return res.status(204).end();
    }

    const countryHeader = req.headers['x-vercel-ip-country'];
    const country = String(Array.isArray(countryHeader) ? countryHeader[0] : (countryHeader || 'XX'))
      .trim()
      .toUpperCase()
      .slice(0, 2) || 'XX';

    const now = new Date();
    const dateStr = new Intl.DateTimeFormat('fr-CA', {
      timeZone: 'Africa/Porto-Novo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(now);
    const hourStr = new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Africa/Porto-Novo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(now);

    await userRef.collection('visitor_logs').add({
      country,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      dateStr,
      hourStr
    });

    return res.status(201).json({ ok: true });
  } catch (error) {
    console.error('Erreur API visitor_logs:', error);
    return res.status(500).json({ ok: false, error: 'Impossible d\'enregistrer la visite.' });
  }
};
