/* Thread photo/pattern server - runs on Google Apps Script under the owner's account.
   Secrets live in Script Properties (GEMINI_API_KEY), never in this file.
   Off switch: set Script Property PHOTO_ANALYSIS=off (or delete GEMINI_API_KEY) -
   /health then reports vision:false and the site stops sending images. */

var MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
var DAILY_LIMIT = 60;      // max pattern requests per day (owner-quota guard)
var DAILY_IMG_LIMIT = 30;  // max photo analyses per day

function doGet(e) {
  return json_({ ok: true, provider: key_() ? 'gemini' : 'none', vision: visionOn_(), configured: !!key_() });
}

function doPost(e) {
  try {
    if (!key_()) {
      return json_({ error: { code: 'NO_PROVIDER', message: 'No AI key is configured on this server, so no pattern was generated.' } });
    }
    var raw = (e.postData && e.postData.contents) || '{}';
    if (raw.length > 4500000) { // ~3.3MB decoded; client downscales far below this
      return json_({ error: { code: 'TOO_LARGE', message: 'The request was too large. Use a smaller photo.' } });
    }
    var prefs = JSON.parse(raw);
    var bad = validatePrefs_(prefs);
    if (bad) return json_({ error: { code: 'VALIDATION', message: bad } });
    var img = parseDataUrl_(prefs.image);
    if (prefs.image && !img) {
      return json_({ error: { code: 'BAD_IMAGE', message: 'The photo format is not supported. Use a JPG, PNG or WebP image.' } });
    }
    if (img && img.base64.length > 3000000) { // ~2.2MB decoded
      return json_({ error: { code: 'TOO_LARGE', message: 'The photo is too large. Try a smaller image.' } });
    }
    if (img && !visionOn_()) {
      return json_({ error: { code: 'NO_VISION', message: 'Photo analysis is turned off. No pattern was generated. Your photo was not analyzed, was not sent to the AI provider, and is not kept by this app.' } });
    }
    if (overDaily_(!!img)) {
      return json_({ error: { code: 'RATE_LIMIT', message: 'The free pattern service has reached its daily limit. Please try again tomorrow.' } });
    }
    var msgs = buildMessages_(prefs, !!img);
    var parts = [];
    if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.base64 } });
    parts.push({ text: msgs.system + '\n\n' + msgs.user });
    var lastErr = '';
    var order = orderModels_();
    for (var i = 0; i < order.length; i++) {
      var model = order[i];
      traceStart_(model); // pre-call write: an entry left open marks an execution that died inside this fetch
      setInFlight_(model);
      var code = 0, body = {}, failed = null;
      try {
        var resp = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key_(), {
          method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          timeoutSeconds: FETCH_TIMEOUT_SEC,
          payload: JSON.stringify({ contents: [{ role: 'user', parts: parts }], generationConfig: { responseMimeType: 'application/json' } })
        });
        code = resp.getResponseCode();
        try { body = JSON.parse(resp.getContentText()); } catch (pe) {}
      } catch (fe) {
        failed = 'timeout or transport error';
      }
      clearInFlight_(model);
      traceEnd_(model, failed ? 'exc' : (code === 200 ? 'ok' : 'http_' + code));
      if (failed) { markBad_(model, BAD_COOLDOWN_SEC); lastErr = failed; continue; }
      if (code === 200 && body.candidates && body.candidates[0]) {
        var text = body.candidates[0].content.parts.filter(function (p) { return !!p.text; }).map(function (p) { return p.text; }).join('');
        var pattern = parsePattern_(text);
        if (pattern) { clearBad_(model); return json_({ pattern: pattern, meta: { provider: 'gemini', model: model, vision: !!img } }); }
        lastErr = 'unparseable response';
        continue;
      }
      lastErr = (body.error && body.error.message) || ('HTTP ' + code);
      if (code === 429) { markBad_(model, RATE_COOLDOWN_SEC); continue; }
      if (code === 503 || code === 404 || code >= 500) { markBad_(model, BAD_COOLDOWN_SEC); continue; }
      return json_({ error: { code: 'UPSTREAM', message: 'The AI service returned an error (' + code + ').' } });
    }
    return json_({ error: { code: 'BUSY', message: 'The AI service is busy right now - please try again in a minute.', retryable: true } });
  } catch (err) {
    return json_({ error: { code: 'BAD_REQUEST', message: 'The request could not be understood.' } });
  }
}

