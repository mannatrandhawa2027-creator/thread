/* ============================================================
   Thread - server-side AI generation.
   Keys live ONLY here on the server, in environment variables.
   Provider auto-detection order:
     1. OPENAI_API_KEY     (default model gpt-4o, vision)
     2. ANTHROPIC_API_KEY  (default model claude-sonnet-4-20250514, vision)
     3. GEMINI_API_KEY     (default model gemini-2.5-flash, vision)
     4. none set           -> free keyless endpoint (text only, no vision)
   ============================================================ */
'use strict';

const DIRECT_ENDPOINT = 'https://text.pollinations.ai/openai';
const TIMEOUT_MS = 150000;

function detectProvider() {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.REQUIRE_API_KEY === '1') return 'none';
  return 'keyless';
}

function providerInfo() {
  const p = detectProvider();
  return {
    provider: p,
    vision: p === 'openai' || p === 'anthropic' || p === 'gemini',
    configured: p !== 'none'
  };
}

const CONFIG_HELP = [
  '# Set ONE of these in the server environment, then restart:',
  'OPENAI_API_KEY=sk-...          # uses OPENAI_MODEL (default gpt-4o)',
  'ANTHROPIC_API_KEY=sk-ant-...   # uses ANTHROPIC_MODEL (default claude-sonnet-4-20250514)',
  'GEMINI_API_KEY=...             # uses GEMINI_MODEL (default gemini-2.5-flash)',
  '# With none set, Thread falls back to a free keyless text-only endpoint.',
  '# Set REQUIRE_API_KEY=1 to disable that fallback and show this message instead.'
].join('\n');

function buildMessages(prefs, visionOk, compact) {
  const system = [
    'You are Thread, an expert knitting and crochet pattern designer who writes patterns for absolute beginners.',
    'Write a complete, realistic, beginner-friendly pattern based on the user\'s project preferences.',
    'Rules:',
    '- Output ONLY valid JSON. No markdown, no code fences, no commentary.',
    '- JSON shape: {"title":string,"craftType":string,"difficulty":string,"summary":string,',
    '  "materials":string[],"tools":string[],"assumptions":string[],',
    '  "steps":[{"title":string,"detail":string}],',
    '  "stitches":[{"term":string,"explanation":string}],"tips":string[]}',
    '- craftType and difficulty must match the user\'s choices.',
    '- materials: every yarn amount with realistic yardage/gram estimates for the size; include notions.',
    '- tools: needles/hook sizes that suit the yarn weight.',
    '- assumptions: 2-5 short bullet strings describing what you assumed (style, fit, construction, colors',
    visionOk ? '  visible in the reference photo).' : '  since no photo analysis was available).',
    compact
      ? '- steps: 6-9 numbered stages in making order, each with a short title and 1-3 concise sentences.'
      : '- steps: 6-12 numbered stages in making order, each with a short title and 2-5 sentences of clear detail.',
    '  Use full sentences a total beginner can follow. Include finishing (weaving in ends, blocking).',
    compact
      ? '- stitches: explain the stitches/abbreviations used (max 8), in plain words, one entry each.'
      : '- stitches: explain EVERY stitch or abbreviation used, in plain words, one entry each.',
    compact
      ? '- tips: 3 practical beginner tips. Keep the whole response under 1100 tokens.'
      : '- tips: 3-5 practical beginner tips (tension, counting, fixing mistakes).',
    'Respond with the JSON object only - no reasoning, no preamble.',
    '- If the user wrote "I don\'t know" for any yarn field, choose a widely available, beginner-friendly',
    '  option and record that choice in assumptions.'
  ].join('\n');

  const user = [
    'Project preferences:',
    '- Craft: ' + prefs.craftType,
    '- Skill level: ' + prefs.skillLevel,
    '- Size: ' + prefs.size,
    '- Yarn type: ' + prefs.yarnType,
    '- Yarn weight: ' + prefs.yarnWeight,
    '- Yarn quantity: ' + prefs.yarnQuantity,
    prefs.description ? '- Notes from the maker: ' + prefs.description : null,
    visionOk ? 'A reference photo is attached - base style, colors and construction on what you see.'
             : 'No photo analysis is available; design a classic, versatile version of the project.'
  ].filter(Boolean).join('\n');

  return { system, user };
}

function normalizePattern(o, prefs) {
  const arr = (v) => Array.isArray(v) ? v.filter(Boolean).map(String) : [];
  return {
    title: String(o.title || 'Your Custom Pattern'),
    craftType: String(o.craftType || prefs.craftType || ''),
    difficulty: String(o.difficulty || prefs.skillLevel || ''),
    summary: String(o.summary || ''),
    materials: arr(o.materials),
    tools: arr(o.tools),
    assumptions: arr(o.assumptions),
    steps: (Array.isArray(o.steps) ? o.steps : []).map((s, i) =>
      typeof s === 'string'
        ? { title: 'Step ' + (i + 1), detail: s }
        : { title: String(s.title || 'Step ' + (i + 1)), detail: String(s.detail || s.instructions || '') }),
    stitches: (Array.isArray(o.stitches) ? o.stitches : [])
      .map((s) => ({ term: String(s.term || ''), explanation: String(s.explanation || '') }))
      .filter((s) => s.term),
    tips: arr(o.tips)
  };
}


