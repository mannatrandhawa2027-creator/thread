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
    imageDataUrl: null,   // downscaled data URL, or null
    mode: null,           // 'server' | 'direct'  (resolved once)
    currentPattern: null
  };

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
  var views = { home: 'view-home', create: 'view-create', results: 'view-results', patterns: 'view-patterns' };
  function route() {
    var hash = location.hash.replace(/^#\/?/, '') || 'home';
    if (!views[hash]) hash = 'home';
    Object.keys(views).forEach(function (k) {
      document.getElementById(views[k]).hidden = (k !== hash);
    });
    $all('.nav-links a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-nav') === hash);
    });
    if (hash === 'patterns') renderPatternsList();
    window.scrollTo({ top: 0 });
  }
  window.addEventListener('hashchange', route);

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

  /* ---------------- image upload ---------------- */
  var dropzone = $('#dropzone'), imageInput = $('#image-input');
  dropzone.addEventListener('click', function (e) {
    if (e.target.closest('.dz-actions')) return;
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
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readImage(f);
  });
  imageInput.addEventListener('change', function () {
    if (imageInput.files && imageInput.files[0]) readImage(imageInput.files[0]);
  });
  $('#remove-img').addEventListener('click', function () { setImage(null); });
  $('#replace-img').addEventListener('click', function () { imageInput.click(); });

  function readImage(file) {
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
  }

  /* ---------------- "I don't know" toggles ---------------- */
  $('#yarn-type-idk').addEventListener('change', function () {
    $('#yarn-type').disabled = this.checked;
    if (this.checked) { $('#yarn-type').value = ''; clearError('yarnType'); }
  });
  $('#yarn-qty-idk').addEventListener('change', function () {
    $('#yarn-qty').disabled = this.checked;
    if (this.checked) { $('#yarn-qty').value = ''; clearError('yarnQuantity'); }
  });

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

    var user = [
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
      if (!r.ok) throw new Error('The AI service returned an error (' + r.status + '). Please try again in a moment.');
      return r.json();
    }).then(function (j) {
      var text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!text || !text.trim()) {
        var err = new Error('The AI returned an empty response.');
        err.retryable = true;
        throw err;
      }
      return parsePatternJson(text);
    });
  }

  function generateWithRetry(prefs, mode, attempt) {
    attempt = attempt || 1;
    var run = mode === 'server' ? generateViaServer(prefs) : generateViaDirect(prefs);
    return run.catch(function (err) {
      var noProvider = err && err.code === 'NO_PROVIDER';
      if (attempt < 3 && !noProvider) {
        // the free endpoint allows ~1 request per 30s per IP - wait past that window
        var wait = attempt === 1 ? 5000 : 33000;
        return new Promise(function (res) { setTimeout(res, wait); })
          .then(function () { return generateWithRetry(prefs, mode, attempt + 1); });
      }
      if (err && err.retryable) err.message = 'The AI service is busy right now - please try again in a minute.';
      throw err;
    });
  }

  /* ---------------- loading overlay ---------------- */
  var loadTimer = null;
  var LOAD_MSGS = [
    'Reading your choices',
    'Sketching the construction',
    'Choosing stitches a beginner can love',
    'Counting rows and yardage',
    'Writing clear step-by-step instructions',
    'Adding stitch explanations'
  ];
  function showLoading() {
    var i = 0;
    $('#loading').hidden = false;
    $('#loading-msg').textContent = LOAD_MSGS[0];
    loadTimer = setInterval(function () {
      i = (i + 1) % LOAD_MSGS.length;
      $('#loading-msg').textContent = LOAD_MSGS[i];
    }, 2600);
  }
  function hideLoading() {
    $('#loading').hidden = true;
    if (loadTimer) { clearInterval(loadTimer); loadTimer = null; }
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
    resolveMode()
      .then(function (mode) {
        return generateWithRetry(prefs, mode);
      })
      .then(function (pattern) {
        hideLoading();
        pattern.createdAt = new Date().toISOString();
        pattern.prefs = {
          craftType: prefs.craftType, skillLevel: prefs.skillLevel, size: prefs.size,
          yarnType: prefs.yarnType, yarnWeight: prefs.yarnWeight, yarnQuantity: prefs.yarnQuantity
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
    if (p.mode === 'direct') {
      demoNote = '<div class="demo-ribbon"><strong>Demo mode:</strong> this pattern was generated from your written choices ' +
        'using a free public AI endpoint. Your photo was not analyzed - run the full Thread server with your own AI key (OpenAI, Anthropic or Gemini) ' +
        'to generate patterns that truly see your photo. Details in the project README.</div>';
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
        '<div class="swatch">' + (p.craftType === 'Crochet' ? '\u{1F9F6}' : '\u{1F9F5}') + '</div>' +
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
})();