// ---- resilience: bounded per-model timeout + cross-request breaker ----
// UrlFetchApp's documented default timeout is 360s - the same as the 6-minute
// per-execution budget - so one stalled model call used to consume the whole
// request and the fallback loop below never ran. FETCH_TIMEOUT_SEC bounds one
// model call so a stalled model fails in time for the next model to answer
// (healthy generations observed at ~15-30s; 75s gives them ample headroom).
// The breaker (script cache) demotes models that just failed or are in flight,
// so later requests start at a healthier model; demoted models are still tried
// as a last resort when nothing else is available.
var FETCH_TIMEOUT_SEC = 75;
var BAD_COOLDOWN_SEC = 1800;   // exceptions/404/5xx: demote this model for 30 min
var RATE_COOLDOWN_SEC = 120;   // 429: per-minute limits recover quickly
var TRY_TTL_SEC = 420;         // in-flight marker outlives the 6-min execution cap

function cache_() { return CacheService.getScriptCache(); }
function markBad_(m, secs) { try { cache_().put('mbad_' + m, '1', secs); } catch (e) {} }
function clearBad_(m) { try { cache_().remove('mbad_' + m); } catch (e) {} }
function isBad_(m) { try { return !!cache_().get('mbad_' + m); } catch (e) { return false; } }
function setInFlight_(m) { try { cache_().put('mtry_' + m, '1', TRY_TTL_SEC); } catch (e) {} }
function clearInFlight_(m) { try { cache_().remove('mtry_' + m); } catch (e) {} }
function inFlight_(m) { try { return !!cache_().get('mtry_' + m); } catch (e) { return false; } }

function orderModels_() {
  var fresh = [], stale = [];
  for (var i = 0; i < MODELS.length; i++) {
    var m = MODELS[i];
    (isBad_(m) || inFlight_(m) ? stale : fresh).push(m);
  }
  return fresh.concat(stale); // a demoted model is still better than no attempt at all
}

// Last few model attempts with stage timings - model id, timestamps and outcome
// class only (never photos, prompts or keys). An entry with t0 but no end marks
// an execution that died inside the fetch: proof of where a stall happened.
function traceStart_(m) {
  try {
    var p = PropertiesService.getScriptProperties();
    var arr = JSON.parse(p.getProperty('TRACE') || '[]');
    arr.push({ m: m, t0: Date.now() });
    if (arr.length > 12) arr = arr.slice(arr.length - 12);
    p.setProperty('TRACE', JSON.stringify(arr));
  } catch (e) {}
}
function traceEnd_(m, out) {
  try {
    var p = PropertiesService.getScriptProperties();
    var arr = JSON.parse(p.getProperty('TRACE') || '[]');
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i].m === m && !arr[i].end) { arr[i].end = Date.now(); arr[i].out = out; break; }
    }
    p.setProperty('TRACE', JSON.stringify(arr));
  } catch (e) {}
}

var CRAFTS = ['Knitting', 'Crochet'];
var LEVELS = ['Beginner', 'Beginner+', 'Intermediate'];
var SIZES = ['Small', 'Medium', 'Large'];

function clip_(s, n) { return (typeof s === 'string' ? s : '').slice(0, n); }

function validatePrefs_(p) {
  if (!p || CRAFTS.indexOf(p.craftType) === -1) return 'craftType must be Knitting or Crochet.';
  if (LEVELS.indexOf(p.skillLevel) === -1) return 'Invalid skillLevel.';
  if (SIZES.indexOf(p.size) === -1) return 'Invalid size.';
  p.yarnType = clip_(p.yarnType, 120) || "I don't know";
  p.yarnWeight = clip_(p.yarnWeight, 60) || "I don't know";
  p.yarnQuantity = clip_(p.yarnQuantity, 120) || "I don't know";
  p.description = clip_(p.description, 500);
  p.projectType = clip_(p.projectType, 60);
  p.fit = clip_(p.fit, 60);
  p.texture = clip_(p.texture, 60);
  p.colors = clip_(p.colors, 60);
  return null;
}

function key_() { return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY'); }

// Coarse global daily cap (per UTC date), stored in Script Properties. Bounds how much
// of the owner's Apps Script runtime quota and Gemini free-tier quota this public
// endpoint can consume. Not per-user - Apps Script web apps see no client identity.
function overDaily_(isImage) {
  // Called once per request, before any model call (one user request = one count,
  // including the 3.8->3.6 in-request fallback; a client retry is a new request).
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
  } catch (e) {
    return true; // fail closed under lock contention rather than risk the owner's quota
  }
  try {
    var props = PropertiesService.getScriptProperties();
    var day = new Date().toISOString().slice(0, 10);
    if (props.getProperty('RL_DAY') !== day) {
      props.setProperty('RL_DAY', day);
      props.setProperty('RL_COUNT', '0');
      props.setProperty('RL_IMG', '0');
    }
    var n = parseInt(props.getProperty('RL_COUNT') || '0', 10);
    var m = parseInt(props.getProperty('RL_IMG') || '0', 10);
    if (n >= DAILY_LIMIT || (isImage && m >= DAILY_IMG_LIMIT)) return true;
    props.setProperty('RL_COUNT', String(n + 1));
    if (isImage) props.setProperty('RL_IMG', String(m + 1));
    return false;
  } finally {
    lock.releaseLock();
  }
}
function visionOn_() { return !!key_() && PropertiesService.getScriptProperties().getProperty('PHOTO_ANALYSIS') !== 'off'; }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function parseDataUrl_(s) {
  if (!s || typeof s !== 'string') return null;
  var m = s.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!m) return null;
  return { mime: m[1], base64: m[2] };
}