/* Recover the largest valid prefix of JSON truncated mid-stream (token cap). */
function salvageJson(text) {
  let inStr = false, esc = false;
  const stack = [];
  const cuts = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length >= 1) cuts.push({ pos: i, stack: stack.slice() });
    }
  }
  for (let c = cuts.length - 1; c >= 0; c--) {
    const cut = cuts[c];
    let s = text.slice(0, cut.pos + 1).replace(/,\s*$/, '');
    for (let i = cut.stack.length - 1; i >= 0; i--) s += cut.stack[i] === '{' ? '}' : ']';
    try { return JSON.parse(s); } catch (e) { /* keep looking */ }
  }
  throw new Error('The AI response was truncated and could not be repaired.');
}

function parsePatternJson(text, prefs) {
  if (!text) throw new Error('The AI returned an empty response.');
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('The AI response was not valid pattern data.');
  const slice = cleaned.slice(start, end + 1);
  const attempts = [
    slice,
    sanitizeJsonText(slice),
    sanitizeJsonText(slice).replace(/,\s*([}\]])/g, '$1')
  ];
  for (const a of attempts) {
    try { return normalizePattern(JSON.parse(a), prefs); }
    catch (e) { /* try next */ }
  }
  // last resort: the response was likely truncated mid-stream - salvage it
  return normalizePattern(salvageJson(sanitizeJsonText(slice)), prefs);
}
/* Escape raw control characters that models sometimes emit inside JSON strings. */
function sanitizeJsonText(s) {
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\' && inStr) { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr) {
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      if (ch < ' ') { continue; }
    }
    out += ch;
  }
  return out;
}


async function callJson(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (body && (body.error && (body.error.message || body.error) || body.message)) || res.statusText;
      throw new Error('AI provider error (' + res.status + '): ' + msg);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/* Strip a data URL into {mime, base64}; returns null for anything else. */
function parseDataUrl(dataUrl) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], base64: m[2] } : null;
}

async function generate(prefs) {
  const provider = detectProvider();
  const img = parseDataUrl(prefs.image);

  if (provider === 'none') {
    const err = new Error('No AI provider is configured on this server, so no pattern was generated.');
    err.code = 'NO_PROVIDER';
    err.config = CONFIG_HELP;
    throw err;
  }

  if (provider === 'keyless') {
    const msgs = buildMessages(prefs, false, true);
    const j = await callJson(DIRECT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.KEYLESS_MODEL || 'openai-fast',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: msgs.system },
          { role: 'user', content: msgs.user }
        ]
      })
    });
    const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    const pattern = parsePatternJson(text, prefs);
    if (img) {
      pattern.assumptions.unshift(
        'Your photo was not analyzed: the free keyless endpoint is text-only. ' +
        'Set OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY for photo-based patterns.');
    }
    return { pattern, meta: { provider: 'keyless', vision: false } };
  }

  if (provider === 'openai') {
    const msgs = buildMessages(prefs, !!img);
    const userContent = img
      ? [{ type: 'text', text: msgs.user },
         { type: 'image_url', image_url: { url: prefs.image } }]
      : msgs.user;
    const j = await callJson('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: msgs.system },
          { role: 'user', content: userContent }
        ]
      })
    });
    const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return { pattern: parsePatternJson(text, prefs), meta: { provider: 'openai', vision: !!img } };
  }

  if (provider === 'anthropic') {
    const msgs = buildMessages(prefs, !!img);
    const userContent = [{ type: 'text', text: msgs.user }];
    if (img) {
      userContent.unshift({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } });
    }
    const j = await callJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: msgs.system,
        messages: [{ role: 'user', content: userContent }]
      })
    });
    const text = j && j.content && j.content[0] && j.content[0].text;
    return { pattern: parsePatternJson(text, prefs), meta: { provider: 'anthropic', vision: !!img } };
  }

  // gemini
  const msgs = buildMessages(prefs, !!img);
  const parts = [{ text: msgs.system + '\n\n' + msgs.user }];
  if (img) parts.unshift({ inlineData: { mimeType: img.mime, data: img.base64 } });
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const j = await callJson(
    'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + process.env.GEMINI_API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });
  const text = j && j.candidates && j.candidates[0] && j.candidates[0].content &&
    j.candidates[0].content.parts && j.candidates[0].content.parts.map((p) => p.text || '').join('');
  return { pattern: parsePatternJson(text, prefs), meta: { provider: 'gemini', vision: !!img } };
}

module.exports = { generate, providerInfo, CONFIG_HELP };
