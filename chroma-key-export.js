// chroma-key-export.js
/* global document, window, JSZip, MediaRecorder */
// Export logic for the Background Remover view. Joins every clip in the list (in order)
// into one output. Reads clips, the keyer and the frame drawer from window.ChromaKey
// (defined in chroma-key.js) and fills in busy/clearResult/updateEstimate.
// Transparent GIF uses gifenc (loaded from jsDelivr on first export); PNG frames use JSZip
// (loaded in index.html); video uses the browser's MediaRecorder.
(function () {
  'use strict';

  const GIFENC_URL = 'https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js';
  const MAX_FRAMES = 900;
  const CK = window.ChromaKey;

  let gifenc = null, busy = false, cancelled = false;
  let resultUrl = null, resultBlob = null, resultExt = 'gif';

  const $ = id => document.getElementById(id);
  const formatSel = $('ckFormat'), fpsIn = $('ckFps'), fpsVal = $('ckFpsVal');
  const bgRow = $('ckBgRow'), bgColor = $('ckBgColor');
  const estimate = $('ckEstimate'), exportBtn = $('ckExportBtn');
  const progress = $('ckProgress'), progFill = $('ckProgressFill'), progLabel = $('ckProgressLabel');
  const result = $('ckResult'), resultImg = $('ckResultImg'), resultVid = $('ckResultVid');
  const resultMeta = $('ckResultMeta'), downloadBtn = $('ckDownloadBtn');
  const widthIn = $('ckWidth');

  // ---------- estimate ----------
  function clipFrames(c, fps) { return Math.max(1, Math.ceil((c.end - c.start) * fps)); }
  function totalFrames() {
    const fps = parseInt(fpsIn.value, 10);
    return CK.state.clips.reduce((n, c) => n + clipFrames(c, fps), 0);
  }
  function updateEstimate() {
    const fmt = formatSel.value;
    bgRow.hidden = fmt !== 'video';
    const clips = CK.state.clips;
    if (!clips.length) {
      estimate.innerHTML = '<span>Load a video to begin</span>';
      estimate.classList.remove('warn'); exportBtn.disabled = true; return;
    }
    const { w, h } = CK.outDims();
    const n = totalFrames();
    const tooMany = fmt !== 'video' && n > MAX_FRAMES;
    estimate.classList.toggle('warn', tooMany);
    estimate.innerHTML =
      '<span><strong>' + w + ' × ' + h + '</strong> px</span>' +
      '<span><strong>' + n + '</strong> frames' + (clips.length > 1 ? ' · ' + clips.length + ' clips' : '') +
      (tooMany ? ' (max ' + MAX_FRAMES + ')' : '') + '</span>';
    exportBtn.disabled = tooMany && !busy;
  }
  formatSel.addEventListener('change', updateEstimate);
  fpsIn.addEventListener('input', () => { fpsVal.textContent = fpsIn.value + ' fps'; updateEstimate(); });
  widthIn.addEventListener('input', updateEstimate);

  function clearResult() {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = null; resultBlob = null;
    result.hidden = true; resultImg.hidden = true; resultVid.hidden = true;
    resultImg.removeAttribute('src'); resultVid.removeAttribute('src');
  }

  // ---------- helpers ----------
  function tick() { return new Promise(r => setTimeout(r, 0)); }
  function waitFor(el, evt, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { el.removeEventListener(evt, on); reject(new Error('Video timed out')); }, ms);
      function on() { clearTimeout(timer); el.removeEventListener(evt, on); resolve(); }
      el.addEventListener(evt, on);
    });
  }
  async function seek(v, t) { const p = waitFor(v, 'seeked', 8000); v.currentTime = t; await p; }
  async function loadLib() {
    if (gifenc) return gifenc;
    try { gifenc = await import(GIFENC_URL); }
    catch (err) { throw new Error('Could not load the GIF encoder. Check your internet connection.'); }
    return gifenc;
  }
  function setProgress(frac, label) {
    progFill.style.width = Math.round(frac * 100) + '%'; progLabel.textContent = label;
  }
  async function openWork(c) {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = c.url;
    await waitFor(v, 'loadeddata', 15000);
    return v;
  }
  function closeWork(v) { v.pause(); v.removeAttribute('src'); v.load(); }
  function makeCanvas(w, h) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    return { cv, cx: cv.getContext('2d', { willReadFrequently: true }) };
  }
  // Draws one keyed frame of clip `c` from `work`; returns the RGBA ImageData.
  function keyedFrame(work, c, srcCx, outCx, w, h) {
    CK.drawSource(srcCx, work, w, h, c.flip);
    const img = srcCx.getImageData(0, 0, w, h);
    const out = outCx.createImageData(w, h);
    CK.keyFrame(img.data, out.data, c, w, h);
    return out;
  }

  // Walks every frame of every clip in order, calling onFrame(imageData, frameIndex, total).
  async function eachFrame(w, h, fps, total, onFrame) {
    const { cx: srcCx } = makeCanvas(w, h);
    const { cx: outCx } = makeCanvas(w, h);
    let i = 0;
    for (const c of CK.state.clips) {
      const work = await openWork(c);
      try {
        const n = clipFrames(c, fps);
        for (let k = 0; k < n; k++) {
          if (cancelled) throw new Error('cancelled');
          await seek(work, Math.min(c.start + k / fps, Math.max(c.start, c.end - 0.01)));
          await onFrame(keyedFrame(work, c, srcCx, outCx, w, h), i++, total);
          await tick();
        }
      } finally { closeWork(work); }
    }
  }

  // ---------- exporters ----------
  async function exportGif(w, h, fps, total) {
    const lib = await loadLib();
    const enc = lib.GIFEncoder();
    const delay = Math.round(1000 / fps);
    await eachFrame(w, h, fps, total, (out, i) => {
      const d = out.data;
      // GIF transparency is on/off, so threshold the soft alpha at 50%.
      for (let p = 3; p < d.length; p += 4) d[p] = d[p] >= 128 ? 255 : 0;
      const palette = lib.quantize(d, 255);
      const index = lib.applyPalette(d, palette);
      palette.push([0, 0, 0]);
      const ti = palette.length - 1;
      for (let p = 0, q = 3; q < d.length; p++, q += 4) if (d[q] === 0) index[p] = ti;
      enc.writeFrame(index, w, h, { palette, delay, repeat: 0, transparent: true, transparentIndex: ti, dispose: 2 });
      setProgress((i + 1) / total, 'Encoding frame ' + (i + 1) + ' of ' + total);
    });
    enc.finish();
    return new Blob([enc.bytes()], { type: 'image/gif' });
  }

  async function exportPng(w, h, fps, total) {
    if (typeof JSZip === 'undefined') throw new Error('ZIP library did not load');
    const { cv, cx } = makeCanvas(w, h);
    const zip = new JSZip();
    const pad = String(total).length;
    await eachFrame(w, h, fps, total, async (out, i) => {
      cx.putImageData(out, 0, 0);
      const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
      zip.file('frame-' + String(i + 1).padStart(pad, '0') + '.png', blob);
      setProgress((i + 1) / total, 'Rendering frame ' + (i + 1) + ' of ' + total);
    });
    setProgress(1, 'Zipping…');
    return zip.generateAsync({ type: 'blob' });
  }

  function pickVideoType() {
    // H.264 MP4 when the browser can encode it (Chrome, Safari), otherwise WebM.
    const types = ['video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4'];
    return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
  }

  // Records in real time: each clip plays once while keyed frames are drawn onto a canvas stream.
  async function exportVideo(w, h, fps) {
    if (typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record video');
    const type = pickVideoType();
    resultExt = type.startsWith('video/mp4') ? 'mp4' : 'webm';
    const { cx: srcCx } = makeCanvas(w, h);
    const { cv: outCv, cx: outCx } = makeCanvas(w, h);
    const tmp = makeCanvas(w, h);
    const bg = bgColor.value;
    const clips = CK.state.clips;
    const totalLen = clips.reduce((t, c) => t + (c.end - c.start), 0);
    const stream = outCv.captureStream(fps);
    const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 8000000 } : undefined);
    const chunks = [];
    rec.ondataavailable = ev => { if (ev.data.size) chunks.push(ev.data); };
    const done = new Promise(r => { rec.onstop = r; });

    function draw(work, c) {
      const out = keyedFrame(work, c, srcCx, outCx, w, h);
      outCx.fillStyle = bg; outCx.fillRect(0, 0, w, h);
      tmp.cx.putImageData(out, 0, 0);
      outCx.drawImage(tmp.cv, 0, 0);
    }
    let elapsed = 0;
    try {
      for (let ci = 0; ci < clips.length; ci++) {
        const c = clips[ci];
        const work = await openWork(c);
        try {
          await seek(work, c.start);
          draw(work, c);
          if (ci === 0) rec.start(200);
          await work.play();
          await new Promise((resolve, reject) => {
            function step() {
              if (cancelled) { reject(new Error('cancelled')); return; }
              draw(work, c);
              const t = elapsed + (work.currentTime - c.start);
              setProgress(t / totalLen, 'Recording ' + CK.fmtTime(t) + ' of ' + CK.fmtTime(totalLen));
              if (work.currentTime >= c.end || work.ended) { resolve(); return; }
              requestAnimationFrame(step);
            }
            step();
          });
          elapsed += c.end - c.start;
        } finally { closeWork(work); }
      }
    } finally {
      if (rec.state !== 'inactive') rec.stop();
    }
    await done;
    return new Blob(chunks, { type: type || 'video/webm' });
  }

  // ---------- run ----------
  exportBtn.addEventListener('click', () => {
    if (busy) { cancelled = true; exportBtn.textContent = 'Cancelling…'; return; }
    run();
  });

  async function run() {
    if (!CK.state.clips.length) { window.showToast('Load a video first', 'error'); return; }
    const fmt = formatSel.value;
    const total = totalFrames();
    if (fmt !== 'video' && total > MAX_FRAMES) { window.showToast('Too many frames. Shorten the clips or lower the frame rate.', 'error'); return; }

    busy = true; cancelled = false;
    CK.pauseVideo(); clearResult();
    exportBtn.textContent = 'Cancel'; progress.hidden = false;
    setProgress(0, 'Preparing…');
    try {
      const { w, h } = CK.outDims();
      const fps = parseInt(fpsIn.value, 10);
      if (fmt === 'gif') { resultExt = 'gif'; resultBlob = await exportGif(w, h, fps, total); }
      else if (fmt === 'png') { resultExt = 'zip'; resultBlob = await exportPng(w, h, fps, total); }
      else resultBlob = await exportVideo(w, h, fps);

      resultUrl = URL.createObjectURL(resultBlob);
      if (fmt === 'gif') { resultImg.src = resultUrl; resultImg.hidden = false; }
      else if (fmt === 'video') { resultVid.src = resultUrl; resultVid.hidden = false; }
      resultMeta.innerHTML =
        '<span class="rz-badge">' + w + ' X ' + h + '</span>' +
        '<span class="rz-badge">' + (fmt === 'video' ? resultExt.toUpperCase() : total + ' frames') + '</span>' +
        '<span class="rz-badge new">' + CK.fmtSize(resultBlob.size) + '</span>';
      result.hidden = false;
      result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      window.showToast('Export ready · ' + CK.fmtSize(resultBlob.size));
    } catch (err) {
      if (err.message === 'cancelled') window.showToast('Export cancelled', 'error');
      else window.showToast('Export failed: ' + err.message, 'error');
    } finally {
      busy = false; cancelled = false; progress.hidden = true;
      exportBtn.innerHTML = 'Export &rarr;';
      updateEstimate();
    }
  }

  downloadBtn.addEventListener('click', () => {
    if (!resultBlob) return;
    const first = CK.state.clips[0];
    const a = document.createElement('a');
    a.href = resultUrl;
    a.download = (first ? first.name : 'video').replace(/\.[^.]+$/, '') + '-nobg.' + resultExt;
    document.body.appendChild(a); a.click(); a.remove();
    window.showToast('Download started');
  });

  Object.assign(CK, { busy: () => busy, clearResult, updateEstimate });
  updateEstimate();
})();
