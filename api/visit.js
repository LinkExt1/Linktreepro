const admin = require('firebase-admin');
const {
  getAdminApp,
  getClientIp,
  originAllowed,
  handleCors,
  validUid,
  enforceRateLimit
} = require('./_security');

function getBeninParts(date = new Date()) {
  return {
    dateStr: new Intl.DateTimeFormat('fr-CA', {
      timeZone: 'Africa/Porto-Novo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date),
    hourStr: new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Africa/Porto-Novo', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date),
    monthStr: new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Porto-Novo', year: 'numeric', month: '2-digit'
    }).format(date).slice(0, 7)
  };
}

module.exports = async (req, res) => {
  const corsHandled = handleCors(req, res);
  if (corsHandled) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }
  if (!originAllowed(req)) return res.status(403).json({ ok: false, error: 'Origine refusée.' });

  const rawId = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
  const uid = typeof rawId === 'string' ? rawId.trim() : '';
  if (!validUid(uid)) return res.status(400).json({ ok: false, error: 'ID utilisateur invalide.' });

  try {
    const app = getAdminApp();
    const db = app.firestore();
    const userRef = db.collection('users').doc(uid);
    const snap = await userRef.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: 'Profil introuvable.' });
    const user = snap.data() || {};
    if (user.accountStatus === 'banned') return res.status(204).end();

    const rate = await enforceRateLimit(db, {
      action: 'visit', uid, ip: getClientIp(req), limit: 60, windowSeconds: 60
    });
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfter));
      return res.status(429).json({ ok: false, error: 'Trop de visites depuis cette origine.' });
    }

    const countryHeader = req.headers['x-vercel-ip-country'];
    const country = String(Array.isArray(countryHeader) ? countryHeader[0] : (countryHeader || 'XX'))
      .trim().toUpperCase().slice(0, 2) || 'XX';
    const now = new Date();
    const { dateStr, hourStr, monthStr } = getBeninParts(now);

    const result = await db.runTransaction(async transaction => {
      const currentSnap = await transaction.get(userRef);
      if (!currentSnap.exists) throw new Error('NOT_FOUND');
      const current = currentSnap.data() || {};
      if (current.accountStatus === 'banned') throw new Error('BANNED');

      const currentTotal = Number(current.totalViews || current.views || 0);
      const currentViews = Number(current.views || 0);
      const storedMonth = String(current.monthly_views_reset || '');
      const currentMonthTotal = storedMonth === monthStr ? Number(current.total_views_month || 0) : 0;
      const nextMonthly = currentMonthTotal + 1;
      const updates = {
        totalViews: currentTotal + 1,
        views: currentViews + 1,
        total_views_month: nextMonthly,
        monthly_views_reset: monthStr
      };
      if (nextMonthly >= 100 && current.verified !== true) updates.verified = true;

      if (current.visitorAnalyticsEnabled !== false) {
        const visitorRef = userRef.collection('visitor_logs').doc();
        transaction.set(visitorRef, {
          country,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          dateStr,
          hourStr
        });
      }
      transaction.update(userRef, updates);
      return updates.totalViews;
    });

    return res.status(201).json({ ok: true, totalViews: result });
  } catch (error) {
    console.error('Erreur API visitor_logs:', error);
    return res.status(500).json({ ok: false, error: 'Impossible d’enregistrer la visite.' });
  }
};
