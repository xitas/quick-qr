/* ============================================================
   Quick QR — app.js
   Uses the qrcode-generator library (global `qrcode`) only to compute
   the QR module grid. All drawing (canvas + SVG) is done here so colors,
   size and quiet zone are fully under our control.
   ============================================================ */
(() => {
  'use strict';

  /* ------------------------------------------------------------
   * 1. Config & small helpers
   * ------------------------------------------------------------ */
  const STORAGE_THEME = 'quickqr-theme';
  const STORAGE_HISTORY = 'quickqr-history';
  const HISTORY_LIMIT = 10;
  const INPUT_DEBOUNCE_MS = 300;   // live preview delay while typing
  const HISTORY_IDLE_MS = 1500;    // wait this long after a valid render before saving to history
  const QUIET_ZONE = 4;            // blank modules around the code (QR spec minimum)
  const THUMB_SIZE = 128;          // history thumbnail resolution (shown at 64px)

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function debounce(fn, ms) {
    let timer;
    const debounced = (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
    debounced.cancel = () => clearTimeout(timer);
    return debounced;
  }

  // localStorage can throw (private mode, blocked site data) — never let that break the app.
  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  };

  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  /* ------------------------------------------------------------
   * 2. DOM references & app state
   * ------------------------------------------------------------ */
  const els = {
    tabs: $$('[role="tab"]'),
    panels: $$('[role="tabpanel"]'),
    form: $('#qrForm'),
    message: $('#formMessage'),
    fg: $('#fgColor'),
    bg: $('#bgColor'),
    fgValue: $('#fgValue'),
    bgValue: $('#bgValue'),
    contrast: $('#contrastWarning'),
    size: $('#sizeRange'),
    sizeOut: $('#sizeOutput'),
    eclRadios: $$('input[name="ecl"]'),
    eclDesc: $('#eclDesc'),
    tipWrap: $('.tip-wrap'),
    canvas: $('#qrCanvas'),
    empty: $('#previewEmpty'),
    emptyText: $('#previewEmptyText'),
    sizeNote: $('#sizeNote'),
    btnPng: $('#downloadPng'),
    btnSvg: $('#downloadSvg'),
    btnCopy: $('#copyImage'),
    status: $('#actionStatus'),
    historyList: $('#historyList'),
    historyEmpty: $('#historyEmpty'),
    clearHistory: $('#clearHistory'),
    themeToggle: $('#themeToggle'),
    wifiSecurity: $('#wifi-security'),
    wifiPassword: $('#wifi-password'),
    togglePassword: $('#togglePassword'),
  };

  const state = {
    type: 'text',
    fg: '#000000',
    bg: '#ffffff',
    size: 512,
    ecl: 'M',
    current: null,   // last valid render: { qr, payload, summary, fields }
    draftId: null,   // history entry being refined by the current edit streak
  };

  let libReady = false;

  /* ------------------------------------------------------------
   * 3. Escaping & validation helpers
   * ------------------------------------------------------------ */

  // WiFi QR format (MECARD-style): \ ; , : " must be backslash-escaped.
  const escapeWifi = (s) => s.replace(/([\\;,:"])/g, '\\$1');

  // vCard 3.0 text values: escape \ , ; and encode newlines as \n.
  const escapeVCard = (s) =>
    s.replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\r\n|\r|\n/g, '\\n');

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/;

  // Returns an error message, or null if the phone number looks usable.
  function phoneError(raw) {
    if (!/^\+?[\d\s().-]+$/.test(raw)) {
      return 'Phone numbers can only contain digits, spaces, +, -, ( ) and dots.';
    }
    const digits = raw.replace(/\D/g, '').length;
    if (digits < 3) return 'That phone number looks too short.';
    if (digits > 15) return 'That phone number looks too long (15 digits max).';
    return null;
  }

  // Normalise to a tel: friendly form: keep a leading + and digits only.
  const normalisePhone = (raw) => (raw.trim().startsWith('+') ? '+' : '') + raw.replace(/\D/g, '');

  // Only strings that clearly try to be links are validated as URLs; anything else is plain text.
  function urlError(value) {
    if (/\s/.test(value)) return 'URLs can’t contain spaces. Check for a stray space or line break.';
    const candidate = /^www\./i.test(value) ? 'https://' + value : value;
    let url;
    try { url = new URL(candidate); } catch { url = null; }
    const host = url && url.hostname;
    const hostOk = host && (host === 'localhost' || (/\./.test(host) && !/^\.|\.$|\.\./.test(host)));
    if (!hostOk) return 'That URL doesn’t look quite right. Try something like https://example.com';
    return null;
  }

  // Result constructors used by every type builder.
  const ok = (payload, summary, hint = '') => ({ status: 'ok', payload, summary, hint });
  const empty = (field, message) => ({ status: 'empty', field, message });
  const invalid = (field, message) => ({ status: 'invalid', field, message });

  /* ------------------------------------------------------------
   * 4. QR types: each turns form fields into a QR payload string
   * ------------------------------------------------------------ */
  const TYPES = {
    text: {
      label: 'Text / URL',
      build(f) {
        const value = f.content.trim();
        if (!value) return empty('content', 'Type some text or paste a link to get started.');

        if (/^(https?:\/\/|www\.)/i.test(value)) {
          const err = urlError(value);
          if (err) return invalid('content', err);
        }

        let hint = '';
        if (/^www\./i.test(value) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(value)) {
          hint = 'Tip: start the link with https:// so every scanner opens it as a website.';
        }
        return ok(value, truncate(value.replace(/^https?:\/\//i, ''), 80), hint);
      },
    },

    wifi: {
      label: 'WiFi',
      build(f) {
        if (!f.ssid.trim()) return empty('ssid', 'Enter your network name (SSID).');
        const secured = f.security !== 'nopass';
        if (secured && !f.password) {
          return empty('password', 'Enter the WiFi password, or set security to “None”.');
        }
        if (f.security === 'WPA') {
          const len = f.password.length;
          const isHexKey = len === 64 && /^[0-9a-f]+$/i.test(f.password);
          if ((len < 8 || len > 63) && !isHexKey) {
            return invalid('password', 'WPA passwords are 8 to 63 characters long.');
          }
        }
        let payload = `WIFI:T:${f.security};S:${escapeWifi(f.ssid)};`;
        if (secured) payload += `P:${escapeWifi(f.password)};`;
        if (f.hidden) payload += 'H:true;';
        payload += ';';
        return ok(payload, truncate(f.ssid, 80));
      },
    },

    phone: {
      label: 'Phone',
      build(f) {
        const raw = f.phone.trim();
        if (!raw) return empty('phone', 'Enter a phone number, including the country code if you can.');
        const err = phoneError(raw);
        if (err) return invalid('phone', err);
        return ok('tel:' + normalisePhone(raw), raw);
      },
    },

    email: {
      label: 'Email',
      build(f) {
        const address = f.email.trim();
        if (!address) return empty('email', 'Enter the email address messages should go to.');
        if (!EMAIL_RE.test(address)) return invalid('email', 'That email address doesn’t look right, e.g. name@example.com');
        const params = [];
        if (f.subject.trim()) params.push('subject=' + encodeURIComponent(f.subject.trim()));
        if (f.body.trim()) params.push('body=' + encodeURIComponent(f.body.trim()));
        return ok(`mailto:${address}${params.length ? '?' + params.join('&') : ''}`, address);
      },
    },

    vcard: {
      label: 'Contact',
      build(f) {
        const first = f.first.trim();
        const last = f.last.trim();
        if (!first && !last) return empty('first', 'Enter at least a first or last name.');
        const phone = f.phone.trim();
        if (phone) {
          const err = phoneError(phone);
          if (err) return invalid('phone', err);
        }
        const email = f.email.trim();
        if (email && !EMAIL_RE.test(email)) {
          return invalid('email', 'That email address doesn’t look right, e.g. name@example.com');
        }
        const fullName = [first, last].filter(Boolean).join(' ');
        const lines = [
          'BEGIN:VCARD',
          'VERSION:3.0',
          `N:${escapeVCard(last)};${escapeVCard(first)};;;`,
          `FN:${escapeVCard(fullName)}`,
        ];
        if (f.company.trim()) lines.push(`ORG:${escapeVCard(f.company.trim())}`);
        if (phone) lines.push(`TEL;TYPE=CELL:${normalisePhone(phone)}`);
        if (email) lines.push(`EMAIL:${email}`);
        lines.push('END:VCARD');
        return ok(lines.join('\r\n'), truncate(fullName, 80));
      },
    },
  };

  /* ------------------------------------------------------------
   * 5. QR rendering (canvas + SVG)
   * ------------------------------------------------------------ */

  // Build the module matrix. typeNumber 0 = smallest version that fits.
  // Throws if the data is too long for any QR version.
  function createQr(payload, ecl) {
    const qr = qrcode(0, ecl);
    qr.addData(payload, 'Byte');
    qr.make();
    return qr;
  }

  // Draw onto a canvas at exact pixel size. Module edges are rounded to whole
  // pixels so there are no hairline gaps between modules at any size.
  function drawToCanvas(canvas, qr, size, fg, bg) {
    const count = qr.getModuleCount();
    const cell = size / (count + QUIET_ZONE * 2);
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = fg;
    for (let r = 0; r < count; r++) {
      const y0 = Math.round((r + QUIET_ZONE) * cell);
      const y1 = Math.round((r + QUIET_ZONE + 1) * cell);
      for (let c = 0; c < count; c++) {
        if (!qr.isDark(r, c)) continue;
        const x0 = Math.round((c + QUIET_ZONE) * cell);
        const x1 = Math.round((c + QUIET_ZONE + 1) * cell);
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
  }

  // Vector version: one <path> of 1×1 squares in module units, scaled by viewBox.
  function buildSvg(qr, size, fg, bg) {
    const count = qr.getModuleCount();
    const total = count + QUIET_ZONE * 2;
    let d = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) d += `M${c + QUIET_ZONE} ${r + QUIET_ZONE}h1v1h-1z`;
      }
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
      `<rect width="${total}" height="${total}" fill="${bg}"/>` +
      `<path d="${d}" fill="${fg}"/></svg>\n`;
  }

  /* ------------------------------------------------------------
   * 6. Color contrast check
   * ------------------------------------------------------------ */
  function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrastRatio(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  function updateContrastWarning() {
    const ratio = contrastRatio(state.fg, state.bg);
    const inverted = luminance(state.fg) > luminance(state.bg);
    const parts = [];
    if (ratio < 3) {
      parts.push(`Contrast is very low (${ratio.toFixed(1)}:1), so most scanners won’t read this. Use a darker foreground or a lighter background.`);
    } else if (ratio < 4.5) {
      parts.push(`Contrast is on the low side (${ratio.toFixed(1)}:1), so some phones may struggle. Aim for 4.5:1 or more.`);
    }
    if (inverted) {
      parts.push('Light-on-dark codes don’t work with every scanner app. Dark on light is the safest choice.');
    }
    els.contrast.textContent = parts.join(' ');
  }

  /* ------------------------------------------------------------
   * 7. Form reading/writing & inline messages
   * ------------------------------------------------------------ */
  const panelFor = (type) => els.panels.find((p) => p.dataset.type === type);

  function readFields(type) {
    const fields = {};
    $$('[name]', panelFor(type)).forEach((el) => {
      fields[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return fields;
  }

  function writeFields(type, fields) {
    $$('[name]', panelFor(type)).forEach((el) => {
      if (el.type === 'checkbox') el.checked = !!fields[el.name];
      else if (fields[el.name] != null) el.value = fields[el.name];
      else if (el.tagName !== 'SELECT') el.value = '';
    });
    syncWifiSecurity();
  }

  function showFormMessage(res) {
    $$('[aria-invalid]', els.form).forEach((el) => {
      el.removeAttribute('aria-invalid');
      el.removeAttribute('aria-describedby');
    });

    if (res.status === 'ok') {
      els.message.textContent = res.hint || '';
      els.message.dataset.kind = res.hint ? 'hint' : '';
      return;
    }
    els.message.textContent = res.message;
    els.message.dataset.kind = res.status === 'invalid' ? 'error' : 'info';

    const field = res.field && $(`[name="${res.field}"]`, panelFor(state.type));
    if (field && res.status === 'invalid') {
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', 'formMessage');
    }
  }

  // Password field is irrelevant for open networks.
  function syncWifiSecurity() {
    const open = els.wifiSecurity.value === 'nopass';
    els.wifiPassword.disabled = open;
    els.togglePassword.disabled = open;
  }

  /* ------------------------------------------------------------
   * 8. Live preview: validate → build → draw
   * ------------------------------------------------------------ */
  function setActionsEnabled(enabled) {
    [els.btnPng, els.btnSvg, els.btnCopy].forEach((b) => { b.disabled = !enabled; });
  }

  function render({ fromHistory = false } = {}) {
    if (!libReady) return;
    const fields = readFields(state.type);
    let res = TYPES[state.type].build(fields);
    let qr = null;

    if (res.status === 'ok') {
      try {
        qr = createQr(res.payload, state.ecl);
      } catch {
        res = invalid(null, 'That’s too much data for one QR code. Shorten it, or choose a lower error-correction level.');
      }
    }

    showFormMessage(res);
    setActionsEnabled(!!qr);
    els.canvas.hidden = !qr;
    els.empty.hidden = !!qr;

    if (!qr) {
      state.current = null;
      state.draftId = null;
      saveHistoryLater.cancel();
      els.emptyText.textContent = res.status === 'invalid'
        ? 'Fix the highlighted input to see your code'
        : 'Your QR code will appear here';
      els.sizeNote.textContent = '';
      return;
    }

    drawToCanvas(els.canvas, qr, state.size, state.fg, state.bg);
    els.canvas.classList.toggle('upscaled', state.size < 320);
    els.canvas.setAttribute('aria-label', `QR code for ${TYPES[state.type].label}: ${res.summary}`);
    const n = qr.getModuleCount();
    els.sizeNote.textContent = `${state.size} × ${state.size} px · ${n} × ${n} modules`;
    state.current = { qr, payload: res.payload, summary: res.summary, fields };

    if (!fromHistory) saveHistoryLater();
  }

  const renderDebounced = debounce(render, INPUT_DEBOUNCE_MS);

  /* ------------------------------------------------------------
   * 9. Type tabs (click + arrow-key navigation)
   * ------------------------------------------------------------ */
  function selectType(type, { focus = false } = {}) {
    els.tabs.forEach((tab) => {
      const selected = tab.dataset.type === type;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
      if (selected) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    els.panels.forEach((panel) => { panel.hidden = panel.dataset.type !== type; });
    state.type = type;
    state.draftId = null;
    renderDebounced.cancel();
    render();
  }

  els.tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectType(tab.dataset.type));
    tab.addEventListener('keydown', (e) => {
      const n = els.tabs.length;
      const next = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      selectType(els.tabs[next].dataset.type, { focus: true });
    });
  });

  /* ------------------------------------------------------------
   * 10. Customization controls (colors, size, error correction)
   * ------------------------------------------------------------ */
  const ECL_INFO = {
    L: 'Low: recovers about 7% damage. Smallest code, fine for screens.',
    M: 'Medium: recovers about 15% damage. A good default.',
    Q: 'Quartile: recovers about 25% damage. Good for print that may get scuffed.',
    H: 'High: recovers about 30% damage. Best for rough surfaces or a logo overlay.',
  };

  function readCustomization() {
    state.fg = els.fg.value;
    state.bg = els.bg.value;
    state.size = Number(els.size.value);
    state.ecl = (els.eclRadios.find((r) => r.checked) || {}).value || 'M';
    els.fgValue.textContent = state.fg;
    els.bgValue.textContent = state.bg;
    els.sizeOut.textContent = `${state.size} px`;
    els.eclDesc.textContent = ECL_INFO[state.ecl];
    updateContrastWarning();
  }

  function writeCustomization({ fg, bg, size, ecl }) {
    els.fg.value = fg;
    els.bg.value = bg;
    els.size.value = size;
    els.eclRadios.forEach((r) => { r.checked = r.value === ecl; });
    readCustomization();
  }

  // Panel inputs are debounced (typing); appearance controls render immediately.
  function onFormChange(e) {
    if (e.target === els.wifiSecurity) syncWifiSecurity();
    if (e.target.closest('[role="tabpanel"]')) {
      renderDebounced();
    } else {
      readCustomization();
      render();
    }
  }
  els.form.addEventListener('input', onFormChange);
  els.form.addEventListener('change', onFormChange);
  els.form.addEventListener('submit', (e) => e.preventDefault());

  els.togglePassword.addEventListener('click', () => {
    const show = els.wifiPassword.type === 'password';
    els.wifiPassword.type = show ? 'text' : 'password';
    els.togglePassword.textContent = show ? 'Hide' : 'Show';
    els.togglePassword.setAttribute('aria-pressed', String(show));
  });

  // Let keyboard users dismiss the tooltip with Escape (WCAG 1.4.13).
  els.tipWrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') els.tipWrap.classList.add('dismissed');
  });
  ['mouseleave', 'focusout'].forEach((evt) =>
    els.tipWrap.addEventListener(evt, () => els.tipWrap.classList.remove('dismissed')));

  /* ------------------------------------------------------------
   * 11. Actions: download PNG / SVG, copy to clipboard
   * ------------------------------------------------------------ */
  let statusTimer;
  function announce(text, kind = 'ok') {
    els.status.textContent = text;
    els.status.dataset.kind = kind;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { els.status.textContent = ''; }, 3000);
  }

  function fileName(ext) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `qr-${state.type}-${stamp}.${ext}`;
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const canvasBlob = () => new Promise((resolve, reject) => {
    els.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create image'))), 'image/png');
  });

  els.btnPng.addEventListener('click', async () => {
    if (!state.current) return;
    try {
      downloadBlob(await canvasBlob(), fileName('png'));
      announce('PNG downloaded');
      commitHistory();
    } catch {
      announce('Couldn’t create the PNG. Please try again.', 'error');
    }
  });

  els.btnSvg.addEventListener('click', () => {
    if (!state.current) return;
    const svg = buildSvg(state.current.qr, state.size, state.fg, state.bg);
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), fileName('svg'));
    announce('SVG downloaded');
    commitHistory();
  });

  els.btnCopy.addEventListener('click', async () => {
    if (!state.current) return;
    if (!navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem === 'undefined') {
      announce('This browser can’t copy images. Use Download PNG instead.', 'error');
      return;
    }
    try {
      // Passing a Promise keeps Safari happy (it requires the write to start within the click).
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasBlob() })]);
      announce('Copied to clipboard');
      commitHistory();
    } catch {
      announce('Couldn’t copy. Your browser may have blocked clipboard access.', 'error');
    }
  });

  /* ------------------------------------------------------------
   * 12. Recent history (localStorage, last 10)
   *     A valid code is saved after a short idle period. While the user keeps
   *     editing the same code, the newest entry is updated in place (a "draft")
   *     instead of filling history with every keystroke. Switching type,
   *     clearing the input, downloading or copying starts a new entry.
   * ------------------------------------------------------------ */
  function loadHistory() {
    try {
      const list = JSON.parse(storage.get(STORAGE_HISTORY) || '[]');
      return Array.isArray(list)
        ? list.filter((e) => e && TYPES[e.type] && typeof e.thumb === 'string' && e.thumb.startsWith('data:image/png'))
        : [];
    } catch {
      return [];
    }
  }

  function saveHistoryNow() {
    const cur = state.current;
    if (!cur) return;

    const thumbCanvas = document.createElement('canvas');
    drawToCanvas(thumbCanvas, cur.qr, THUMB_SIZE, state.fg, state.bg);

    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      key: JSON.stringify([state.type, cur.payload, state.fg, state.bg, state.size, state.ecl]),
      type: state.type,
      fields: cur.fields,
      fg: state.fg,
      bg: state.bg,
      size: state.size,
      ecl: state.ecl,
      summary: cur.summary,
      thumb: thumbCanvas.toDataURL('image/png'),
    };

    // Drop exact duplicates and the in-progress draft, then put the new entry on top.
    const list = loadHistory().filter((e) => e.key !== entry.key && e.id !== state.draftId);
    list.unshift(entry);
    const trimmed = list.slice(0, HISTORY_LIMIT);
    storage.set(STORAGE_HISTORY, JSON.stringify(trimmed));
    state.draftId = entry.id;
    renderHistory(trimmed);
  }

  const saveHistoryLater = debounce(saveHistoryNow, HISTORY_IDLE_MS);

  // Save immediately and "lock" the entry so further edits start a new one.
  function commitHistory() {
    saveHistoryLater.cancel();
    saveHistoryNow();
    state.draftId = null;
  }

  function renderHistory(list = loadHistory()) {
    const items = list.map((entry) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'history-item';
      btn.title = `${TYPES[entry.type].label}: ${entry.summary}`;
      btn.setAttribute('aria-label', `Load ${TYPES[entry.type].label} code: ${entry.summary}`);

      const img = document.createElement('img');
      img.src = entry.thumb;
      img.alt = '';
      img.width = 64;
      img.height = 64;

      const label = document.createElement('span');
      label.className = 'history-label';
      label.textContent = entry.summary;

      btn.append(img, label);
      btn.addEventListener('click', () => loadEntry(entry));
      li.append(btn);
      return li;
    });
    els.historyList.replaceChildren(...items);
    els.historyEmpty.hidden = list.length > 0;
    els.clearHistory.disabled = list.length === 0;
  }

  function loadEntry(entry) {
    saveHistoryLater.cancel();
    els.panels.forEach((panel) => { panel.hidden = panel.dataset.type !== entry.type; });
    els.tabs.forEach((tab) => {
      const selected = tab.dataset.type === entry.type;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    state.type = entry.type;
    state.draftId = null;
    writeFields(entry.type, entry.fields || {});
    writeCustomization(entry);
    renderDebounced.cancel();
    render({ fromHistory: true });
    announce('Loaded from history');
  }

  els.clearHistory.addEventListener('click', () => {
    saveHistoryLater.cancel();
    storage.remove(STORAGE_HISTORY);
    state.draftId = null;
    renderHistory([]);
    announce('History cleared');
  });

  /* ------------------------------------------------------------
   * 13. Light / dark theme (remembers the user's choice)
   * ------------------------------------------------------------ */
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const effectiveTheme = () =>
    document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');

  function updateThemeButton() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    els.themeToggle.setAttribute('aria-label', `Switch to ${next} mode`);
    els.themeToggle.title = `Switch to ${next} mode`;
  }

  els.themeToggle.addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    storage.set(STORAGE_THEME, next);
    updateThemeButton();
  });
  darkQuery.addEventListener('change', updateThemeButton);

  /* ------------------------------------------------------------
   * 14. Init
   * ------------------------------------------------------------ */
  libReady = typeof window.qrcode === 'function';
  if (libReady) {
    // Encode text as UTF-8 so accents, emoji and non-Latin scripts scan correctly.
    qrcode.stringToBytes = (s) => Array.from(new TextEncoder().encode(s));
  } else {
    els.emptyText.textContent = 'Couldn’t load the QR library. Check your internet connection and reload.';
    setActionsEnabled(false);
  }

  updateThemeButton();
  readCustomization();
  syncWifiSecurity();
  renderHistory();
  render();
})();
