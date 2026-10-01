const crypto = require('crypto');
const { getAdminApp } = require('./_security');
const { getModerationConfig } = require('./moderation-config');

let configCache = { at: 0, data: null };
const moderationCache = new Map();

function regexPreFilter(profile, rules = []) {
  const parts = [
    profile.displayName || '', profile.username || '', profile.bio || '', profile.photoURL || '',
    Array.isArray(profile.links) ? profile.links.map((l) => [l?.title, l?.name, l?.url, l?.description].filter(Boolean).join(' ')).join(' ') : '',
    Array.isArray(profile.testimonials) ? profile.testimonials.map((t) => [t?.name, t?.message].filter(Boolean).join(' ')).join(' ') : '',
    Array.isArray(profile.products) ? profile.products.map((p) => [p?.title, p?.description].filter(Boolean).join(' ')).join(' ') : ''
  ];
  const blob = parts.join('\n');
  for (const rule of Array.isArray(rules) ? rules.filter(r => r && r.enabled !== false && r.pattern) : []) {
    try {
      const re = new RegExp(String(rule.pattern), String(rule.flags || ''));
      if (re.test(blob)) {
        const reason = String(rule.reason || '').trim();
        const action = String(rule.action || '').trim().toUpperCase();
        if (!action) continue;
        return { flagged: true, action, reason, report: reason, confidence: 1, source: 'rule', ruleId: rule.id || null };
      }
    } catch (e) {
      console.warn('Rule configuration ignored:', e.message);
    }
  }
  return null;
}

function extractByPath(payload, path) {
  if (!path) return payload;
  return String(path).split('.').filter(Boolean).reduce((value, key) => {
    if (value == null) return undefined;
    return value[key];
  }, payload);
}

function extractText(payload, responsePath) {
  const value = extractByPath(payload, responsePath);
  if (typeof value === 'string') return value;
  if (value != null && typeof value !== 'object') return String(value);
  if (typeof payload === 'string') return payload;
  return JSON.stringify(value ?? payload ?? '');
}

function parseDecision(text) {
  const raw = String(text || '').trim();
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const x = JSON.parse(m[0]);
      const action = String(x.action || '').trim().toUpperCase();
      const reason = String(x.reason || '').trim();
      const report = String(x.report || x.banReasonReport || x.explanation || x.details || reason || '').trim();
      const confidenceValue = Number(x.confidence);
      const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : 0.8;
      const fields = Array.isArray(x.fields) ? x.fields.map(v => String(v).trim()).filter(Boolean).slice(0, 30) : [];
      const question = String(x.question || '').trim().slice(0, 3000);
      const normalizedAction = action || (x.flagged === true ? 'BLOCK' : x.flagged === false ? 'ALLOW' : '');
      if (['BLOCK', 'BAN', 'SUSPEND'].includes(normalizedAction)) return { flagged: true, action: 'BLOCK', reason, report, confidence, fields, question, raw: x };
      if (['ALLOW', 'APPROVE', 'ACTIVE', 'OK'].includes(normalizedAction)) return { flagged: false, action: 'ALLOW', reason, report, confidence, fields, question, raw: x };
      if (['CORRECTION_PENDING', 'REQUIRES_CORRECTION'].includes(normalizedAction)) return { flagged: false, action: 'CORRECTION_PENDING', reason, report, confidence, fields, question, raw: x };
      if (['MORE_INFO', 'REQUEST_CLARIFICATION', 'CLARIFY'].includes(normalizedAction)) return { flagged: false, action: 'MORE_INFO', reason, report, confidence, fields, question, raw: x };
      if (typeof x.flagged === 'boolean') return { flagged: x.flagged, action: x.flagged ? 'BLOCK' : 'ALLOW', reason, report, confidence, fields, question, raw: x };
    }
  } catch (_) {}
  return { flagged: false, action: 'ALLOW', reason: '', report: '', confidence: 0, fields: [] };
}

