/**
 * Hosted vision-model connector.
 *
 * CivicPulse is model-agnostic: point AI_PROVIDER / AI_BASE_URL / AI_MODEL at
 * any OpenAI-compatible, Anthropic or Gemini vision endpoint and the platform
 * will use it as the primary classifier. If the call fails, times out or is not
 * configured, the caller silently falls back to the on-board CivicVision engine.
 */
import config from '../../config.js';
import { CATEGORY_KEYS, CATEGORIES } from './taxonomy.js';

const SYSTEM = `You are CivicVision, the triage model for a municipal civic-issue platform in India.
You receive one or more photographs of the SAME civic problem taken from different angles.
Identify the civic defect visible in the photos.`;

function buildPrompt(description) {
  const list = CATEGORY_KEYS.map((k) => `- ${k}: ${CATEGORIES[k].label}`).join('\n');
  return `${SYSTEM}

Allowed categories:
${list}

Citizen description (may be empty or unreliable): "${description || ''}"

Reply with ONLY a JSON object, no markdown fence:
{
  "category": "<one key from the list>",
  "confidence": <0..1>,
  "severity": <1..5 where 5 = immediate public-safety hazard>,
  "summary": "<one sentence a municipal officer can act on>",
  "detected_objects": ["<visible object>", "..."],
  "hazards": ["<specific risk to public>", "..."],
  "is_civic_issue": <true|false>,
  "alternate_category": "<second most likely key or null>"
}`;
}

function parseJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function post(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    return JSON.parse(body);
  } finally {
    clearTimeout(timer);
  }
}

function mediaType(buffer) {
  return buffer[0] === 0x89 && buffer[1] === 0x50 ? 'image/png' : 'image/jpeg';
}

/* --------------------------------------------------------------- providers */

async function callAnthropic({ buffers, description, model, apiKey, baseUrl }) {
  const url = `${baseUrl || 'https://api.anthropic.com'}/v1/messages`;
  const content = buffers.map((b) => ({
    type: 'image',
    source: { type: 'base64', media_type: mediaType(b), data: b.toString('base64') }
  }));
  content.push({ type: 'text', text: buildPrompt(description) });

  const json = await post(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-5',
      max_tokens: 700,
      messages: [{ role: 'user', content }]
    })
  }, config.ai.timeoutMs);

  return parseJson(json?.content?.map((c) => c.text).filter(Boolean).join('\n'));
}

async function callOpenAI({ buffers, description, model, apiKey, baseUrl }) {
  const base = baseUrl || 'https://api.openai.com/v1';
  const url = `${base}/chat/completions`;
  const content = buffers.map((b) => ({
    type: 'image_url',
    image_url: { url: `data:${mediaType(b)};base64,${b.toString('base64')}` }
  }));
  content.push({ type: 'text', text: buildPrompt(description) });

  const json = await post(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      max_tokens: 700,
      temperature: 0.1,
      messages: [{ role: 'user', content }]
    })
  }, config.ai.timeoutMs);

  return parseJson(json?.choices?.[0]?.message?.content);
}

async function callGemini({ buffers, description, model, apiKey, baseUrl }) {
  const base = baseUrl || 'https://generativelanguage.googleapis.com';
  const m = model || 'gemini-2.0-flash';
  const url = `${base}/v1beta/models/${m}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const parts = buffers.map((b) => ({
    inline_data: { mime_type: mediaType(b), data: b.toString('base64') }
  }));
  parts.push({ text: buildPrompt(description) });

  const json = await post(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.1 } })
  }, config.ai.timeoutMs);

  return parseJson(json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n'));
}

const PROVIDERS = { anthropic: callAnthropic, openai: callOpenAI, gemini: callGemini };

export function remoteConfigured() {
  const { provider, apiKey } = config.ai;
  if (provider === 'local') return false;
  if (!apiKey) return false;
  if (provider === 'auto') return Boolean(config.ai.baseUrl || /^sk-ant-/.test(apiKey) || /^sk-/.test(apiKey) || /^AIza/.test(apiKey));
  return Boolean(PROVIDERS[provider]);
}

function resolveProvider() {
  const { provider, apiKey } = config.ai;
  if (provider !== 'auto') return provider;
  if (/^sk-ant-/.test(apiKey)) return 'anthropic';
  if (/^AIza/.test(apiKey)) return 'gemini';
  return 'openai'; // OpenAI-compatible is the widest surface for custom gateways
}

/** Returns a normalised remote verdict, or null if the remote model is unusable. */
export async function remoteAnalyse(buffers, description) {
  if (!remoteConfigured()) return null;
  const name = resolveProvider();
  const fn = PROVIDERS[name];
  if (!fn) return null;

  try {
    const out = await fn({
      buffers: buffers.slice(0, 4),
      description,
      model: config.ai.model,
      apiKey: config.ai.apiKey,
      baseUrl: config.ai.baseUrl
    });
    if (!out || !out.category) return null;
    const category = CATEGORY_KEYS.includes(out.category) ? out.category : null;
    if (!category) return null;
    return {
      provider: name,
      model: config.ai.model || 'default',
      category,
      confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0.7)),
      severity: Math.max(1, Math.min(5, Math.round(Number(out.severity) || 3))),
      summary: String(out.summary || '').slice(0, 400),
      objects: Array.isArray(out.detected_objects) ? out.detected_objects.slice(0, 8).map(String) : [],
      hazards: Array.isArray(out.hazards) ? out.hazards.slice(0, 6).map(String) : [],
      isCivicIssue: out.is_civic_issue !== false,
      alternate: CATEGORY_KEYS.includes(out.alternate_category) ? out.alternate_category : null
    };
  } catch (err) {
    lastError = `${name}: ${err.message}`;
    return null;
  }
}

export let lastError = null;
export const remoteStatus = () => ({
  configured: remoteConfigured(),
  provider: remoteConfigured() ? resolveProvider() : null,
  model: config.ai.model || null,
  baseUrl: config.ai.baseUrl || null,
  lastError
});

export default { remoteAnalyse, remoteConfigured, remoteStatus };
