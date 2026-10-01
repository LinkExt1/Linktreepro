const { getAdminApp, handleCors, verifyAdmin } = require('./_security');
const { normalizeRules } = require('./moderation-config');
const { clearAiConfigCache } = require('./ai-moderator');

const MAX_MODELS = 20;
const MAX_TEXT = 10000;
const MAX_TEMPLATE = 20000;
const MAX_PATH = 300;

function cleanModel(raw, index) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const name = String(source.name || source.modelName || '').trim().slice(0, 160);
  const envKey = String(source.envKey || '').trim().slice(0, 160);
  const endpoint = String(source.endpoint || source.url || '').trim().slice(0, 2000);
  const authHeader = String(source.authHeader || '').trim().slice(0, 160);
  const authPrefix = String(source.authPrefix || '').trim().slice(0, 80);
  const requestTemplate = String(source.requestTemplate || '').trim().slice(0, MAX_TEMPLATE);
  const responsePath = String(source.responsePath || '').trim().slice(0, MAX_PATH);
  const enabled = source.enabled !== false;
  const priority = Number.isFinite(Number(source.priority)) ? Math.max(0, Math.floor(Number(source.priority))) : index;
  const id = String(source.id || `${Date.now()}-${index}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || `${Date.now()}-${index}`;
  if (!name || !envKey || !endpoint || !requestTemplate) throw new Error('INVALID_MODEL');
  return { id, name, envKey, endpoint, authHeader, authPrefix, requestTemplate, responsePath, enabled, priority };
}

function cleanModeration(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const n = (key) => {
    const value = Number(source[key]);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  };
  return {
    defaultStatus: ['suspended', 'banned'].includes(String(source.defaultStatus || '').trim().toLowerCase()) ? String(source.defaultStatus).trim().toLowerCase() : '',
    defaultDurationDays: n('defaultDurationDays'),
    minDurationDays: n('minDurationDays'),
    maxDurationDays: n('maxDurationDays'),
    recurrenceThreshold: n('recurrenceThreshold'),
    maxAllowed: n('maxAllowed'),
    gracePeriodDays: n('gracePeriodDays'),
    cleanupDeleteAfterDays: n('cleanupDeleteAfterDays'),
    blacklistAfterDays: n('blacklistAfterDays'),
    bugLogDisplayLimit: n('bugLogDisplayLimit')
  };
}

function normalize(body) {
  const modelsInput = Array.isArray(body?.models) ? body.models : [];
  if (modelsInput.length > MAX_MODELS) throw new Error('TOO_MANY_MODELS');
  const models = modelsInput.map(cleanModel).sort((a, b) => a.priority - b.priority).map((m, i) => ({ ...m, priority: i }));
  const masterPrompt = String(body?.promptMaster ?? body?.masterPrompt ?? '').trim().slice(0, MAX_TEXT);
  const dialoguePrompt = String(body?.dialoguePrompt ?? '').trim().slice(0, MAX_TEXT);
  const unavailableBehavior = ['allow', 'manual_review'].includes(String(body?.unavailableBehavior || '').trim()) ? String(body.unavailableBehavior).trim() : '';
  const dialogueEnabled = body?.dialogueEnabled === true;
  const moderation = cleanModeration(body?.moderation);
  const rules = normalizeRules(body?.rules);
  const delayRaw = Number(body?.moderationDelaySeconds);
  const moderationDelaySeconds = Number.isFinite(delayRaw) ? Math.min(900, Math.max(0, delayRaw)) : 120;
  return { models, promptMaster: masterPrompt, masterPrompt, dialoguePrompt, unavailableBehavior, dialogueEnabled, moderation, rules, moderationDelaySeconds };
}

module.exports = async (req, res) => {
  const c = handleCors(req, res); if (c) return;
  try {
    await verifyAdmin(req);
    const db = getAdminApp().firestore();
    const ref = db.collection('settings').doc('ai_config');
    const legacyRef = db.collection('admin_settings').doc('ai_config');
    const sanctionRef = db.collection('settings').doc('sanctions');
    const legacyModerationRef = db.collection('admin_settings').doc('moderation');

    if (req.method === 'GET') {
      const [snap, legacySnap, moderationSnap, legacyModerationSnap] = await Promise.all([
        ref.get(), legacyRef.get(), sanctionRef.get(), legacyModerationRef.get()
      ]);
      const data = snap.exists ? snap.data() : (legacySnap.exists ? legacySnap.data() : {});
      const moderationData = moderationSnap.exists ? moderationSnap.data() || {} : (legacyModerationSnap.exists ? legacyModerationSnap.data() || {} : {});
      const rawModels = Array.isArray(data.models) ? data.models : [];
      let models = [];
      try { models = rawModels.map((m, i) => cleanModel(m, i)).sort((a, b) => a.priority - b.priority); } catch (_) { models = []; }
      const moderation = cleanModeration(data.moderation);
      const legacySanction = cleanModeration(moderationData.sanction || moderationData);
      const effectiveModeration = {};
      for (const key of Object.keys(legacySanction)) effectiveModeration[key] = moderation[key] != null && moderation[key] !== '' ? moderation[key] : legacySanction[key];
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({
        ok: true,
        config: {
          models,
          promptMaster: String(data.promptMaster || data.masterPrompt || ''),
          masterPrompt: String(data.promptMaster || data.masterPrompt || ''),
          dialoguePrompt: String(data.dialoguePrompt || ''),
          unavailableBehavior: ['allow', 'manual_review'].includes(String(data.unavailableBehavior || '').trim()) ? String(data.unavailableBehavior).trim() : '',
          dialogueEnabled: data.dialogueEnabled === true,
          moderation: effectiveModeration,
          rules: normalizeRules(Array.isArray(data.rules) ? data.rules : (Array.isArray(moderationData.rules) ? moderationData.rules : [])),
          moderationDelaySeconds: Number.isFinite(Number(data.moderationDelaySeconds)) ? Number(data.moderationDelaySeconds) : 120
        }
      });
    }

    if (!['PUT', 'POST', 'PATCH'].includes(req.method)) return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    const clean = normalize(req.body || {});
    const [existingSnap, legacySnap, sanctionSnap] = await Promise.all([ref.get(), legacyRef.get(), sanctionRef.get()]);
    const existing = existingSnap.exists ? existingSnap.data() || {} : (legacySnap.exists ? legacySnap.data() || {} : {});
    const existingSanction = sanctionSnap.exists ? sanctionSnap.data() || {} : {};
    const existingModeration = cleanModeration({ ...existingSanction, ...(existing.moderation || {}) });
    const mergedModeration = Object.fromEntries(Object.entries({ ...existingModeration, ...clean.moderation }).filter(([, value]) => value !== null && value !== ''));
    const aiConfigData = { ...clean, promptMaster: clean.promptMaster || clean.masterPrompt || '' };
    delete aiConfigData.masterPrompt;
    await ref.set({ ...aiConfigData, updatedAt: new Date() }, { merge: true });
    await sanctionRef.set({ ...mergedModeration, updatedAt: new Date() }, { merge: true });
    // Conservation de l'ancien emplacement pour éviter une régression pendant la transition.
    await legacyRef.set({ ...aiConfigData, moderation: mergedModeration, updatedAt: new Date() }, { merge: true });
    clearAiConfigCache();
    return res.status(200).json({ ok: true, config: { ...aiConfigData, moderation: mergedModeration } });
  } catch (e) {
    if (e.message === 'ADMIN_REQUIRED') return res.status(403).json({ ok: false, error: 'Accès administrateur requis.' });
    if (e.message === 'AUTH_REQUIRED') return res.status(401).json({ ok: false, error: 'Authentification requise.' });
    if (e.message === 'INVALID_MODEL') return res.status(400).json({ ok: false, error: 'Chaque configuration IA active doit définir son nom, sa variable d’accès, son endpoint et son template JSON de requête.' });
    if (e.message === 'TOO_MANY_MODELS') return res.status(400).json({ ok: false, error: 'Trop de configurations IA.' });
    console.error('ai-config:', e);
    return res.status(500).json({ ok: false, error: 'Impossible de gérer la configuration IA.' });
  }
};