async function getAiConfig() {
  const db = getAdminApp().firestore();
  const [canonical, legacy, sanctions] = await Promise.all([
    db.collection('settings').doc('ai_config').get(),
    db.collection('admin_settings').doc('ai_config').get(),
    db.collection('settings').doc('sanctions').get()
  ]);
  const data = canonical.exists ? (canonical.data() || {}) : (legacy.exists ? (legacy.data() || {}) : {});
  const sanctionData = sanctions.exists ? (sanctions.data() || {}) : {};
  const models = Array.isArray(data.models)
    ? data.models.filter((m) => m && m.enabled !== false && m.name && m.endpoint && m.envKey && m.requestTemplate).sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0))
    : [];
  const cfg = {
    models,
    masterPrompt: String(data.promptMaster || data.masterPrompt || '').trim(),
    dialoguePrompt: String(data.dialoguePrompt || '').trim(),
    unavailableBehavior: ['allow', 'manual_review'].includes(String(data.unavailableBehavior || '').trim()) ? String(data.unavailableBehavior).trim() : '',
    dialogueEnabled: data.dialogueEnabled === true,
    rules: Array.isArray(data.rules) ? data.rules : [],
    moderation: data.moderation && typeof data.moderation === 'object' ? data.moderation : (sanctionData.sanction && typeof sanctionData.sanction === 'object' ? sanctionData.sanction : sanctionData),
    moderationDelaySeconds: Number.isFinite(Number(data.moderationDelaySeconds)) ? Number(data.moderationDelaySeconds) : 120
  };
  configCache = { at: Date.now(), data: cfg };
  return cfg;
}

function resolveApiKey(envKey) {
  const keyName = String(envKey || '').trim();
  return keyName ? String(process.env[keyName] || '').trim() : '';
}

function normalizeImagePayload(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/is);
  if (!match) return { base64: raw, mimeType: '', isDataUri: false };
  return { base64: String(match[2] || '').replace(/\s+/g, ''), mimeType: String(match[1] || ''), isDataUri: true };
}

function serializeAnalysis(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value ?? null); } catch (_) { return String(value ?? ''); }
}

function replaceTemplate(value, variables) {
  if (Array.isArray(value)) return value.map(item => replaceTemplate(item, variables));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceTemplate(v, variables)]));
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{(model|prompt|analysis|system_instruction|systemInstruction|image_url|imageUrl|image_base64|imageBase64|image_mime_type|imageMimeType)\}\}/g, (_, key) => variables[key] ?? '');
}

function ensureSystemInstruction(body, systemInstruction) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const prompt = String(systemInstruction || '').trim();
  if (!prompt) return body;
  if (Object.prototype.hasOwnProperty.call(body, 'system_instruction')) body.system_instruction = prompt;
  else if (Object.prototype.hasOwnProperty.call(body, 'systemInstruction')) body.systemInstruction = prompt;
  else if (Object.prototype.hasOwnProperty.call(body, 'system')) body.system = prompt;
  else if (Array.isArray(body.contents)) body.systemInstruction = { parts: [{ text: prompt }] };
  else if (Array.isArray(body.messages)) body.messages.unshift({ role: 'system', content: prompt });
  return body;
}

