// resizer.js
/* global document, window, JSZip */
(function () {
  'use strict';

  const MAX_BYTES = 10 * 1024 * 1024;
  let files = []; // { name, img, w, h }
  let mode = 'size';

  const addBtn = document.getElementById('rzAddBtn');
  const clearBtn = document.getElementById('rzClearBtn');
  const fileInput = document.getElementById('rzFileInput');
  const widthIn = document.getElementById('rzWidth');
  const heightIn = document.getElementById('rzHeight');
  const lockRatio = document.getElementById('rzLockRatio');
  const percentIn = document.getElementById('rzPercent');
  const targetKB = document.getElementById('rzTargetKB');
  const formatSel = document.getElementById('rzFormat');
  const exportBtn = document.getElementById('rzExportBtn');
  const grid = document.getElementById('rzFileGrid');
  const empty = document.getElementById('rzEmpty');
  const filesPanel = document.querySelector('.resizer-files');

  // ---------- add / remove ----------
  addBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  clearBtn.addEventListener('click', () => {
    files = [];
    render();
    window.showToast('All images removed');
  });
  filesPanel.addEventListener('dragover', e => e.preventDefault());
  filesPanel.addEventListener('drop', e => { e.preventDefault(); addFiles(e.dataTransfer.files); });

  function addFiles(fileList) {
    const list = Array.from(fileList).filter(f => f.type.startsWith('image/'));
    if (!list.length) { window.showToast('No image files found', 'error'); return; }
    list.forEach(file => {
      if (file.size > MAX_BYTES) {
        window.showToast(file.name + ' is over 10 MB — skipped', 'error');
        return;
      }
      const img = new Image();
      img.onload = () => {
        files.push({ name: file.name, img, w: img.naturalWidth, h: img.naturalHeight });
        render();
      };
      img.src = URL.createObjectURL(file);
    });
  }

  // ---------- mode tabs ----------
  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      mode = btn.dataset.mode;
      document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.getElementById('rzModeSize').hidden = mode !== 'size';
      document.getElementById('rzModePercent').hidden = mode !== 'percent';
      render();
    });
  });
  [widthIn, heightIn, percentIn, lockRatio].forEach(el => el.addEventListener('input', render));

  // ---------- target dimensions ----------
  function targetDims(f) {
    if (mode === 'percent') {
      const p = parseFloat(percentIn.value);
      if (!p || p <= 0) return { w: f.w, h: f.h };
      return { w: Math.max(1, Math.round(f.w * p / 100)), h: Math.max(1, Math.round(f.h * p / 100)) };
    }
    const W = parseInt(widthIn.value, 10) || 0;
    const H = parseInt(heightIn.value, 10) || 0;
    if (!W && !H) return { w: f.w, h: f.h };
    if (lockRatio.checked) {
      if (W && H) {
        const s = Math.min(W / f.w, H / f.h); // fit inside box
        return { w: Math.max(1, Math.round(f.w * s)), h: Math.max(1, Math.round(f.h * s)) };
      }
      const s = W ? W / f.w : H / f.h;
      return { w: Math.max(1, Math.round(f.w * s)), h: Math.max(1, Math.round(f.h * s)) };
    }
    return { w: W || f.w, h: H || f.h };
  }

  // ---------- render cards ----------
  function render() {
    empty.style.display = files.length ? 'none' : 'block';
    grid.innerHTML = '';
    files.forEach((f, i) => {
      const t = targetDims(f);
      const card = document.createElement('div');
      card.className = 'rz-card';
      const img = document.createElement('img');
      img.src = f.img.src; img.alt = f.name;
      const name = document.createElement('div');
      name.className = 'rz-name'; name.textContent = f.name; name.title = f.name;
      const dims = document.createElement('div');
      dims.className = 'rz-dims';
      dims.innerHTML =
        '<span class="rz-badge">' + f.w + ' X ' + f.h + '</span>' +
        '<span>&rarr;</span>' +
        '<span class="rz-badge new">' + t.w + ' X ' + t.h + '</span>';
      const x = document.createElement('button');
      x.className = 'rz-x'; x.textContent = '✕'; x.title = 'Remove';
      x.addEventListener('click', () => { files.splice(i, 1); render(); });
      card.appendChild(x); card.appendChild(img); card.appendChild(name); card.appendChild(dims);
      grid.appendChild(card);
    });
  }

  // ---------- export ----------
  function outFormat(f) {
    const v = formatSel.value;
    if (v !== 'original') return v === 'jpeg' ? 'image/jpeg' : 'image/' + v;
    const ext = f.name.split('.').pop().toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    return 'image/png';
  }
  function extOf(mime) { return mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]; }
  function baseName(name) { return name.replace(/\.[^.]+$/, ''); }

  function toBlob(canvas, mime, quality) {
    return new Promise(resolve => canvas.toBlob(resolve, mime, quality));
  }

  async function renderOne(f) {
    const t = targetDims(f);
    const cv = document.createElement('canvas');
    cv.width = t.w; cv.height = t.h;
    const cx = cv.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    if (outFormat(f) === 'image/jpeg') { cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, t.w, t.h); }
    cx.drawImage(f.img, 0, 0, t.w, t.h);
    const mime = outFormat(f);
    const limitKB = parseInt(targetKB.value, 10);

    if (mime === 'image/jpeg' && limitKB > 0) {
      // binary search quality to hit target size
      let lo = 0.05, hi = 0.95, best = await toBlob(cv, mime, hi);
      if (best.size / 1024 > limitKB) {
        for (let i = 0; i < 7; i++) {
          const mid = (lo + hi) / 2;
          const blob = await toBlob(cv, mime, mid);
          if (blob.size / 1024 > limitKB) hi = mid; else { lo = mid; best = blob; }
        }
        if (best.size / 1024 > limitKB) best = await toBlob(cv, mime, lo);
      }
      return { blob: best, name: baseName(f.name) + '-resized.jpg' };
    }
    const blob = await toBlob(cv, mime, 0.92);
    return { blob, name: baseName(f.name) + '-resized.' + extOf(mime) };
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  exportBtn.addEventListener('click', async () => {
    if (!files.length) { window.showToast('Add images first', 'error'); return; }
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting…';
    try {
      const results = [];
      for (const f of files) results.push(await renderOne(f));
      if (results.length === 1 || typeof JSZip === 'undefined') {
        results.forEach((r, i) => setTimeout(() => download(r.blob, r.name), i * 350));
        window.showToast(results.length + ' image' + (results.length > 1 ? 's' : '') + ' exported');
      } else {
        const zip = new JSZip();
        results.forEach(r => zip.file(r.name, r.blob));
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        download(zipBlob, 'resized-images.zip');
        window.showToast(results.length + ' images exported as ZIP');
      }
    } catch (err) {
      window.showToast('Export failed: ' + err.message, 'error');
    } finally {
      exportBtn.disabled = false;
      exportBtn.innerHTML = 'Export &rarr;';
    }
  });
})();