function parsePattern_(text) {
  if (!text) return null;
  var cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  var a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(cleaned.slice(a, b + 1)); } catch (e) { return null; }
}

function buildMessages_(prefs, visionOk) {
  var system = [
    'You are Thread, an expert knitting and crochet pattern designer who writes patterns for absolute beginners.',
    'Write a complete, realistic, beginner-friendly pattern based on the user\'s project preferences.',
    'Rules:',
    '- Output ONLY valid JSON. No markdown, no code fences, no commentary.',
    '- JSON shape: {"title":string,"craftType":string,"difficulty":string,"summary":string,',
    '  "materials":string[],"tools":string[],"assumptions":string[],',
    '  "steps":[{"title":string,"detail":string}],',
    '  "stitches":[{"term":string,"explanation":string}],"tips":string[]}',
    '- craftType and difficulty must match the user\'s choices.',
    '- If the user picked a project type, fit, texture or colors, the pattern must match them',
    '  exactly - title, construction, stitch patterns, steps, materials and yardage.',
    '- Use only standard, real knitting and crochet techniques and terminology. Never invent',
    '  stitches, tools, cast-ons or methods.',
    '- Be complete and internally consistent: stitch counts must add up from step to step, state',
    '  exact counts for every increase and decrease, and never end a sentence or step mid-way.',
    '- Yarn: suggest a generic yarn (fiber and weight) with total grams and yardage. Never name brands.',
    '- Include the tension/gauge (stitches and rows per 10 cm) and the finished measurements for the',
    '  chosen size, in the assumptions.',
    '- For wearables, give the construction order (back, fronts, sleeves, seaming, then edging or',
    '  bands) with simple shaping a beginner can count.',
    '- materials: every yarn amount with realistic yardage/gram estimates for the size; include notions.',
    '- tools: needles/hook sizes that suit the yarn weight.',
    '- assumptions: 2-5 short bullet strings describing what you assumed (style, fit, construction, colors',
    visionOk ? '  visible in the reference photo).' : '  since no photo analysis was available).',
    '- steps: 6-9 numbered stages in making order, each with a short title and 1-3 concise sentences.',
    '  Use full sentences a total beginner can follow. Include finishing (weaving in ends, blocking).',
    '- stitches: explain the stitches/abbreviations used (max 8), in plain words, one entry each.',
    '- tips: 3 practical beginner tips. Keep wording tight, but never cut a step short.',
    'Respond with the JSON object only - no reasoning, no preamble.',
    '- If the user wrote "I don\'t know" for any yarn field, choose a widely available, beginner-friendly',
    '  option and record that choice in assumptions.'
  ].join('\n');

  var user = [
    'Project preferences:',
    '- Craft: ' + prefs.craftType,
    '- Skill level: ' + prefs.skillLevel,
    '- Size: ' + prefs.size,
    '- Yarn type: ' + prefs.yarnType,
    '- Yarn weight: ' + prefs.yarnWeight,
    '- Yarn quantity: ' + prefs.yarnQuantity,
    prefs.projectType ? '- Project type: ' + prefs.projectType : null,
    prefs.fit ? '- Fit: ' + prefs.fit : null,
    prefs.texture ? '- Texture / look: ' + prefs.texture : null,
    prefs.colors ? '- Colors: ' + prefs.colors : null,
    prefs.description ? '- Notes from the maker: ' + prefs.description : null,
    visionOk ? 'A reference photo is attached - identify the item and base the style, colors, texture and construction on what you see, combined with the choices above.'
             : (prefs.projectType || prefs.fit || prefs.texture || prefs.colors
                 ? 'No photo analysis is available - the choices above define the design. Follow them exactly.'
                 : 'No photo analysis is available; design a classic, versatile version of the project.')
  ].filter(function (x) { return !!x; }).join('\n');

  return { system: system, user: user };
}
