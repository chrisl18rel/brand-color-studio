// chroma-key.js
/* global document, window */
// Background Remover view: loads a video, detects or picks the background color,
// and shows a live keyed preview. Export logic lives in chroma-key-export.js, which
// reads settings through window.ChromaKey (defined at the bottom of this file).
// Uses window.showToast (defined in color-extractor.js).
(function () {
  'use strict';

  const MAX_BYTES = 200 * 1024 * 1024;
  const PREVIEW_MAX_W = 960;

  const state = {
    srcUrl: null, srcName: '', vidW: 0, vidH: 0, duration: 0,
    key: { r: 0, g: 255, b: 0 },
    picking: false, previewMode: 'keyed', rafId: null, needAuto: false
  };

  const $ = id => document.getElementById(id);
  const addBtn = $('ckAddBtn'), clearBtn = $('ckClearBtn'), fileInput = $('ckFileInput');
  const fileCard = $('ckFileCard'), fileNameEl = $('ckFileName'), fileSubEl = $('ckFileSub');
  const stage = $('ckStage'), empty = $('ckEmpty'), editor = $('ckEditor');
  const video = $('ckVideo'), preview = $('ckPreview'), pickBanner = $('ckPickBanner');
  const playBtn = $('ckPlayBtn'), scrub = $('ckScrub'), timeEl = $('ckTime');
  const keySwatch = $('ckKeySwatch'), keyHex = $('ckKeyHex');
  const autoBtn = $('ckAutoBtn'), pickBtn = $('ckPickBtn');
  const tolIn = $('ckTolerance'), tolVal = $('ckToleranceVal');
  const softIn = $('ckSoftness'), softVal = $('ckSoftnessVal');
  const spillChk = $('ckSpill'), enclosedChk = $('ckEnclosed');
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

  // ---------- keying (shared with export) ----------
  let alphaBuf = null, reachBuf = null, queueBuf = null;

  // Keeps only background pixels that connect to the frame edge. Pixels that match the
  // background color but are sealed inside the subject (highlights, eyes) are restored.
  function restoreEnclosed(alpha, w, h) {
    const n = w * h;
    if (!reachBuf || reachBuf.length !== n) { reachBuf = new Uint8Array(n); queueBuf = new Int32Array(n); }
    const reach = reachBuf, queue = queueBuf;
    reach.fill(0);
    let qLen = 0;
    function push(i) { if (!reach[i] && alpha[i] < 255) { reach[i] = 1; queue[qLen++] = i; } }
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    for (let q = 0; q < qLen; q++) {
      const i = queue[q], x = i % w;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (i >= w) push(i - w);
      if (i + w < n) push(i + w);
    }
    for (let i = 0; i < n; i++) if (!reach[i]) alpha[i] = 255;
  }

  // Writes keyed RGBA into `out` from source RGBA `src`. Alpha is 0..255 (soft edges).
  // `w` and `h` are needed for the enclosed-area pass.
  function keyFrame(src, out, settings, w, h) {
    const { r: kr, g: kg, b: kb } = settings.key;
    const tol = settings.tolerance * 441.67;          // 0..1 of max RGB distance
    const soft = Math.max(1, settings.softness * 441.67);
    const spill = settings.spill;
    const dom = kg > kr && kg > kb ? 'g' : (kb > kr && kb > kg ? 'b' : (kr > kg && kr > kb ? 'r' : null));
    const n = src.length / 4;
    if (!alphaBuf || alphaBuf.length !== n) alphaBuf = new Uint8Array(n);
    const alpha = alphaBuf;

    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const dr = src[i] - kr, dg = src[i + 1] - kg, db = src[i + 2] - kb;
      let a = (Math.sqrt(dr * dr + dg * dg + db * db) - tol) / soft;
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

  function settings() {
    return {
      key: state.key,
      tolerance: parseInt(tolIn.value, 10) / 100,
      softness: parseInt(softIn.value, 10) / 100,
      spill: spillChk.checked,
      keepEnclosed: enclosedChk.checked
    };
  }

  // ---------- add / remove ----------
  addBtn.addEventListener('click', () => fileInput.click());
  empty.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); fileInput.value = ''; });
  stage.addEventListener('dragover', e => { e.preventDefault(); empty.classList.add('dragover'); });
  stage.addEventListener('dragleave', () => empty.classList.remove('dragover'));
  stage.addEventListener('drop', e => {
    e.preventDefault(); empty.classList.remove('dragover');
    const f = Array.from(e.dataTransfer.files).find(x => x.type.startsWith('video/'));
    if (f) loadFile(f); else window.showToast('Drop a video file (MP4, WebM or MOV)', 'error');
  });
  clearBtn.addEventListener('click', () => {
    if (window.ChromaKey.busy()) { window.showToast('Wait for the export to finish or cancel it', 'error'); return; }
    if (!state.srcUrl) return;
    reset(); window.showToast('Video removed');
  });

  function reset() {
    stopLoop(); video.pause();
    if (state.srcUrl) URL.revokeObjectURL(state.srcUrl);
    state.srcUrl = null; state.srcName = ''; state.vidW = state.vidH = state.duration = 0;
    video.removeAttribute('src'); video.load();
    fileCard.hidden = true; editor.hidden = true; empty.hidden = false;
    widthIn.value = ''; widthIn.placeholder = 'Original';
    window.ChromaKey.clearResult();
    window.ChromaKey.updateEstimate();
  }

  function loadFile(file) {
    if (window.ChromaKey.busy()) { window.showToast('Wait for the export to finish or cancel it', 'error'); return; }
    if (!file.type.startsWith('video/')) { window.showToast('That file is not a video', 'error'); return; }
    if (file.size > MAX_BYTES) { window.showToast(file.name + ' is over 200 MB', 'error'); return; }
    stopLoop();
    if (state.srcUrl) URL.revokeObjectURL(state.srcUrl);
    window.ChromaKey.clearResult();
    state.srcUrl = URL.createObjectURL(file); state.srcName = file.name;
    video.src = state.srcUrl;
    video.onloadedmetadata = () => {
      state.vidW = video.videoWidth; state.vidH = video.videoHeight; state.duration = video.duration;
      if (!state.vidW || !isFinite(state.duration)) { window.showToast('Could not read this video', 'error'); reset(); return; }
      fileNameEl.textContent = file.name; fileNameEl.title = file.name;
      fileSubEl.textContent = state.vidW + ' × ' + state.vidH + ' · ' + fmtTime(state.duration) + ' · ' + fmtSize(file.size);
      fileCard.hidden = false; empty.hidden = true; editor.hidden = false;
      const scale = Math.min(1, PREVIEW_MAX_W / state.vidW);
      srcCv.width = preview.width = Math.round(state.vidW * scale);
      srcCv.height = preview.height = Math.round(state.vidH * scale);
      widthIn.placeholder = String(state.vidW);
      widthIn.value = String(Math.min(state.vidW, 480));
      [startIn, endIn, scrub].forEach(r => { r.max = state.duration.toFixed(2); r.step = '0.05'; });
      startIn.value = 0; endIn.value = state.duration.toFixed(2); scrub.value = 0;
      updateTrim();
      state.needAuto = true;
      video.currentTime = Math.min(0.05, state.duration / 2); // forces the first frame to decode
    };
    video.onerror = () => { window.showToast('This browser cannot play that video format', 'error'); reset(); };
  }

  // ---------- key color ----------
  function setKey(c) {
    state.key = c;
    keySwatch.style.background = toHex(c);
    keyHex.value = toHex(c);
    drawPreview();
  }
  keyHex.addEventListener('change', () => {
    const c = fromHex(keyHex.value);
    if (c) setKey(c); else { keyHex.value = toHex(state.key); window.showToast('Enter a hex color like #00ff00', 'error'); }
  });

  // Samples the frame border and picks the most common color.
  function autoDetect() {
    srcCx.drawImage(video, 0, 0, srcCv.width, srcCv.height);
    const w = srcCv.width, h = srcCv.height, d = srcCx.getImageData(0, 0, w, h).data;
    const counts = new Map();
    const inset = Math.max(2, Math.round(Math.min(w, h) * 0.02));
    function sample(x, y) {
      const i = (y * w + x) * 4;
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
  autoBtn.addEventListener('click', () => { if (state.srcUrl) { autoDetect(); window.showToast('Background color detected'); } });

  pickBtn.addEventListener('click', () => setPicking(!state.picking));
  function setPicking(on) {
    state.picking = on;
    pickBtn.classList.toggle('active', on);
    preview.classList.toggle('picking', on);
    pickBanner.hidden = !on;
    if (on) { state.previewMode = 'original'; syncPreviewToggle(); drawPreview(); }
  }
  preview.addEventListener('click', e => {
    if (!state.picking || !state.srcUrl) return;
    const rect = preview.getBoundingClientRect();
    const scale = Math.min(rect.width / preview.width, rect.height / preview.height);
    const offX = (rect.width - preview.width * scale) / 2, offY = (rect.height - preview.height * scale) / 2;
    const x = Math.floor((e.clientX - rect.left - offX) / scale), y = Math.floor((e.clientY - rect.top - offY) / scale);
    if (x < 0 || y < 0 || x >= preview.width || y >= preview.height) return;
    srcCx.drawImage(video, 0, 0, srcCv.width, srcCv.height);
    const p = srcCx.getImageData(x, y, 1, 1).data;
    setKey({ r: p[0], g: p[1], b: p[2] });
    setPicking(false);
    state.previewMode = 'keyed'; syncPreviewToggle(); drawPreview();
    window.showToast('Background color set to ' + toHex(state.key));
  });

  // ---------- preview ----------
  function drawPreview() {
    if (!state.srcUrl || video.readyState < 2) return;
    srcCx.drawImage(video, 0, 0, srcCv.width, srcCv.height);
    if (state.previewMode === 'original') { outCx.drawImage(srcCv, 0, 0); return; }
    const img = srcCx.getImageData(0, 0, srcCv.width, srcCv.height);
    const out = outCx.createImageData(img.width, img.height);
    keyFrame(img.data, out.data, settings(), img.width, img.height);
    outCx.putImageData(out, 0, 0);
  }
  function loop() {
    drawPreview();
    scrub.value = video.currentTime.toFixed(2);
    timeEl.textContent = fmtTime(video.currentTime) + ' / ' + fmtTime(state.duration);
    const e = parseFloat(endIn.value);
    if (video.currentTime >= e) { video.pause(); video.currentTime = parseFloat(startIn.value) || 0; }
    if (!video.paused) state.rafId = requestAnimationFrame(loop); else { playBtn.innerHTML = '&#9654;'; state.rafId = null; }
  }
  function stopLoop() { if (state.rafId) cancelAnimationFrame(state.rafId); state.rafId = null; }

  playBtn.addEventListener('click', () => {
    if (!state.srcUrl) return;
    if (video.paused) {
      const s = parseFloat(startIn.value) || 0, e = parseFloat(endIn.value);
      if (video.currentTime < s || video.currentTime >= e) video.currentTime = s;
      video.play(); playBtn.innerHTML = '&#10074;&#10074;'; stopLoop(); loop();
    } else { video.pause(); }
  });
  scrub.addEventListener('input', () => { video.pause(); video.currentTime = parseFloat(scrub.value); });
  video.addEventListener('seeked', () => {
    timeEl.textContent = fmtTime(video.currentTime) + ' / ' + fmtTime(state.duration);
    if (state.needAuto) { state.needAuto = false; autoDetect(); window.showToast('Video loaded'); }
    if (video.paused) drawPreview();
  });

  document.querySelectorAll('[data-ck-preview]').forEach(btn => {
    btn.addEventListener('click', () => { state.previewMode = btn.dataset.ckPreview; syncPreviewToggle(); drawPreview(); });
  });
  function syncPreviewToggle() {
    document.querySelectorAll('[data-ck-preview]').forEach(b => b.classList.toggle('active', b.dataset.ckPreview === state.previewMode));
  }

  // ---------- settings ----------
  tolIn.addEventListener('input', () => { tolVal.textContent = tolIn.value + '%'; drawPreview(); });
  softIn.addEventListener('input', () => { softVal.textContent = softIn.value + '%'; drawPreview(); });
  spillChk.addEventListener('change', drawPreview);
  enclosedChk.addEventListener('change', drawPreview);

  function getTrim() {
    let s = parseFloat(startIn.value) || 0, e = parseFloat(endIn.value) || 0;
    if (e < s) [s, e] = [e, s];
    return { s, e };
  }
  function updateTrim() {
    startVal.textContent = fmtTime(parseFloat(startIn.value) || 0);
    endVal.textContent = fmtTime(parseFloat(endIn.value) || 0);
    window.ChromaKey.updateEstimate();
  }
  startIn.addEventListener('input', () => { video.pause(); video.currentTime = parseFloat(startIn.value) || 0; updateTrim(); });
  endIn.addEventListener('input', () => { video.pause(); video.currentTime = parseFloat(endIn.value) || 0; updateTrim(); });
  setStartBtn.addEventListener('click', () => { startIn.value = video.currentTime.toFixed(2); updateTrim(); });
  setEndBtn.addEventListener('click', () => { endIn.value = video.currentTime.toFixed(2); updateTrim(); });

  function outDims() {
    let w = parseInt(widthIn.value, 10) || state.vidW;
    w = Math.max(16, Math.min(w, state.vidW || w));
    return { w, h: Math.max(1, Math.round(state.vidH * w / state.vidW)) };
  }

  // ---------- shared interface for chroma-key-export.js ----------
  window.ChromaKey = Object.assign(window.ChromaKey || {}, {
    state, keyFrame, settings, getTrim, outDims, fmtSize, fmtTime,
    pauseVideo: () => { video.pause(); stopLoop(); playBtn.innerHTML = '&#9654;'; },
    busy: () => false, clearResult: () => {}, updateEstimate: () => {}
  });
})();
