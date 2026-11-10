/* ============================================================
   Thread - See it. Make it.
   Frontend logic: routing, form, AI generation, results, PDF.
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- state ---------------- */
  var state = {
    craftType: null,
    skillLevel: null,
    size: null,
    projectType: null,    // 'Match the look' picks (all optional)
    fit: null,
    texture: null,
    colors: null,
    imageDataUrl: null,   // downscaled data URL, or null
    mode: null,           // 'server' | 'direct'  (resolved once)
    photoServer: { checked: false, ok: false, vision: false },
    currentPattern: null
  };

  /* Apps Script endpoint under the site owner's account: the ONLY place a photo is
     ever sent. No API key exists anywhere in this file. When it reports vision:false
     or is unreachable, photo upload is disabled and generation is text-only. */
  var PHOTO_API = 'https://script.google.com/macros/s/AKfycbyuKYycAnTDE3y73wIz_XDJFgLQ25tedHVYuN-C2Dx37O3GSLTV4xMWJCGFIvglxP12/exec';

  var HINT_ON = 'Add a photo of something you own, or a screenshot of a design you love from Pinterest, Instagram or Google. When you generate, the photo is sent to Google Gemini (free tier) to analyze its style - only after you tick the consent box. Use the quick choices below to steer the design; the result is a pattern in that style, not an exact copy.';
  var HINT_OFF = 'Photo matching is temporarily unavailable right now - you can still generate a pattern from your written choices below. Nothing is uploaded.';
  var HINT_CHECKING = 'Checking whether photo matching is available... You can always generate from your written choices below.';

  var STORE_KEY = 'thread.patterns.v1';

  /* ---------------- tiny helpers ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- routing ---------------- */
  var views = { home: 'view-home', create: 'view-create', results: 'view-results', patterns: 'view-patterns', thanks: 'view-thanks' };
  function paymentReturnParams() {
    var q = new URLSearchParams(location.search);
    if (q.get('payment_id') || q.get('status')) return q;
    var h = location.hash, qi = h.indexOf('?');
    if (qi !== -1) {
      var hq = new URLSearchParams(h.slice(qi + 1));
      if (hq.get('payment_id') || hq.get('status')) return hq;
    }
    return null;
  }
  function route() {
    var pr = paymentReturnParams();
    var hash = location.hash.replace(/^#\/?/, '').split('?')[0] || 'home';
    if (pr) hash = 'thanks';
    if (!views[hash]) hash = 'home';
    Object.keys(views).forEach(function (k) {
      document.getElementById(views[k]).hidden = (k !== hash);
    });
    $all('.nav-links a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-nav') === hash);
    });
    if (hash === 'patterns') renderPatternsList();
    if (hash === 'thanks') renderThanks(pr);
    window.scrollTo({ top: 0 });
  }
  window.addEventListener('hashchange', route);

  /* ---------------- payment return (thank-you page) ---------------- */
  function renderThanks(params) {
    var p = params || new URLSearchParams();
    var status = (p.get('status') || '').toLowerCase();
    var paymentId = p.get('payment_id') || '';
    var email = p.get('email') || '';
    var title = $('#thanks-title'), sub = $('#thanks-sub'), body = $('#thanks-body');
    body.innerHTML = '';
    if (status === 'succeeded') {
      title.textContent = 'Thank you - payment successful!';
      sub.textContent = 'Your Pattern Pack checkout (test mode) went through.';
      var ok = el('div', 'thanks-status ok');
      ok.appendChild(el('strong', null, 'Payment status: succeeded'));
      body.appendChild(ok);
    } else if (status) {
      title.textContent = 'Checkout not completed';
      sub.textContent = 'The payment did not go through. You have not been charged.';
      var bad = el('div', 'thanks-status failed');
      bad.appendChild(el('strong', null, 'Payment status: ' + status));
      body.appendChild(bad);
    } else {
      title.textContent = 'Thank you!';
      sub.textContent = 'Welcome back from checkout.';
    }
    if (paymentId) {
      var row = el('p', 'thanks-detail');
      row.textContent = 'Payment reference: ' + paymentId;
      body.appendChild(row);
    }
    if (email) {
      var row2 = el('p', 'thanks-detail');
      row2.textContent = 'Email used at checkout: ' + email;
      body.appendChild(row2);
    }
  }


  /* ---------------- segmented controls ---------------- */
  $all('.segmented').forEach(function (seg) {
    var field = seg.getAttribute('data-field');
    seg.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      $all('button', seg).forEach(function (b) { b.classList.remove('selected'); });
      btn.classList.add('selected');
      state[field] = btn.getAttribute('data-value');
      clearError(field);
    });
  });

  /* ---------------- photo server availability + consent UI ---------------- */
  function updatePhotoUi() {
    var ps = state.photoServer;
    var hint = $('#vision-hint');
    hint.textContent = !ps.checked ? HINT_CHECKING : (ps.vision ? HINT_ON : HINT_OFF);
    $('#dropzone').classList.toggle('dz-disabled', !ps.vision);
    syncConsent();
  }
  function syncConsent() {
    var show = !!state.imageDataUrl && state.photoServer.vision;
    $('#photo-consent').hidden = !show;
    if (!show) $('#photo-consent-check').checked = false;
  }
  function photoError(msg) {
    var e = $('#photo-error');
    if (!msg) { e.hidden = true; e.textContent = ''; return; }
    e.textContent = msg; e.hidden = false;
  }
  function checkPhotoServer() {
    return fetch(PHOTO_API, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('bad status'); return r.json(); })
      .then(function (j) {
        state.photoServer = { checked: true, ok: !!(j && j.ok), vision: !!(j && j.ok && j.vision) };
      })
      .catch(function () {
        state.photoServer = { checked: true, ok: false, vision: false };
      })
      .then(updatePhotoUi);
  }

  /* ---------------- image upload ---------------- */
  var dropzone = $('#dropzone'), imageInput = $('#image-input');
  dropzone.addEventListener('click', function (e) {
    if (e.target.closest('.dz-actions')) return;
    if (!state.photoServer.vision) { photoError(''); return; }
    imageInput.click();
  });
  dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); imageInput.click(); }
  });
  ['dragover', 'dragenter'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.remove('drag'); });
  });
  dropzone.addEventListener('drop', function (e) {
    if (!state.photoServer.vision) return;
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readImage(f);
  });
  imageInput.addEventListener('change', function () {
    if (imageInput.files && imageInput.files[0]) readImage(imageInput.files[0]);
  });
  $('#remove-img').addEventListener('click', function () { setImage(null); });
  $('#replace-img').addEventListener('click', function () { imageInput.click(); });

  function readImage(file) {
    if (!state.photoServer.vision) return;
    if (!/^image\//.test(file.type)) { alert('That file is not an image - please choose a photo.'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      downscale(reader.result, 1024, 0.82, function (dataUrl) { setImage(dataUrl); });
    };
    reader.readAsDataURL(file);
  }
  function downscale(dataUrl, maxDim, quality, cb) {
    var img = new Image();
    img.onload = function () {
      var w = img.width, h = img.height;
      var scale = Math.min(1, maxDim / Math.max(w, h));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      cb(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = function () { cb(dataUrl); };
    img.src = dataUrl;
  }
  function setImage(dataUrl) {
    state.imageDataUrl = dataUrl;
    $('#dz-empty').hidden = !!dataUrl;
    $('#dz-preview').hidden = !dataUrl;
    if (dataUrl) $('#preview-img').src = dataUrl;
    imageInput.value = '';
    photoError('');
    syncConsent();
  }

  $('#photo-consent-check').addEventListener('change', function () { photoError(''); });

  /* ---------------- "Match the look" picture cards ---------------- */
  $all('.match-grid').forEach(function (grid) {
    var field = grid.getAttribute('data-field');
    grid.addEventListener('click', function (e) {
      var card = e.target.closest('.match-card');
      if (!card) return;
      if (card.classList.contains('selected')) {
        card.classList.remove('selected');
        state[field] = null;
      } else {
        $all('.match-card', grid).forEach(function (c) { c.classList.remove('selected'); });
        card.classList.add('selected');
        state[field] = card.getAttribute('data-value');
      }
    });
  });

  /* ---------------- "I don't know" toggles ---------------- */
  $('#yarn-type-idk').addEventListener('change', function () {
    $('#yarn-type').disabled = this.checked;
    if (this.checked) { $('#yarn-type').value = ''; clearError('yarnType'); }
  });
  $('#yarn-qty-idk').addEventListener('change', function () {
    $('#yarn-qty').disabled = this.checked;
    if (this.checked) { $('#yarn-qty').value = ''; clearError('yarnQuantity'); }
  });

  /* ---------------- create journey (stepper) ---------------- */
  var currentStep = 1, TOTAL_STEPS = 4;

  function showStep(n, userInitiated) {
    currentStep = Math.max(1, Math.min(TOTAL_STEPS, n));
    $all('.form-step').forEach(function (s) {
      s.hidden = Number(s.getAttribute('data-step')) !== currentStep;
    });
    $all('.journey-step').forEach(function (s) {
      var j = Number(s.getAttribute('data-jstep'));
      s.classList.toggle('is-active', j === currentStep);
      s.classList.toggle('is-done', j < currentStep);
      if (j < currentStep) s.querySelector('.j-dot').textContent = '\u2713';
      else s.querySelector('.j-dot').textContent = String(j);
    });
    $('#step-back').hidden = currentStep === 1;
    $('#step-next').hidden = currentStep === TOTAL_STEPS;
    if (currentStep === TOTAL_STEPS) renderReview();
    if (userInitiated) {
      var head = document.querySelector('#view-create .page-head');
      if (head && head.scrollIntoView) head.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function validateStep(n) {
    if (n === 1) {
      // photo is optional, but flag early if one is attached while matching is off
      if (state.imageDataUrl && !state.photoServer.vision) {
        photoError('Photo matching is turned off right now. Remove the photo to continue with written choices - nothing will be uploaded.');
        return false;
      }
      return true;
    }
    if (n === 2) {
      var ok = true;
      if (!state.craftType) { setError('craftType', true); ok = false; }
      if (!state.skillLevel) { setError('skillLevel', true); ok = false; }
      if (!state.size) { setError('size', true); ok = false; }
      return ok;
    }
    if (n === 3) {
      var ok2 = true;
      var yt = $('#yarn-type'), ytIdk = $('#yarn-type-idk').checked;
      if (!ytIdk && !yt.value.trim()) { setError('yarnType', true); yt.classList.add('invalid'); ok2 = false; }
      var yw = $('#yarn-weight');
      if (!yw.value) { setError('yarnWeight', true); yw.classList.add('invalid'); ok2 = false; }
      var yq = $('#yarn-qty'), yqIdk = $('#yarn-qty-idk').checked;
      if (!yqIdk && !yq.value.trim()) { setError('yarnQuantity', true); yq.classList.add('invalid'); ok2 = false; }
      return ok2;
    }
    return true;
  }

  $('#step-next').addEventListener('click', function () {
    if (!validateStep(currentStep)) {
      var firstErr = $('.field-error:not([hidden])');
      if (firstErr) firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    showStep(currentStep + 1, true);
  });
  $('#step-back').addEventListener('click', function () { showStep(currentStep - 1, true); });

  // Enter moves forward inside the journey instead of submitting early
  $('#create-form').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.type === 'submit' || t.id === 'step-next' || t.id === 'step-back')) return;
    e.preventDefault();
    if (currentStep < TOTAL_STEPS) $('#step-next').click();
  });

  /* review summary on the final step */
  function renderReview() {
    var root = $('#review-summary');
    if (!root) return;
    var ytIdk = $('#yarn-type-idk').checked, yqIdk = $('#yarn-qty-idk').checked;
    var yw = $('#yarn-weight').value;
    var groups = [];
    function chip(text, cls) { return '<span class="review-chip' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</span>'; }
    function group(title, chips, editStep) {
      return '<div class="review-group"><h4>' + esc(title) +
        '<button type="button" class="review-edit" data-goto="' + editStep + '">change</button></h4>' +
        '<div class="review-chips">' + chips.join('') + '</div></div>';
    }
    var insp = [];
    insp.push(state.imageDataUrl ? chip('Reference photo added', 'accent') : chip('No photo - written choices only', 'muted'));
    groups.push(group('Inspiration', insp, 1));
    var style = [];
    if (state.projectType) style.push(chip(state.projectType, 'accent'));
    if (state.fit) style.push(chip(state.fit));
    if (state.texture) style.push(chip(state.texture));
    if (state.colors) style.push(chip(state.colors));
    style.push(chip(state.craftType || '-'));
    style.push(chip(state.skillLevel || '-'));
    style.push(chip('Size: ' + (state.size || '-')));
    groups.push(group('Style', style, 2));
    var yarn = [];
    yarn.push(chip('Type: ' + (ytIdk ? "we'll suggest one" : ($('#yarn-type').value.trim() || '-'))));
    yarn.push(chip('Weight: ' + (yw === '__idk__' ? "we'll suggest one" : (yw || '-'))));
    yarn.push(chip('Quantity: ' + (yqIdk ? "we'll estimate" : ($('#yarn-qty').value.trim() || '-'))));
    groups.push(group('Yarn', yarn, 3));
    var notes = [];
    notes.push($('#description').value.trim() ? chip('Note: "' + $('#description').value.trim() + '"') : chip('No extra notes', 'muted'));
    groups.push(group('Anything else', notes, 3));
    root.innerHTML = groups.join('');
    $all('.review-edit', root).forEach(function (b) {
      b.addEventListener('click', function () { showStep(Number(b.getAttribute('data-goto')), true); });
    });
  }

  /* ---------------- validation ---------------- */
  function setError(field, on) {
    var msg = $('[data-error="' + field + '"]');
    if (msg) msg.hidden = !on;
    var seg = $('.segmented[data-field="' + field + '"]');
    if (seg) seg.classList.toggle('invalid', !!on);
  }
  function clearError(field) { setError(field, false); }

  function validate() {
    var ok = true;
    if (!state.craftType) { setError('craftType', true); ok = false; }
    if (!state.skillLevel) { setError('skillLevel', true); ok = false; }
    if (!state.size) { setError('size', true); ok = false; }

    var yt = $('#yarn-type'), ytIdk = $('#yarn-type-idk').checked;
    if (!ytIdk && !yt.value.trim()) { setError('yarnType', true); yt.classList.add('invalid'); ok = false; }
    else yt.classList.remove('invalid');

    var yw = $('#yarn-weight');
    if (!yw.value) { setError('yarnWeight', true); yw.classList.add('invalid'); ok = false; }
    else yw.classList.remove('invalid');

    var yq = $('#yarn-qty'), yqIdk = $('#yarn-qty-idk').checked;
    if (!yqIdk && !yq.value.trim()) { setError('yarnQuantity', true); yq.classList.add('invalid'); ok = false; }
    else yq.classList.remove('invalid');

    if (state.imageDataUrl) {
      if (!state.photoServer.vision) {
        photoError('Photo matching is turned off right now. Remove the photo to generate from your written choices - nothing will be uploaded.');
        ok = false;
      } else if (!$('#photo-consent-check').checked) {
        photoError('Tick the consent box to send your photo for analysis, or remove the photo.');
        ok = false;
      }
    }

    return ok;
  }
  ['yarn-type', 'yarn-qty'].forEach(function (id) {
    $('#' + id).addEventListener('input', function () {
      this.classList.remove('invalid');
      clearError(id === 'yarn-type' ? 'yarnType' : 'yarnQuantity');
    });
  });
  $('#yarn-weight').addEventListener('change', function () {
    this.classList.remove('invalid'); clearError('yarnWeight');
  });

  /* ---------------- collect preferences ---------------- */
  function collectPrefs() {
    return {
      craftType: state.craftType,
      skillLevel: state.skillLevel,
      size: state.size,
      yarnType: $('#yarn-type-idk').checked ? "I don't know" : $('#yarn-type').value.trim(),
      yarnWeight: $('#yarn-weight').value === '__idk__' ? "I don't know" : $('#yarn-weight').value,
      yarnQuantity: $('#yarn-qty-idk').checked ? "I don't know" : $('#yarn-qty').value.trim(),
      projectType: state.projectType,
      fit: state.fit,
      texture: state.texture,
      colors: state.colors,
      description: $('#description').value.trim(),
      image: state.imageDataUrl
    };
  }

  /* ---------------- prompt (shared shape with server) ---------------- */
  function buildMessages(prefs, visionOk, compact) {
    var sys = [
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
      compact
        ? '- steps: 6-9 numbered stages in making order, each with a short title and 1-3 concise sentences.'
        : '- steps: 6-12 numbered stages in making order, each with a short title and 2-5 sentences of clear detail.',
      '  Use full sentences a total beginner can follow. Include finishing (weaving in ends, blocking).',
      compact
        ? '- stitches: explain the stitches/abbreviations used (max 8), in plain words, one entry each.'
        : '- stitches: explain EVERY stitch or abbreviation used, in plain words, one entry each.',
      compact
        ? '- tips: 3 practical beginner tips. Keep wording tight, but never cut a step short.'
        : '- tips: 3-5 practical beginner tips (tension, counting, fixing mistakes).',
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
      visionOk ? 'A reference photo is attached - base style, colors and construction on what you see.'
               : (prefs.projectType || prefs.fit || prefs.texture || prefs.colors
                   ? 'No photo analysis is available - the choices above define the design. Follow them exactly.'
                   : 'No photo analysis is available; design a classic, versatile version of the project.')
    ].filter(Boolean).join('\n');

    return { system: sys, user: user };
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

  function parsePatternJson(text) {
    if (!text) throw new Error('The AI returned an empty response.');
    var cleaned = String(text).trim()
      .replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    var start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('The AI response was not valid pattern data.');
    var slice = cleaned.slice(start, end + 1);
    var attempts = [slice, sanitizeJsonText(slice),
      sanitizeJsonText(slice).replace(/,\s*([}\]])/g, '$1')];
    for (var i = 0; i < attempts.length; i++) {
      try { return normalizePattern(JSON.parse(attempts[i])); } catch (e) { /* try next */ }
    }
    // last resort: the response was likely truncated mid-stream - salvage it
    return normalizePattern(salvageJson(sanitizeJsonText(slice)));
  }

  function normalizePattern(o) {
    function arr(v) { return Array.isArray(v) ? v.filter(Boolean).map(String) : []; }
    return {
      title: String(o.title || 'Your Custom Pattern'),
      craftType: String(o.craftType || state.craftType || ''),
      difficulty: String(o.difficulty || state.skillLevel || ''),
      summary: String(o.summary || ''),
      materials: arr(o.materials),
      tools: arr(o.tools),
      assumptions: arr(o.assumptions),
      steps: (Array.isArray(o.steps) ? o.steps : []).map(function (s, i) {
        if (typeof s === 'string') return { title: 'Step ' + (i + 1), detail: s };
        return { title: String(s.title || 'Step ' + (i + 1)), detail: String(s.detail || s.instructions || '') };
      }),
      stitches: (Array.isArray(o.stitches) ? o.stitches : []).map(function (s) {
        return { term: String(s.term || ''), explanation: String(s.explanation || '') };
      }).filter(function (s) { return s.term; }),
      tips: arr(o.tips)
    };
  }

  /* ---------------- backend detection ---------------- */
  function resolveMode() {
    if (state.mode) return Promise.resolve(state.mode);
    return fetch('api/health', { headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('no health');
        return r.json();
      })
      .then(function (j) {
        state.mode = (j && j.ok) ? 'server' : 'direct';
        state.serverInfo = j || null;
        return state.mode;
      })
      .catch(function () { state.mode = 'direct'; return state.mode; });
  }

  /* ---------------- generation: server path ---------------- */
  function generateViaServer(prefs) {
    return fetch('api/generate-pattern', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(prefs)
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) {
          var err = new Error((j && j.error && j.error.message) || 'Generation failed.');
          err.code = j && j.error && j.error.code;
          err.config = j && j.error && j.error.config;
          throw err;
        }
        return normalizePattern(j.pattern);
      });
    });
  }

  /* ---------------- generation: photo path (Apps Script -> Gemini) ---------------- */
  /* Reached only when an image is attached, the server reported vision:true on a
     fresh health check, and the consent box is ticked. The image is sent nowhere else. */
  function generateViaPhoto(prefs) {
    // Bounded wait: if the backend never answers, fail honestly instead of
    // spinning forever. A timed-out request may still complete server-side and
    // counts against the daily cap, so it is never auto-retried.
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 150000);
    return fetch(PHOTO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Accept': 'application/json' },
      body: JSON.stringify(prefs),
      signal: ctrl.signal
    }).catch(function (err) {
      if (err && err.name === 'AbortError') {
        var te = new Error('The pattern service did not answer in time. Your request may still have counted toward today\'s photo limit - please wait a few minutes before trying again.');
        te.code = 'TIMEOUT';
        throw te;
      }
      throw err;
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { /* not JSON */ }
        if (!j) {
          var er = new Error('The pattern service returned an unexpected response.');
          er.retryable = true;
          throw er;
        }
        if (j.error) {
          var er2 = new Error(j.error.message || 'Generation failed.');
          er2.code = j.error.code;
          throw er2;
        }
        return normalizePattern(j.pattern);
      });
    }).finally(function () { clearTimeout(timer); });
  }

  /* ---------------- generation: direct keyless path (static hosting) ---------------- */
  var DIRECT_ENDPOINT = 'https://text.pollinations.ai/openai';
  function generateViaDirect(prefs) {
    // Static hosting has no server, so the photo cannot be sent to a vision model
    // on the free keyless tier - text-only generation from the stated preferences.
    var msgs = buildMessages(prefs, false, true);
    // unique nonce per attempt: the free endpoint caches responses by request
    // body, and a cached empty/truncated response would otherwise repeat forever
    msgs.user += '\nRequest id: ' + Date.now() + '-' + Math.random().toString(36).slice(2);
    return fetch(DIRECT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai-fast',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: msgs.system },
          { role: 'user', content: msgs.user }
        ]
      })
    }).then(function (r) {
      if (r.status === 402 || r.status === 429) {
        // free tier: 1 request per ~45s per IP - wait out the window, then retry
        var e402 = new Error('The free AI service asked us to slow down.');
        e402.retryable = true; e402.retryAfterMs = 47000;
        throw e402;
      }
      if (!r.ok) throw new Error('The AI service returned an error (' + r.status + '). Please try again in a moment.');
      return r.json();
    }).then(function (j) {
      var text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (text && /reached its budget|FREE_LIMIT/i.test(text)) {
        // the shared free key can run out - answer comes back as a 200 with an apology
        var eb = new Error('The free AI service is exhausted right now.');
        eb.retryable = true; eb.retryAfterMs = 60000;
        throw eb;
      }
      if (!text || !text.trim()) {
        var err = new Error('The AI returned an empty response.');
        err.retryable = true;
        throw err;
      }
      return parsePatternJson(text);
    });
  }

  /* Baseline structural check, retained unchanged from the current live site:
     refuses only drafts that are clearly broken (too few steps, or steps that
     end mid-sentence). This is not a completeness or correctness review, and
     nothing on the site claims one. */
  function patternLooksBroken(p) {
    if (!p || !p.steps || p.steps.length < 4) return true;
    return p.steps.some(function (s) {
      var d = (s.detail || '').trim();
      return d.length < 25 || !/[.!?"\)]$/.test(d);
    });
  }

  function generateWithRetry(prefs, mode, attempt) {
    attempt = attempt || 1;
    var run = mode === 'server' ? generateViaServer(prefs)
         : mode === 'photo' ? generateViaPhoto(prefs)
         : generateViaDirect(prefs);
    run = run.then(function (p) {
      if (patternLooksBroken(p)) {
        var err = new Error('The AI returned an incomplete pattern.');
        err.retryable = true;
        throw err;
      }
      return p;
    });
    return run.catch(function (err) {
      if (mode === 'photo') {
        // Coded rejections (VALIDATION, BAD_IMAGE, TOO_LARGE, NO_VISION, RATE_LIMIT,
        // NO_PROVIDER) are deliberate server answers - never retry them; each attempt
        // counts against the owner's free daily cap.
        if (err && err.code) throw err;
        if (attempt < 2) {
          return new Promise(function (res) { setTimeout(res, 5000); })
            .then(function () { return generateWithRetry(prefs, mode, attempt + 1); });
        }
        if (err && err.retryable) err.message = 'The pattern service is busy right now - please try again in a minute.';
        throw err;
      }
      var noProvider = err && err.code === 'NO_PROVIDER';
      var maxAttempts = err && err.retryAfterMs ? 4 : 3;
      if (attempt < maxAttempts && !noProvider) {
        // the free endpoint allows ~1 request per 45s per IP - wait past that window
        var wait = (err && err.retryAfterMs) || (attempt === 1 ? 5000 : 47000);
        return new Promise(function (res) { setTimeout(res, wait); })
          .then(function () { return generateWithRetry(prefs, mode, attempt + 1); });
      }
      if (err && err.retryable) err.message = 'The AI service is busy right now - please try again in a minute.';
      throw err;
    });
  }

  /* ---------------- loading overlay ---------------- */
  // Static, truthful waiting copy: the real wait is one generation request
  // (plus retries on the free tier); we do not narrate fake internal stages.
  function showLoading() {
    $('#loading').hidden = false;
    $('#loading-msg').textContent = 'Your pattern is being generated';
  }
  function hideLoading() {
    $('#loading').hidden = true;
  }

  /* ---------------- submit ---------------- */
  $('#create-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!validate()) {
      var firstErr = $('.field-error:not([hidden])');
      if (firstErr) firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    var prefs = collectPrefs();
    showLoading();
    var start;
    if (prefs.image) {
      // Fresh health check right before sending: if photo analysis was switched off
      // since page load, the image is never sent and the user is told how to proceed.
      start = checkPhotoServer().then(function () {
        if (!state.photoServer.vision) {
          var er = new Error('Photo matching was switched off, so your photo was not sent anywhere. Remove the photo and generate from your written choices instead.');
          er.code = 'NO_VISION';
          throw er;
        }
        return generateWithRetry(prefs, 'photo').then(function (p) { state.mode = 'photo'; return p; });
      });
    } else {
      start = resolveMode().then(function (mode) {
        return generateWithRetry(prefs, mode);
      });
    }
    start
      .then(function (pattern) {
        hideLoading();
        pattern.createdAt = new Date().toISOString();
        pattern.prefs = {
          craftType: prefs.craftType, skillLevel: prefs.skillLevel, size: prefs.size,
          yarnType: prefs.yarnType, yarnWeight: prefs.yarnWeight, yarnQuantity: prefs.yarnQuantity,
          projectType: prefs.projectType
        };
        pattern.mode = state.mode;
        pattern.hadPhoto = !!prefs.image;
        state.currentPattern = pattern;
        savePattern(pattern);
        renderResults(pattern);
        location.hash = '#/results';
      })
      .catch(function (err) {
        hideLoading();
        renderError(err);
        location.hash = '#/results';
      });
  });

  /* ---------------- render results ---------------- */
  function renderResults(p) {
    var root = $('#results-root');
    var demoNote = '';
    if (p.mode === 'photo') {
      demoNote = '<div class="demo-ribbon">Generated from your choices and your reference photo, analyzed by Google Gemini (free tier).</div>';
    }
    if (p.mode === 'direct') {
      demoNote = '<div class="demo-ribbon"><strong>Demo mode:</strong> this pattern was generated from your written choices ' +
        'using a free public AI service. Your photo stayed on your device and was not analyzed or uploaded.</div>';
    }
    root.innerHTML =
      demoNote +
      '<div class="card result-head">' +
        '<p class="eyebrow">Your pattern is ready</p>' +
        '<h1>' + esc(p.title) + '</h1>' +
        '<div class="badges">' +
          (p.craftType ? '<span class="badge craft">' + esc(p.craftType) + '</span>' : '') +
          (p.difficulty ? '<span class="badge level">' + esc(p.difficulty) + '</span>' : '') +
          (p.prefs && p.prefs.size ? '<span class="badge">Size: ' + esc(p.prefs.size) + '</span>' : '') +
          (p.prefs && p.prefs.projectType ? '<span class="badge">' + esc(p.prefs.projectType) + '</span>' : '') +
        '</div>' +
        (p.summary ? '<p class="result-summary">' + esc(p.summary) + '</p>' : '') +
        '<div class="result-actions">' +
          '<button class="btn btn-primary" id="pdf-btn">Download PDF</button>' +
          '<a class="btn btn-ghost" href="#/create">Create Another Pattern</a>' +
        '</div>' +
      '</div>' +

      section('Materials', listHtml(p.materials)) +
      section('Tools', listHtml(p.tools)) +

      (p.assumptions.length ?
        '<div class="card result-section"><h2><span class="dot"></span>What we assumed' +
        (p.hadPhoto && p.mode === 'server' ? ' from your photo' : '') + '</h2>' +
        '<div class="callout"><ul>' + p.assumptions.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') +
        '</ul></div></div>' : '') +

      '<div class="card result-section"><h2><span class="dot"></span>Step by step</h2>' +
        p.steps.map(function (s, i) {
          return '<div class="step-item"><div class="n">' + (i + 1) + '</div><div>' +
                 '<h3>' + esc(s.title) + '</h3><p>' + esc(s.detail) + '</p></div></div>';
        }).join('') +
      '</div>' +

      (p.stitches.length ?
        '<div class="card result-section"><h2><span class="dot"></span>Stitch guide</h2>' +
        '<div class="stitch-grid">' +
          p.stitches.map(function (s) {
            return '<div class="stitch"><strong>' + esc(s.term) + '</strong> - ' + esc(s.explanation) + '</div>';
          }).join('') +
        '</div></div>' : '') +

      (p.tips.length ?
        '<div class="card result-section"><h2><span class="dot"></span>Beginner tips</h2>' +
        '<ul class="tip-list">' + p.tips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') +
        '</ul></div>' : '') +

      '<div class="card result-section">' +
        '<div class="callout warn"><strong>Before you start: make a swatch</strong>' +
        'Cast on a small square with scrap yarn first to check your tension and practice the stitches. ' +
        'It takes twenty minutes and saves the whole project.</div>' +
      '</div>' +

      '<p class="disclaimer">This pattern was generated by AI and may contain errors. ' +
      'Check stitch counts as you go, and when in doubt, trust your swatch.</p>';

    $('#pdf-btn').addEventListener('click', function () { downloadPdf(p); });

    function section(title, inner) {
      return '<div class="card result-section"><h2><span class="dot"></span>' + title + '</h2>' +
             '<ul class="mat-list two-col">' + inner + '</ul></div>';
    }
    function listHtml(items) {
      return items.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('');
    }
  }

  /* ---------------- render error ---------------- */
  function renderError(err) {
    var root = $('#results-root');
    var configBlock = '';
    if (err.code === 'NO_PROVIDER' && err.config) {
      configBlock =
        '<p>To enable real AI generation on this server, set one of these environment variables and restart:</p>' +
        '<code>' + esc(err.config) + '</code>';
    }
    root.innerHTML =
      '<div class="card error-panel">' +
        '<h1>' + (err.code === 'NO_PROVIDER' ? 'AI is not configured yet' : 'Something went wrong') + '</h1>' +
        '<p>' + esc(err.message || 'The pattern could not be generated. Please try again.') + '</p>' +
        configBlock +
        '<a class="btn btn-primary" href="#/create">Back to the form</a>' +
      '</div>';
  }

  /* ---------------- session storage ---------------- */
  function loadPatterns() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
    catch (e) { return []; }
  }
  function savePattern(p) {
    var list = loadPatterns();
    p.id = 'pat-' + Date.now();
    list.unshift(p);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 20))); } catch (e) {}
  }
  function renderPatternsList() {
    var list = loadPatterns();
    var root = $('#patterns-list');
    if (!list.length) {
      root.innerHTML = '<div class="card empty-state"><p>No patterns yet this session.</p>' +
        '<a class="btn btn-primary" href="#/create">Create your first pattern</a></div>';
      return;
    }
    root.innerHTML = '';
    list.forEach(function (p) {
      var row = el('div', 'card pattern-row');
      row.innerHTML =
        '<div class="swatch" aria-hidden="true">' + (p.craftType === 'Crochet'
          ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#5b6b53" stroke-width="1.8" stroke-linecap="round"><path d="M6 20c5-1 9-5 10-10l1-3a2.5 2.5 0 1 0-2-2l-3 1c-5 1-9 5-10 10"/><path d="M16 10l1-3a2.5 2.5 0 1 0-2-2"/></svg>'
          : '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#b3572e" stroke-width="1.8" stroke-linecap="round"><circle cx="9" cy="14" r="6"/><path d="M4.5 11.5c3-1.5 6.5-1.5 9.5 0M4 14.5c3.3-1.7 7-1.7 10 0M6 18c2.5-1 5.5-1 7.5-.3"/><path d="M14 9l7-6M17 11l4-3"/></svg>') + '</div>' +
        '<div class="meta"><h3>' + esc(p.title) + '</h3>' +
        '<p>' + esc([p.craftType, p.difficulty, p.prefs && p.prefs.size].filter(Boolean).join(' \u00B7 ')) + '</p></div>' +
        '<button class="del" title="Delete">Delete</button>';
      row.addEventListener('click', function (e) {
        if (e.target.closest('.del')) {
          var rest = loadPatterns().filter(function (x) { return x.id !== p.id; });
          try { localStorage.setItem(STORE_KEY, JSON.stringify(rest)); } catch (err) {}
          renderPatternsList();
          return;
        }
        state.currentPattern = p;
        renderResults(p);
        location.hash = '#/results';
      });
      root.appendChild(row);
    });
  }

  /* ---------------- export / import (manual device transfer) ---------------- */
  function exportPatterns() {
    var list = loadPatterns();
    if (!list.length) { alert('No saved patterns to download yet.'); return; }
    var payload = {
      app: 'Thread',
      kind: 'thread-patterns-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      patterns: list
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'thread-patterns.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  function importPatterns(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(reader.result); }
      catch (e) { alert('That file is not valid JSON - nothing was imported.'); return; }
      var incoming = (data && data.kind === 'thread-patterns-export' && Array.isArray(data.patterns)) ? data.patterns : null;
      if (!incoming) { alert('That file does not look like a Thread patterns download - nothing was imported.'); return; }
      // Merge, never replace: every existing saved pattern stays untouched.
      // Imported patterns only fill free slots up to the 20-pattern library limit.
      var existing = loadPatterns();
      var before = existing.length;
      var seen = {};
      existing.forEach(function (p) { if (p && p.id) seen[p.id] = true; });
      var ARRAY_FIELDS = ['materials', 'tools', 'assumptions', 'steps', 'stitches', 'tips'];
      var candidates = [];
      var skipped = 0;
      incoming.forEach(function (p) {
        if (!p || typeof p !== 'object' || typeof p.title !== 'string') { skipped++; return; }
        if (p.id && seen[p.id]) { skipped++; return; }
        if (!p.id) p.id = 'pat-import-' + Date.now() + '-' + candidates.length;
        seen[p.id] = true;
        // Normalize so a hand-edited or partial file cannot break the results view.
        ARRAY_FIELDS.forEach(function (f) { if (!Array.isArray(p[f])) p[f] = []; });
        p.steps = p.steps.filter(function (s) { return s && typeof s === 'object'; });
        p.stitches = p.stitches.filter(function (s) { return s && typeof s === 'object'; });
        if (!p.prefs || typeof p.prefs !== 'object') p.prefs = {};
        candidates.push(p);
      });
      var slots = Math.max(0, 20 - before);
      var added = Math.min(candidates.length, slots);
      var overflow = candidates.length - added;
      var kept = existing.concat(candidates.slice(0, slots));
      try { localStorage.setItem(STORE_KEY, JSON.stringify(kept)); }
      catch (e) { alert('Browser storage is full - the import did not fit. Delete some patterns and try again.'); return; }
      renderPatternsList();
      var msg = 'Imported ' + added + ' pattern' + (added === 1 ? '' : 's') + '.';
      if (before) msg += ' Your ' + before + ' existing pattern' + (before === 1 ? ' was' : 's were') + ' kept untouched.';
      if (skipped) msg += ' Skipped ' + skipped + ' duplicate or unusable entr' + (skipped === 1 ? 'y' : 'ies') + '.';
      if (overflow) msg += ' The library holds 20, so ' + overflow + ' imported pattern' + (overflow === 1 ? '' : 's') + ' did not fit - download or delete patterns to make room, then import again.';
      alert(msg);
    };
    reader.readAsText(file);
  }

  var btnExport = $('#btn-export');
  var btnImport = $('#btn-import');
  var importFile = $('#import-file');
  if (btnExport) btnExport.addEventListener('click', exportPatterns);
  if (btnImport && importFile) {
    btnImport.addEventListener('click', function () { importFile.click(); });
    importFile.addEventListener('change', function () {
      if (importFile.files && importFile.files[0]) importPatterns(importFile.files[0]);
      importFile.value = '';
    });
  }

  /* ---------------- PDF export ---------------- */
  function downloadPdf(p) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      alert('The PDF library did not load. Check your connection and try again.');
      return;
    }
    var doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
    var W = doc.internal.pageSize.getWidth();
    var M = 56, y = 0, lineH = 15;
    var maxW = W - M * 2;

    function ensureSpace(need) {
      if (y + need > doc.internal.pageSize.getHeight() - M) { doc.addPage(); y = M; }
    }
    function heading(text, size) {
      ensureSpace(44);
      y += 14;
      doc.setFont('times', 'bold'); doc.setFontSize(size || 15); doc.setTextColor(61, 50, 41);
      doc.text(text, M, y); y += 10;
      doc.setDrawColor(138, 155, 126); doc.setLineWidth(1.4);
      doc.line(M, y, M + 60, y); y += 16;
    }
    function body(text, opts) {
      opts = opts || {};
      doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
      doc.setFontSize(opts.size || 10.5);
      doc.setTextColor(61, 50, 41);
      var lines = doc.splitTextToSize(text, maxW - (opts.indent || 0));
      lines.forEach(function (ln) {
        ensureSpace(lineH);
        doc.text(ln, M + (opts.indent || 0), y); y += lineH;
      });
    }
    function bullet(text) { body('\u2022  ' + text, { indent: 10 }); }

    // cover header
    y = M + 10;
    doc.setFont('times', 'bold'); doc.setFontSize(26); doc.setTextColor(169, 85, 58);
    doc.text('Thread', M, y); y += 30;
    doc.setFontSize(20); doc.setTextColor(61, 50, 41);
    doc.splitTextToSize(p.title, maxW).forEach(function (ln) { doc.text(ln, M, y); y += 26; });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(122, 106, 89);
    doc.text([p.craftType, p.difficulty, p.prefs && p.prefs.size ? 'Size ' + p.prefs.size : null]
      .filter(Boolean).join('  \u00B7  '), M, y); y += 24;
    if (p.summary) { body(p.summary); y += 6; }

    if (p.materials.length) { heading('Materials'); p.materials.forEach(bullet); }
    if (p.tools.length) { heading('Tools'); p.tools.forEach(bullet); }
    if (p.assumptions.length) { heading('Assumptions we made'); p.assumptions.forEach(bullet); }
    if (p.steps.length) {
      heading('Step by step');
      p.steps.forEach(function (s, i) {
        ensureSpace(40);
        body((i + 1) + '. ' + s.title, { bold: true });
        body(s.detail, { indent: 16 }); y += 6;
      });
    }
    if (p.stitches.length) {
      heading('Stitch guide');
      p.stitches.forEach(function (s) { body(s.term + ' - ' + s.explanation, { indent: 6 }); y += 3; });
    }
    if (p.tips.length) { heading('Beginner tips'); p.tips.forEach(bullet); }

    ensureSpace(70); y += 12;
    doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(122, 106, 89);
    doc.splitTextToSize(
      'Generated by Thread. AI-generated patterns may contain errors - make a scrap-yarn swatch first and check stitch counts as you go.',
      maxW).forEach(function (ln) { ensureSpace(13); doc.text(ln, M, y); y += 13; });

    doc.save(p.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() + '-pattern.pdf');
  }

  /* ---------------- boot ---------------- */
  route();
  checkPhotoServer();
  showStep(1);
  // Deep links, e.g. #/create?step=3 (also used to preview screens)
  var bootQ = new URLSearchParams(location.search);
  if (bootQ.get('loading') === '1') showLoading();
  var stepM = /[?&]step=(\d)/.exec(location.hash);
  if (stepM && location.hash.indexOf('#/create') === 0) showStep(Number(stepM[1]));
})();
