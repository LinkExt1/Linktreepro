const { getAdminApp } = require('./_security');

const CACHE_MS = 30000;
let cache = { at: 0, data: null };

function cleanRule(raw, index = 0) {
  const x = raw && typeof raw === 'object' ? raw : {};
  const pattern = String(x.pattern || '').trim().slice(0, 2000);
  const flags = String(x.flags || '').trim().slice(0, 20).replace(/[^dgimsuvy]/g, '');
  const reason = String(x.reason || '').trim().slice(0, 500);
  const action = String(x.action || '').trim().toUpperCase().slice(0, 80);
  const id = String(x.id || `rule-${index + 1}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || `rule-${index + 1}`;
  return { id, pattern, flags, reason, action, enabled: x.enabled !== false };
}

function normalizeRules(value) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanRule).filter(rule => rule.pattern);
}

function normalizeSanction(value) {
  const x = value && typeof value === 'object' ? value : {};
  const numberOrNull = (key, allowZero = false) => {
    const n = Number(x[key]);
    return Number.isFinite(n) && (allowZero ? n >= 0 : n > 0) ? n : null;
  };
  return {
    defaultStatus: String(x.defaultStatus || '').trim().slice(0, 40).toLowerCase(),
    defaultDurationDays: numberOrNull('defaultDurationDays'),
    minDurationDays: numberOrNull('minDurationDays', true),
    maxDurationDays: numberOrNull('maxDurationDays', true),
    cleanupDeleteAfterDays: numberOrNull('cleanupDeleteAfterDays'),
    blacklistAfterDays: numberOrNull('blacklistAfterDays'),
    recurrenceThreshold: numberOrNull('recurrenceThreshold', true),
    maxAllowed: numberOrNull('maxAllowed', true),
    gracePeriodDays: numberOrNull('gracePeriodDays', true),
    bugLogDisplayLimit: numberOrNull('bugLogDisplayLimit')
  };
}

function mergeSanctions(primary, secondary) {
  const a = normalizeSanction(primary);
  const b = normalizeSanction(secondary);
  return {
    defaultStatus: a.defaultStatus || b.defaultStatus,
    defaultDurationDays: a.defaultDurationDays ?? b.defaultDurationDays,
    minDurationDays: a.minDurationDays ?? b.minDurationDays,
    maxDurationDays: a.maxDurationDays ?? b.maxDurationDays,
    cleanupDeleteAfterDays: a.cleanupDeleteAfterDays ?? b.cleanupDeleteDays,
    blacklistAfterDays: a.blacklistAfterDays ?? b.blacklistAfterDays,
    recurrenceThreshold: a.recurrenceThreshold ?? b.recurrenceThreshold,
    maxAllowed: a.maxAllowed ?? b.maxAllowed,
    gracePeriodDays: a.gracePeriodDays ?? b.gracePeriodDays,
    bugLogDisplayLimit: a.bugLogDisplayLimit ?? b.bugLogDisplayLimit
  };
}

async function getModerationConfig(force = false) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_MS) return cache.data;
  const db = getAdminApp().firestore();
  const [aiSnap, legacyAiSnap, sanctionSnap, legacySanctionSnap] = await Promise.all([
    db.collection('settings').doc('ai_config').get(),
    db.collection('admin_settings').doc('ai_config').get(),
    db.collection('settings').doc('sanctions').get(),
    db.collection('admin_settings').doc('moderation').get()
  ]);
  const aiData = aiSnap.exists ? (aiSnap.data() || {}) : (legacyAiSnap.exists ? (legacyAiSnap.data() || {}) : {});
  const sanctionData = sanctionSnap.exists ? (sanctionSnap.data() || {}) : (legacySanctionSnap.exists ? (legacySanctionSnap.data() || {}) : {});
  const sanction = mergeSanctions(aiData.moderation, sanctionData.sanction || sanctionData);
  const cfg = {
    rules: normalizeRules(aiData.rules),
    sanction,
    updatedAt: aiData.updatedAt || sanctionData.updatedAt || null
  };
  cache = { at: now, data: cfg };
  return cfg;
}

function clearModerationConfigCache() { cache = { at: 0, data: null }; }

module.exports = { cleanRule, normalizeRules, normalizeSanction, getModerationConfig, clearModerationConfigCache };
