// gif-converter.js
/* global document, window */
// MP4 to GIF converter view. Runs entirely in the browser.
// Uses window.showToast (defined in color-extractor.js) and tab switching from that file.
// GIF encoding uses the gifenc library, loaded from jsDelivr only when a conversion starts.
(function () {
  'use strict';

  const GIFENC_URL = 'https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js';
  const MAX_BYTES = 200 * 1024 * 1024;
  const MAX_FRAMES = 600;
  const DEFAULT_WIDTH = 480;

  let gifenc = null;      // loaded library
  let srcUrl = null;      // object URL of the loaded video
  let srcName = '';
  let vidW = 0, vidH = 0, duration = 0;
  let resultUrl = null, resultBlob = null;
  let busy = false, cancelled = false;

  const $ = id => document.getElementById(id);
  const addBtn = $('gifAddBtn'), clearBtn = $('gifClearBtn'), fileInput = $('gifFileInput');
  const fileCard = $('gifFileCard'), fileNameEl = $('gifFileName'), fileSubEl = $('gifFileSub');
  const widthIn = $('gifWidth'), fpsIn = $('gifFps'), fpsVal = $('gifFpsVal');
  const colorsSel = $('gifColors'), loopChk = $('gifLoop');
  const estimate = $('gifEstimate'), convertBtn = $('gifConvertBtn');
  const progress = $('gifProgress'), progFill = $('gifProgressFill'), progLabel = $('gifProgressLabel');
  const stage = $('gifStage'), empty = $('gifEmpty'), editor = $('gifEditor'), video = $('gifVideo');
  const startIn = $('gifStart'), endIn = $('gifEnd'), startVal = $('gifStartVal'), endVal = $('gifEndVal');
  const trimReadout = $('gifTrimReadout');
  const setStartBtn = $('gifSetStart'), setEndBtn = $('gifSetEnd'), playClipBtn = $('gifPlayClip');
  const result = $('gifResult'), resultImg = $('gifResultImg'), resultMeta = $('gifResultMeta');
  const downloadBtn = $('gifDownloadBtn');

  // ---------- helpers ----------
  function fmtTime(s) {
    const m = Math.floor(s / 60);
    const sec = (s - m * 60).toFixed(1).padStart(4, '0');
    return m + ':' + sec;
  }
  function fmtSize(bytes) {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }
  function baseName(name) { return name.replace(/\.[^.]+$/, ''); }
  function tick() { return new Promise(r => setTimeout(r, 0)); }

  // ---------- add / remove ----------
  addBtn.addEventListener('click', () => fileInput.click());
  empty.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
    fileInput.value = '';
  });
  stage.addEventListener('dragover', e => { e.preventDefault(); empty.classList.add('dragover'); });
  stage.addEventListener('dragleave', () => empty.classList.remove('dragover'));
  stage.addEventListener('drop', e => {
    e.preventDefault();
    empty.classList.remove('dragover');
    const f = Array.from(e.dataTransfer.files).find(x => x.type.startsWith('video/'));
    if (f) loadFile(f); else window.showToast('Drop a video file (MP4, WebM or MOV)', 'error');
  });
  clearBtn.addEventListener('click', () => {
    if (busy) { window.showToast('Wait for the conversion to finish or cancel it', 'error'); return; }
    if (!srcUrl) return;
    reset();
    window.showToast('Video removed');
  });

  function reset() {
    if (srcUrl) URL.revokeObjectURL(srcUrl);
    clearResult();
    srcUrl = null; srcName = ''; vidW = vidH = duration = 0;
    video.removeAttribute('src'); video.load();
    fileCard.hidden = true; editor.hidden = true; empty.hidden = false;
    widthIn.value = ''; widthIn.placeholder = 'Original';
    updateEstimate();
  }

  function clearResult() {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = null; resultBlob = null;
    result.hidden = true; resultImg.removeAttribute('src');
  }

  function loadFile(file) {
    if (busy) { window.showToast('Wait for the conversion to finish or cancel it', 'error'); return; }
    if (!file.type.startsWith('video/')) { window.showToast('That file is not a video', 'error'); return; }
    if (file.size > MAX_BYTES) { window.showToast(file.name + ' is over 200 MB', 'error'); return; }
    if (srcUrl) URL.revokeObjectURL(srcUrl);
    clearResult();
    srcUrl = URL.createObjectURL(file);
    srcName = file.name;
    video.src = srcUrl;
    video.onloadedmetadata = () => {
      vidW = video.videoWidth; vidH = video.videoHeight; duration = video.duration;
      if (!vidW || !isFinite(duration)) { window.showToast('Could not read this video', 'error'); reset(); return; }
      fileNameEl.textContent = file.name; fileNameEl.title = file.name;
      fileSubEl.textContent = vidW + ' × ' + vidH + ' · ' + fmtTime(duration) + ' · ' + fmtSize(file.size);
      fileCard.hidden = false; empty.hidden = true; editor.hidden = false;
      widthIn.placeholder = String(vidW);
      widthIn.value = String(Math.min(vidW, DEFAULT_WIDTH));
      [startIn, endIn].forEach(r => { r.max = duration.toFixed(2); r.step = '0.05'; });
      startIn.value = 0;
      endIn.value = Math.min(duration, 10).toFixed(2);
      updateTrim();
      window.showToast('Video loaded');
    };
    video.onerror = () => {
      window.showToast('This browser cannot play that video format', 'error');
      reset();
    };
  }

  // ---------- trim ----------
  function getTrim() {
    let s = parseFloat(startIn.value) || 0;
    let e = parseFloat(endIn.value) || 0;
    if (e < s) [s, e] = [e, s];
    return { s, e };
  }
  function updateTrim() {
    const { s, e } = getTrim();
    startVal.textContent = fmtTime(parseFloat(startIn.value) || 0);
    endVal.textContent = fmtTime(parseFloat(endIn.value) || 0);
    trimReadout.textContent = fmtTime(s) + ' – ' + fmtTime(e) + '  (' + (e - s).toFixed(1) + 's)';
    updateEstimate();
  }
  startIn.addEventListener('input', () => { video.currentTime = parseFloat(startIn.value) || 0; updateTrim(); });
  endIn.addEventListener('input', () => { video.currentTime = parseFloat(endIn.value) || 0; updateTrim(); });
  setStartBtn.addEventListener('click', () => { startIn.value = video.currentTime.toFixed(2); updateTrim(); });
  setEndBtn.addEventListener('click', () => { endIn.value = video.currentTime.toFixed(2); updateTrim(); });

  let clipStop = null;
  playClipBtn.addEventListener('click', () => {
    const { s, e } = getTrim();
    if (clipStop) video.removeEventListener('timeupdate', clipStop);
    clipStop = () => {
      if (video.currentTime >= e) {
        video.pause();
        video.removeEventListener('timeupdate', clipStop);
        clipStop = null;
      }
    };
    video.currentTime = s;
    video.addEventListener('timeupdate', clipStop);
    video.play();
  });

  // ---------- settings / estimate ----------
  fpsIn.addEventListener('input', () => { fpsVal.textContent = fpsIn.value + ' fps'; updateEstimate(); });
  widthIn.addEventListener('input', updateEstimate);

  function outDims() {
    let w = parseInt(widthIn.value, 10) || vidW;
    w = Math.max(16, Math.min(w, vidW || w));
    const h = Math.max(1, Math.round(vidH * w / vidW));
    return { w, h };
  }
  function frameCount() {
    const { s, e } = getTrim();
    return Math.max(1, Math.ceil((e - s) * parseInt(fpsIn.value, 10)));
  }

  function updateEstimate() {
    if (!srcUrl) {
      estimate.innerHTML = '<span>Load a video to begin</span>';
      estimate.classList.remove('warn');
      convertBtn.disabled = true;
      return;
    }
    const { w, h } = outDims();
    const n = frameCount();
    const tooMany = n > MAX_FRAMES;
    estimate.classList.toggle('warn', tooMany);
    estimate.innerHTML =
      '<span><strong>' + w + ' × ' + h + '</strong> px</span>' +
      '<span><strong>' + n + '</strong> frames' + (tooMany ? ' (max ' + MAX_FRAMES + ')' : '') + '</span>';
    convertBtn.disabled = tooMany && !busy;
  }

  // ---------- frame capture ----------
  function waitFor(el, evt, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { el.removeEventListener(evt, on); reject(new Error('Video timed out')); }, ms);
      function on() { clearTimeout(timer); el.removeEventListener(evt, on); resolve(); }
      el.addEventListener(evt, on);
    });
  }

  async function seek(v, t) {
    const p = waitFor(v, 'seeked', 8000);
    v.currentTime = t;
    await p;
  }

  async function loadLib() {
    if (gifenc) return gifenc;
    try {
      gifenc = await import(GIFENC_URL);
    } catch (err) {
      throw new Error('Could not load the GIF encoder. Check your internet connection.');
    }
    return gifenc;
  }

  function setProgress(frac, label) {
    progFill.style.width = Math.round(frac * 100) + '%';
    progLabel.textContent = label;
  }

  // ---------- convert ----------
  convertBtn.addEventListener('click', () => {
    if (busy) { cancelled = true; convertBtn.textContent = 'Cancelling…'; return; }
    convert();
  });

  async function convert() {
    if (!srcUrl) { window.showToast('Load a video first', 'error'); return; }
    const n = frameCount();
    if (n > MAX_FRAMES) { window.showToast('Too many frames. Shorten the clip or lower the frame rate.', 'error'); return; }

    busy = true; cancelled = false;
    video.pause();
    clearResult();
    convertBtn.textContent = 'Cancel';
    progress.hidden = false;
    setProgress(0, 'Loading encoder…');

    const work = document.createElement('video');
    work.muted = true; work.preload = 'auto'; work.playsInline = true;

    try {
      const lib = await loadLib();
      work.src = srcUrl;
      await waitFor(work, 'loadeddata', 15000);

      const { w, h } = outDims();
      const fps = parseInt(fpsIn.value, 10);
      const colors = parseInt(colorsSel.value, 10);
      const { s, e } = getTrim();
      const delay = Math.round(1000 / fps);

      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';

      const enc = lib.GIFEncoder();
      for (let i = 0; i < n; i++) {
        if (cancelled) throw new Error('cancelled');
        const t = Math.min(s + i / fps, Math.max(s, e - 0.01));
        await seek(work, t);
        cx.drawImage(work, 0, 0, w, h);
        const data = cx.getImageData(0, 0, w, h).data;
        const palette = lib.quantize(data, colors);
        const index = lib.applyPalette(data, palette);
        const opts = { palette, delay };
        if (i === 0) opts.repeat = loopChk.checked ? 0 : -1;
        enc.writeFrame(index, w, h, opts);
        setProgress((i + 1) / n, 'Encoding frame ' + (i + 1) + ' of ' + n);
        await tick();
      }
      enc.finish();
      resultBlob = new Blob([enc.bytes()], { type: 'image/gif' });
      resultUrl = URL.createObjectURL(resultBlob);
      resultImg.src = resultUrl;
      resultMeta.innerHTML =
        '<span class="rz-badge">' + w + ' X ' + h + '</span>' +
        '<span class="rz-badge">' + n + ' frames</span>' +
        '<span class="rz-badge new">' + fmtSize(resultBlob.size) + '</span>';
      result.hidden = false;
      result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      window.showToast('GIF ready · ' + fmtSize(resultBlob.size));
    } catch (err) {
      if (err.message === 'cancelled') window.showToast('Conversion cancelled', 'error');
      else window.showToast('Conversion failed: ' + err.message, 'error');
    } finally {
      work.removeAttribute('src'); work.load();
      busy = false; cancelled = false;
      progress.hidden = true;
      convertBtn.innerHTML = 'Convert to GIF &rarr;';
      updateEstimate();
    }
  }

  // ---------- download ----------
  downloadBtn.addEventListener('click', () => {
    if (!resultBlob) return;
    const a = document.createElement('a');
    a.href = resultUrl;
    a.download = baseName(srcName || 'video') + '.gif';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.showToast('GIF downloaded');
  });

  updateEstimate();
})();