async function callModel(model, prompt, analysisText, imageUrl) {
  const url = String(model.endpoint || '').trim().replace(/\{model\}/g, encodeURIComponent(String(model.name || '')));
  const key = resolveApiKey(model.envKey);
  if (!url || !key || !model.requestTemplate) throw new Error('AI_CONFIG_INCOMPLETE');
  let template;
  try { template = JSON.parse(model.requestTemplate); } catch (_) { throw new Error('AI_REQUEST_TEMPLATE_INVALID'); }

  const image = normalizeImagePayload(imageUrl);
  const variables = {
    model: String(model.name || ''),
    prompt: String(prompt || ''),
    system_instruction: String(prompt || ''),
    systemInstruction: String(prompt || ''),
    analysis: serializeAnalysis(analysisText),
    image_base64: image.base64,
    imageBase64: image.base64,
    image_mime_type: image.mimeType,
    imageMimeType: image.mimeType,
    image_url: image.base64,
    imageUrl: image.base64
  };
  let body = replaceTemplate(template, variables);
  body = ensureSystemInstruction(body, prompt);

  // Only inject an image automatically when the configured request shape has
  // an explicit vision container. The bytes sent to the provider are pure
  // Base64; the data-URI prefix is never forwarded as the image value.
  if (image.base64 && body && typeof body === 'object' && !Array.isArray(body)) {
    if (Array.isArray(body.contents)) {
      const target = [...body.contents].reverse().find(m => m && Array.isArray(m.parts)) || body.contents[body.contents.length - 1];
      if (target && Array.isArray(target.parts) && !target.parts.some(part => part && (part.inline_data || part.inlineData))) {
        target.parts.push({ inline_data: { mime_type: image.mimeType || 'application/octet-stream', data: image.base64 } });
      }
    }
    if (Array.isArray(body.messages)) {
      const target = [...body.messages].reverse().find(m => m && String(m.role || '').toLowerCase() === 'user') || body.messages[body.messages.length - 1];
      if (target && Array.isArray(target.content) && !target.content.some(part => part && (part.image_base64 || part.image_url))) {
        target.content.push({ type: 'image_base64', image_base64: image.base64, mime_type: image.mimeType || 'application/octet-stream' });
      }
    }
  }

  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const authHeader = String(model.authHeader || '').trim();
  if (authHeader) headers[authHeader] = `${String(model.authPrefix || '')}${key}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    const raw = await r.text();
    if (!r.ok) throw new Error(`AI_HTTP_${r.status}`);
    let parsed = raw;
    try { parsed = JSON.parse(raw); } catch (_) {}
    return parseDecision(extractText(parsed, model.responsePath));
  } finally {
    clearTimeout(timer);
  }
}

function buildProfileAnalysisText(profile) {
  return JSON.stringify({
    displayName: String(profile.displayName || '').slice(0, 120),
    username: String(profile.username || '').slice(0, 80),
    bio: String(profile.bio || '').slice(0, 2000),
    links: Array.isArray(profile.links) ? profile.links.slice(0, 50).map((l) => ({ title: String(l?.title || l?.name || '').slice(0, 80), url: String(l?.url || '').slice(0, 200), description: String(l?.description || '').slice(0, 300) })) : [],
    photoURL: String(profile.photoURL || '').slice(0, 500)
  });
}

async function runConfiguredAgent(prompt, analysisText, configOverride, imageUrl = '') {
  const cfg = configOverride || await getAiConfig();
  if (!String(prompt || '').trim() || !cfg.models.length) return { configured: false, result: null };
  let lastError = null;
  for (const model of cfg.models) {
    try {
      const result = await callModel(model, prompt, analysisText, imageUrl);
      return { configured: true, result: { ...result, source: 'ai' } };
    } catch (e) {
      lastError = e;
      console.warn('AI configuration unavailable, trying next configuration:', e.message);
    }
  }
  return { configured: true, result: null, error: lastError };
}

async function moderateProfileData(profile, options = {}) {
  if (options?.isAdmin === true || String(profile?.role || '').toLowerCase() === 'admin') {
    return { flagged: false, action: 'ALLOW', skipped: true, adminExempt: true, reason: '', report: '', fields: [] };
  }
  const cfg = await getAiConfig();
  const ruleHit = regexPreFilter(profile, cfg.rules);
  if (ruleHit) return ruleHit;

  if (!cfg.masterPrompt || !cfg.models.length) return { flagged: false, action: 'ALLOW', skipped: true, reason: '', report: '', fields: [] };

  const analysisText = buildProfileAnalysisText(profile);
  const imageUrl = String(profile.photoURL || '').trim();
  const contentHash = crypto.createHash('sha256').update(analysisText).digest('hex');
  const cached = moderationCache.get(contentHash);
  if (cached && Date.now() - cached.at < 60000) return cached.result;

  const run = await runConfiguredAgent(cfg.masterPrompt, analysisText, cfg, imageUrl);
  if (run.result) {
    moderationCache.set(contentHash, { at: Date.now(), result: run.result });
    return run.result;
  }
  if (cfg.unavailableBehavior === 'manual_review') return { flagged: false, action: 'MANUAL_REVIEW', reviewRequired: true, skipped: true, reason: '', report: '', fields: [] };
  return { flagged: false, action: 'ALLOW', skipped: true, unavailable: true, reason: '', report: '', fields: [] };
}

async function runExaminationAgent(analysisText) {
  const cfg = await getAiConfig();
  if (!cfg.dialogueEnabled || !cfg.dialoguePrompt || !cfg.models.length) return { configured: false, result: null };
  return runConfiguredAgent(cfg.dialoguePrompt, analysisText, cfg);
}

function clearAiConfigCache() { configCache = { at: 0, data: null }; }

module.exports = { moderateProfileData, runExaminationAgent, getAiConfig, clearAiConfigCache, regexPreFilter, parseDecision, callModel, normalizeImagePayload };
