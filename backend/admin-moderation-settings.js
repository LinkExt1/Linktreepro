const { getAdminApp, handleCors, verifyAdmin } = require('./_security');
const { normalizeRules, normalizeSanction, clearModerationConfigCache } = require('./moderation-config');

module.exports = async (req, res) => {
  const c = handleCors(req, res);
  if (c) return;
  try {
    await verifyAdmin(req);
    const db = getAdminApp().firestore();
    const ref = db.collection('settings').doc('sanctions');
    const legacyRef = db.collection('admin_settings').doc('moderation');
    const aiRef = db.collection('settings').doc('ai_config');

    if (req.method === 'GET') {
      const [snap, legacySnap, aiSnap] = await Promise.all([ref.get(), legacyRef.get(), aiRef.get()]);
      const data = aiSnap.exists && Array.isArray(aiSnap.data()?.rules) ? { ...(snap.exists ? snap.data() : (legacySnap.exists ? legacySnap.data() : {})), rules: aiSnap.data().rules } : (snap.exists ? snap.data() : (legacySnap.exists ? legacySnap.data() : {}));
      res.setHeader('Cache-Control', 'private, max-age=30');
      return res.status(200).json({
        ok: true,
        config: {
          rules: normalizeRules(data.rules),
          sanction: normalizeSanction(data.sanction || data)
        }
      });
    }

    if (!['PUT', 'POST', 'PATCH'].includes(req.method)) {
      return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }

    const rules = normalizeRules(req.body?.rules);
    const requestedSanction = normalizeSanction(req.body?.sanction);
    const [existingSnap, legacySnap] = await Promise.all([ref.get(), legacyRef.get()]);
    const existing = existingSnap.exists ? existingSnap.data() || {} : (legacySnap.exists ? legacySnap.data() || {} : {});
    const existingSanction = normalizeSanction(existing.sanction || existing);
    const sanction = Object.fromEntries(Object.entries({ ...existingSanction, ...requestedSanction }).filter(([, value]) => value !== null && value !== ''));

    if (sanction.defaultStatus && !['suspended', 'banned'].includes(sanction.defaultStatus)) {
      return res.status(400).json({ ok: false, error: 'Le statut de sanction doit être suspended ou banned.' });
    }
    if (rules.some(rule => rule.enabled !== false && !rule.action)) {
      return res.status(400).json({ ok: false, error: 'Chaque règle active doit définir une action de sanction dans la configuration.' });
    }
    if (rules.some(rule => rule.enabled !== false) && !sanction.defaultStatus) {
      return res.status(400).json({ ok: false, error: 'Le statut de sanction doit être configuré avant d’activer une règle.' });
    }
    if (sanction.defaultStatus === 'suspended' && (!Number.isFinite(sanction.defaultDurationDays) || sanction.defaultDurationDays <= 0)) {
      return res.status(400).json({ ok: false, error: 'La durée de suspension par défaut doit être configurée.' });
    }
    if (sanction.minDurationDays && sanction.maxDurationDays && sanction.minDurationDays > sanction.maxDurationDays) {
      return res.status(400).json({ ok: false, error: 'La durée minimale doit être inférieure ou égale à la durée maximale.' });
    }
    if (sanction.defaultDurationDays && sanction.minDurationDays && sanction.defaultDurationDays < sanction.minDurationDays) {
      return res.status(400).json({ ok: false, error: 'La durée par défaut est inférieure au minimum configuré.' });
    }
    if (sanction.defaultDurationDays && sanction.maxDurationDays && sanction.defaultDurationDays > sanction.maxDurationDays) {
      return res.status(400).json({ ok: false, error: 'La durée par défaut dépasse le maximum configuré.' });
    }

    await ref.set({ rules, sanction, updatedAt: new Date() }, { merge: true });
    await aiRef.set({ rules, moderation: sanction, updatedAt: new Date() }, { merge: true });
    await legacyRef.set({ rules, sanction, updatedAt: new Date() }, { merge: true });
    clearModerationConfigCache();
    return res.status(200).json({ ok: true, config: { rules, sanction } });
  } catch (e) {
    if (e.message === 'ADMIN_REQUIRED') return res.status(403).json({ ok: false, error: 'Accès administrateur requis.' });
    if (e.message === 'AUTH_REQUIRED') return res.status(401).json({ ok: false, error: 'Authentification requise.' });
    console.error('admin-moderation-settings:', e && e.message ? e.message : e);
    return res.status(500).json({ ok: false, error: 'Configuration de modération impossible.' });
  }
};
