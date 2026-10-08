// chroma-key.js
/* global document, window */
// Background Remover view: holds a list of clips, each with its own background color,
// tolerance, trim and flip; shows a live keyed preview of the selected clip.
// Export logic lives in chroma-key-export.js, which reads clips and the keyer through
// window.ChromaKey (defined at the bottom of this file).
// Uses window.showToast (defined in color-extractor.js).
(function () {
  'use strict';

  const MAX_BYTES = 200 * 1024 * 1024;
  const PREVIEW_MAX_W = 960;

  const state = { clips: [], cur: -1, picking: false, previewMode: 'keyed', rafId: null, needAuto: false };

  const $ = id => document.getElementById(id);
  const addBtn = $('ckAddBtn'), clearBtn = $('ckClearBtn'), fileInput = $('ckFileInput');
  const clipList = $('ckClipList'), clipSettings = $('ckClipSettings');
  const stage = $('ckStage'), empty = $('ckEmpty'), editor = $('ckEditor');
  const video = $('ckVideo'), preview = $('ckPreview'), pickBanner = $('ckPickBanner');
  const playBtn = $('ckPlayBtn'), scrub = $('ckScrub'), timeEl = $('ckTime');
  const keySwatch = $('ckKeySwatch'), keyHex = $('ckKeyHex');
  const autoBtn = $('ckAutoBtn'), pickBtn = $('ckPickBtn');
  const tolIn = $('ckTolerance'), tolVal = $('ckToleranceVal');
  const softIn = $('ckSoftness'), softVal = $('ckSoftnessVal');
  const spillChk = $('ckSpill'), enclosedChk = $('ckEnclosed'), flipChk = $('ckFlip');
  const startIn = $('ckStart'), endIn = $('ckEnd'), startVal = $('ckStartVal'), endVal = $('ckEndVal');
  const setStartBtn = $('ckSetStart'), setEndBtn = $('ckSetEnd');
  const widthIn = $('ckWidth');

  const srcCv = document.createElement('canvas');
  const srcCx = srcCv.getContext('2d', { willReadFrequently: true });
  const outCx = preview.getContext('2d');

  // ---------- helpers ----------
  function fmtTime(s) {
    const m = Math.floor(s / 60);
    return m + ':' + (s - m * 60).toFixed(1).padStart(4, '0');
  }
  function fmtSize(bytes) {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }
  function toHex(c) { return '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join(''); }
  function fromHex(h) {
    const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
  }
  function clip() { return state.clips[state.cur] || null; }

  // Draws a video frame into a w×h box, fitted and centered, optionally mirrored.
  // Shared with export so preview and output match.
  function drawSource(cx, vid, w, h, flip) {
    cx.clearRect(0, 0, w, h);
    const s = Math.min(w / vid.videoWidth, h / vid.videoHeight);
    const dw = Math.round(vid.videoWidth * s), dh = Math.round(vid.videoHeight * s);
    const dx = Math.round((w - dw) / 2), dy = Math.round((h - dh) / 2);
    cx.save();
    if (flip) { cx.translate(w, 0); cx.scale(-1, 1); }
    cx.drawImage(vid, flip ? w - dx - dw : dx, dy, dw, dh);
    cx.restore();
  }

  // ---------- keying (shared with export) ----------
  let alphaBuf = null, reachBuf = null, queueBuf = null;

  // Keeps only background that connects to the frame edge. The flood travels through fully
  // keyed pixels only, so light colors on the subject (which are partly keyed) can't act as
  // a bridge into sealed areas such as highlights and eyes. Partly keyed pixels are kept
  // only within SOFT_REACH pixels of true background; the rest are restored to solid.
  const SOFT_REACH = 3;
  function restoreEnclosed(alpha, w, h) {
    const n = w * h;
    if (!reachBuf || reachBuf.length !== n) { reachBuf = new Uint8Array(n); queueBuf = new Int32Array(n); }
    const reach = reachBuf, queue = queueBuf;
    reach.fill(0);
    let qLen = 0;
    function visit(q, allow) {
      const i = queue[q], x = i % w;
      if (x > 0) allow(i - 1);
      if (x < w - 1) allow(i + 1);
      if (i >= w) allow(i - w);
      if (i + w < n) allow(i + w);
    }
    const hard = i => { if (!reach[i] && alpha[i] === 0) { reach[i] = 1; queue[qLen++] = i; } };
    for (let x = 0; x < w; x++) { hard(x); hard((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { hard(y * w); hard(y * w + w - 1); }
    for (let q = 0; q < qLen; q++) visit(q, hard);
    const soft = i => { if (!reach[i] && alpha[i] > 0 && alpha[i] < 255) { reach[i] = 1; queue[qLen++] = i; } };
    for (let d = 0, start = 0; d < SOFT_REACH; d++) {
      const end = qLen;
      for (let q = start; q < end; q++) visit(q, soft);
      start = end;
    }
    for (let i = 0; i < n; i++) if (!reach[i]) alpha[i] = 255;
  }

  // Writes keyed RGBA into `out` from source RGBA `src`. Alpha is 0..255 (soft edges).
  // `settings` is a clip object (key, tolerance, softness, spill, keepEnclosed).
  function keyFrame(src, out, settings, w, h) {
    const { r: kr, g: kg, b: kb } = settings.key;
    const tol = settings.tolerance * 441.67;
    const soft = Math.max(1, settings.softness * 441.67);
    const spill = settings.spill;
    const dom = kg > kr && kg > kb ? 'g' : (kb > kr && kb > kg ? 'b' : (kr > kg && kr > kb ? 'r' : null));
    const n = src.length / 4;
    if (!alphaBuf || alphaBuf.length !== n) alphaBuf = new Uint8Array(n);
    const alpha = alphaBuf;
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      if (src[i + 3] === 0) { alpha[p] = 0; continue; } // letterbox padding stays clear
      const dr = src[i] - kr, dg = src[i + 1] - kg, db = src[i + 2] - kb;
      const a = (Math.sqrt(dr * dr + dg * dg + db * db) - tol) / soft;
      alpha[p] = a <= 0 ? 0 : (a >= 1 ? 255 : Math.round(a * 255));
    }
    if (settings.keepEnclosed && w && h) restoreEnclosed(alpha, w, h);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      let r = src[i], g = src[i + 1], b = src[i + 2];
      const a = alpha[p];
      if (a > 0 && a < 255 && spill && dom) {
        if (dom === 'g') { const m = Math.max(r, b); if (g > m) g = m; }
        else if (dom === 'b') { const m = Math.max(r, g); if (b > m) b = m; }
        else { const m = Math.max(g, b); if (r > m) r = m; }
      }
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
    }
  }

  // ---------- clip list ----------
  addBtn.addEventListener('click', () => fileInput.click());
  empty.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  stage.addEventListener('dragover', e => { e.preventDefault(); empty.classList.add('dragover'); });
  stage.addEventListener('dragleave', () => empty.classList.remove('dragover'));
  stage.addEventListener('drop', e => {
    e.preventDefault(); empty.classList.remove('dragover');
    addFiles(e.dataTransfer.files);
  });
  clearBtn.addEventListener('click', () => {
    if (window.ChromaKey.busy()) { window.showToast('Wait for the export to finish or cancel it', 'error'); return; }
    if (!state.clips.length) return;
    state.clips.forEach(c => URL.revokeObjectURL(c.url));
    state.clips = []; state.cur = -1;
    showClip();
    window.showToast('All clips removed');
  });

  function addFiles(fileList) {
    if (window.ChromaKey.busy()) { window.showToast('Wait for the export to finish or cancel it', 'error'); return; }
    const files = Array.from(fileList).filter(f => f.type.startsWith('video/'));
    if (!files.length) { window.showToast('Drop a video file (MP4, WebM or MOV)', 'error'); return; }
    files.forEach(f => {
      if (f.size > MAX_BYTES) { window.showToast(f.name + ' is over 200 MB', 'error'); return; }
      loadClip(f);
    });
  }

  function loadClip(file) {
    const probe = document.createElement('video');
    probe.muted = true; probe.preload = 'metadata';
    const url = URL.createObjectURL(file);
    probe.onloadedmetadata = () => {
      const w = probe.videoWidth, h = probe.videoHeight, d = probe.duration;
      probe.removeAttribute('src'); probe.load();
      if (!w || !isFinite(d)) { URL.revokeObjectURL(url); window.showToast('Could not read ' + file.name, 'error'); return; }
      state.clips.push({
        name: file.name, url, w, h, duration: d, size: file.size,
        key: { r: 255, g: 255, b: 255 }, autoKey: true,
        tolerance: 0.25, softness: 0.10, spill: true, keepEnclosed: true, flip: false,
        start: 0, end: d
      });
      selectClip(state.clips.length - 1);
    };
    probe.onerror = () => { URL.revokeObjectURL(url); window.showToast('This browser cannot play ' + file.name, 'error'); };
    probe.src = url;
  }

  function renderClipList() {
    clipList.innerHTML = '';
    state.clips.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'ck-clip' + (i === state.cur ? ' active' : '');
      row.innerHTML =
        '<span class="ck-clip-idx">' + (i + 1) + '</span>' +
        '<div class="ck-clip-meta"><div class="ck-clip-name"></div><div class="ck-clip-sub"></div></div>' +
        '<div class="ck-clip-btns">' +
        '<button class="ck-clip-btn" data-act="up" title="Move up">&#9650;</button>' +
        '<button class="ck-clip-btn" data-act="down" title="Move down">&#9660;</button>' +
        '<button class="ck-clip-btn danger" data-act="remove" title="Remove">&#10005;</button></div>';
      row.querySelector('.ck-clip-name').textContent = c.name;
      row.querySelector('.ck-clip-name').title = c.name;
      row.querySelector('.ck-clip-sub').textContent =
        fmtTime(c.start) + ' – ' + fmtTime(c.end) + (c.flip ? ' · flipped' : '');
      row.addEventListener('click', () => selectClip(i));
      row.querySelectorAll('.ck-clip-btn').forEach(btn => btn.addEventListener('click', e => {
        e.stopPropagation(); clipAction(btn.dataset.act, i);
      }));
      clipList.appendChild(row);
    });
    clipList.hidden = !state.clips.length;
  }

  function clipAction(act, i) {
    if (window.ChromaKey.busy()) { window.showToast('Wait for the export to finish or cancel it', 'error'); return; }
    const clips = state.clips;
    if (act === 'remove') {
      URL.revokeObjectURL(clips[i].url);
      clips.splice(i, 1);
      if (!clips.length) { state.cur = -1; showClip(); return; }
      selectClip(Math.min(i, clips.length - 1), true);
      return;
    }
    const j = act === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= clips.length) return;
    [clips[i], clips[j]] = [clips[j], clips[i]];
    if (state.cur === i) state.cur = j; else if (state.cur === j) state.cur = i;
    renderClipList();
    window.ChromaKey.updateEstimate();
  }

  // ---------- selected clip ----------
  function selectClip(i, force) {
    if (i === state.cur && !force) return;
    stopLoop(); video.pause(); setPicking(false);
    state.cur = i;
    showClip();
  }

  // Loads the selected clip into the editor and its settings into the controls.
  function showClip() {
    const c = clip();
    renderClipList();
    editor.hidden = !c; clipSettings.hidden = !c; empty.hidden = !!c;
    if (!c) {
      video.removeAttribute('src'); video.load();
      widthIn.value = ''; widthIn.placeholder = 'Original';
      window.ChromaKey.clearResult(); window.ChromaKey.updateEstimate();
      return;
    }
    keySwatch.style.background = toHex(c.key); keyHex.value = toHex(c.key);
    tolIn.value = Math.round(c.tolerance * 100); tolVal.textContent = tolIn.value + '%';
    softIn.value = Math.round(c.softness * 100); softVal.textContent = softIn.value + '%';
    spillChk.checked = c.spill; enclosedChk.checked = c.keepEnclosed; flipChk.checked = c.flip;
    [startIn, endIn, scrub].forEach(r => { r.max = c.duration.toFixed(2); r.step = '0.05'; });
    startIn.value = c.start; endIn.value = c.end.toFixed(2); scrub.value = c.start;
    const scale = Math.min(1, PREVIEW_MAX_W / c.w);
    srcCv.width = preview.width = Math.round(c.w * scale);
    srcCv.height = preview.height = Math.round(c.h * scale);
    widthIn.placeholder = String(state.clips[0].w);
    if (!widthIn.value && state.clips.length === 1) widthIn.value = String(Math.min(c.w, 480));
    updateTrim();
    state.needAuto = c.autoKey;
    video.src = c.url;
    video.onloadedmetadata = () => { video.currentTime = Math.max(c.start, Math.min(0.05, c.duration / 2)); };
    video.onerror = () => window.showToast('This browser cannot play ' + c.name, 'error');
  }

  // ---------- key color ----------
  function setKey(col) {
    const c = clip(); if (!c) return;
    c.key = col; c.autoKey = false;
    keySwatch.style.background = toHex(col); keyHex.value = toHex(col);
    drawPreview();
  }
  keyHex.addEventListener('change', () => {
    const col = fromHex(keyHex.value);
    if (col) setKey(col); else if (clip()) { keyHex.value = toHex(clip().key); window.showToast('Enter a hex color like #00ff00', 'error'); }
  });

  // Samples the frame border and picks the most common color.
  function autoDetect() {
    const c = clip(); if (!c) return;
    drawSource(srcCx, video, srcCv.width, srcCv.height, c.flip);
    const w = srcCv.width, h = srcCv.height, d = srcCx.getImageData(0, 0, w, h).data;
    const counts = new Map();
    const inset = Math.max(2, Math.round(Math.min(w, h) * 0.02));
    function sample(x, y) {
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0) return;
      const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
      const e = counts.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2]; counts.set(k, e);
    }
    for (let x = inset; x < w - inset; x += 3) { sample(x, inset); sample(x, h - 1 - inset); }
    for (let y = inset; y < h - inset; y += 3) { sample(inset, y); sample(w - 1 - inset, y); }
    let best = null;
    counts.forEach(e => { if (!best || e.n > best.n) best = e; });
    if (best) setKey({ r: Math.round(best.r / best.n), g: Math.round(best.g / best.n), b: Math.round(best.b / best.n) });
  }
  autoBtn.addEventListener('click', () => { if (clip()) { autoDetect(); window.showToast('Background color detected'); } });

  pickBtn.addEventListener('click', () => setPicking(!state.picking));
  function setPicking(on) {
    state.picking = on;
    pickBtn.classList.toggle('active', on);
    preview.classList.toggle('picking', on);
    pickBanner.hidden = !on;
    if (on) { state.previewMode = 'original'; syncPreviewToggle(); drawPreview(); }
  }
  preview.addEventListener('click', e => {
    const c = clip();
    if (!state.picking || !c) return;
    const rect = preview.getBoundingClientRect();
    const scale = Math.min(rect.width / preview.width, rect.height / preview.height);
    const offX = (rect.width - preview.width * scale) / 2, offY = (rect.height - preview.height * scale) / 2;
    const x = Math.floor((e.clientX - rect.left - offX) / scale), y = Math.floor((e.clientY - rect.top - offY) / scale);
    if (x < 0 || y < 0 || x >= preview.width || y >= preview.height) return;
    drawSource(srcCx, video, srcCv.width, srcCv.height, c.flip);
    const p = srcCx.getImageData(x, y, 1, 1).data;
    setKey({ r: p[0], g: p[1], b: p[2] });
    setPicking(false);
    state.previewMode = 'keyed'; syncPreviewToggle(); drawPreview();
    window.showToast('Background color set to ' + toHex(c.key));
  });

  // ---------- preview ----------
  function drawPreview() {
    const c = clip();
    if (!c || video.readyState < 2) return;
    drawSource(srcCx, video, srcCv.width, srcCv.height, c.flip);
    if (state.previewMode === 'original') { outCx.clearRect(0, 0, preview.width, preview.height); outCx.drawImage(srcCv, 0, 0); return; }
    const img = srcCx.getImageData(0, 0, srcCv.width, srcCv.height);
    const out = outCx.createImageData(img.width, img.height);
    keyFrame(img.data, out.data, c, img.width, img.height);
    outCx.putImageData(out, 0, 0);
  }
  function loop() {
    const c = clip(); if (!c) return;
    drawPreview();
    scrub.value = video.currentTime.toFixed(2);
    timeEl.textContent = fmtTime(video.currentTime) + ' / ' + fmtTime(c.duration);
    if (video.currentTime >= c.end) { video.pause(); video.currentTime = c.start; }
    if (!video.paused) state.rafId = requestAnimationFrame(loop); else { playBtn.innerHTML = '&#9654;'; state.rafId = null; }
  }
  function stopLoop() { if (state.rafId) cancelAnimationFrame(state.rafId); state.rafId = null; }

  playBtn.addEventListener('click', () => {
    const c = clip(); if (!c) return;
    if (video.paused) {
      if (video.currentTime < c.start || video.currentTime >= c.end) video.currentTime = c.start;
      video.play(); playBtn.innerHTML = '&#10074;&#10074;'; stopLoop(); loop();
    } else { video.pause(); }
  });
  scrub.addEventListener('input', () => { video.pause(); video.currentTime = parseFloat(scrub.value); });
  video.addEventListener('seeked', () => {
    const c = clip(); if (!c) return;
    timeEl.textContent = fmtTime(video.currentTime) + ' / ' + fmtTime(c.duration);
    if (state.needAuto) { state.needAuto = false; autoDetect(); c.autoKey = true; }
    if (!c.loaded) { c.loaded = true; window.showToast(c.name + ' loaded'); }
    if (video.paused) drawPreview();
  });

  document.querySelectorAll('[data-ck-preview]').forEach(btn => {
    btn.addEventListener('click', () => { state.previewMode = btn.dataset.ckPreview; syncPreviewToggle(); drawPreview(); });
  });
  function syncPreviewToggle() {
    document.querySelectorAll('[data-ck-preview]').forEach(b => b.classList.toggle('active', b.dataset.ckPreview === state.previewMode));
  }

  // ---------- per-clip settings ----------
  tolIn.addEventListener('input', () => { const c = clip(); if (!c) return; c.tolerance = parseInt(tolIn.value, 10) / 100; tolVal.textContent = tolIn.value + '%'; drawPreview(); });
  softIn.addEventListener('input', () => { const c = clip(); if (!c) return; c.softness = parseInt(softIn.value, 10) / 100; softVal.textContent = softIn.value + '%'; drawPreview(); });
  spillChk.addEventListener('change', () => { const c = clip(); if (c) { c.spill = spillChk.checked; drawPreview(); } });
  enclosedChk.addEventListener('change', () => { const c = clip(); if (c) { c.keepEnclosed = enclosedChk.checked; drawPreview(); } });
  flipChk.addEventListener('change', () => { const c = clip(); if (c) { c.flip = flipChk.checked; renderClipList(); drawPreview(); } });

  function updateTrim() {
    const c = clip(); if (!c) return;
    let s = parseFloat(startIn.value) || 0, e = parseFloat(endIn.value) || 0;
    if (e < s) [s, e] = [e, s];
    c.start = s; c.end = e;
    startVal.textContent = fmtTime(parseFloat(startIn.value) || 0);
    endVal.textContent = fmtTime(parseFloat(endIn.value) || 0);
    renderClipList();
    window.ChromaKey.updateEstimate();
  }
  startIn.addEventListener('input', () => { video.pause(); video.currentTime = parseFloat(startIn.value) || 0; updateTrim(); });
  endIn.addEventListener('input', () => { video.pause(); video.currentTime = parseFloat(endIn.value) || 0; updateTrim(); });
  setStartBtn.addEventListener('click', () => { startIn.value = video.currentTime.toFixed(2); updateTrim(); });
  setEndBtn.addEventListener('click', () => { endIn.value = video.currentTime.toFixed(2); updateTrim(); });

  // Output size: width from the setting; height follows the first clip's aspect ratio.
  function outDims() {
    const first = state.clips[0]; if (!first) return { w: 0, h: 0 };
    let w = parseInt(widthIn.value, 10) || first.w;
    w = Math.max(16, Math.min(w, first.w));
    return { w, h: Math.max(1, Math.round(first.h * w / first.w)) };
  }

  // ---------- shared interface for chroma-key-export.js ----------
  window.ChromaKey = Object.assign(window.ChromaKey || {}, {
    state, keyFrame, drawSource, outDims, fmtSize, fmtTime,
    pauseVideo: () => { video.pause(); stopLoop(); playBtn.innerHTML = '&#9654;'; },
    busy: () => false, clearResult: () => {}, updateEstimate: () => {}
  });
})();
