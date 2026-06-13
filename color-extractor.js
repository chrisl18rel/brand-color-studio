// color-extractor.js
/* global document, window */
(function () {
  'use strict';

  // ---------- shared toast + tab switching ----------
  window.showToast = function (msg, type) {
    const wrap = document.getElementById('toastWrap');
    const t = document.createElement('div');
    t.className = 'toast ' + (type || 'success');
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, 2200);
  };

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById('view-' + btn.dataset.view).classList.add('active');
    });
  });

  // ---------- color utilities ----------
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  }
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h, s, l };
  }
  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
  }
  function hueDist(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }
  function copyText(text, msg) {
    navigator.clipboard.writeText(text).then(
      () => window.showToast(msg || 'Copied to clipboard'),
      () => window.showToast('Could not copy', 'error')
    );
  }

  // ---------- median-cut quantization ----------
  function quantize(pixels, count) {
    if (!pixels.length) return [];
    let boxes = [pixels];
    while (boxes.length < count) {
      boxes.sort((a, b) => rangeOf(b).range - rangeOf(a).range);
      const box = boxes.shift();
      if (box.length < 2) { boxes.unshift(box); break; }
      const ch = rangeOf(box).channel;
      box.sort((p, q) => p[ch] - q[ch]);
      const mid = box.length >> 1;
      boxes.push(box.slice(0, mid), box.slice(mid));
    }
    let centers = boxes.map(box => {
      let r = 0, g = 0, b = 0;
      box.forEach(p => { r += p[0]; g += p[1]; b += p[2]; });
      const n = box.length;
      return { r: r / n, g: g / n, b: b / n, count: n };
    });
    // k-means refinement: reassign pixels to nearest center, recompute (2 passes)
    for (let pass = 0; pass < 2; pass++) {
      const sums = centers.map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
      pixels.forEach(p => {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < centers.length; i++) {
          const c = centers[i];
          const d = (p[0] - c.r) ** 2 + (p[1] - c.g) ** 2 + (p[2] - c.b) ** 2;
          if (d < bd) { bd = d; bi = i; }
        }
        const s = sums[bi]; s.r += p[0]; s.g += p[1]; s.b += p[2]; s.n++;
      });
      centers = sums.filter(s => s.n > 0)
        .map(s => ({ r: s.r / s.n, g: s.g / s.n, b: s.b / s.n, count: s.n }));
    }
    return centers.sort((a, b) => b.count - a.count);
  }
  function rangeOf(box) {
    const mins = [255, 255, 255], maxs = [0, 0, 0];
    box.forEach(p => {
      for (let c = 0; c < 3; c++) {
        if (p[c] < mins[c]) mins[c] = p[c];
        if (p[c] > maxs[c]) maxs[c] = p[c];
      }
    });
    let channel = 0, range = -1;
    for (let c = 0; c < 3; c++) {
      if (maxs[c] - mins[c] > range) { range = maxs[c] - mins[c]; channel = c; }
    }
    return { channel, range };
  }
  function samplePixels(img, max) {
    const cv = document.createElement('canvas');
    const scale = Math.min(1, 110 / Math.max(img.naturalWidth, img.naturalHeight));
    cv.width = Math.max(1, Math.round(img.naturalWidth * scale));
    cv.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, cv.width, cv.height);
    const data = cx.getImageData(0, 0, cv.width, cv.height).data;
    const out = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 200) out.push([data[i], data[i + 1], data[i + 2]]);
      if (out.length >= max) break;
    }
    return out;
  }

  // ---------- state ----------
  const CATEGORIES = [
    { key: 'primary', label: 'Primary Color' },
    { key: 'primaryDark', label: 'Primary Dark' },
    { key: 'pageBg', label: 'Page Background' },
    { key: 'secondaryBg', label: 'Secondary Background' },
    { key: 'accentText', label: 'Accent Text' },
    { key: 'bodyText', label: 'Header & Body Text' },
    { key: 'danger', label: 'Danger / Alert' },
    { key: 'actionBtn', label: 'Action Button' }
  ];
  let images = [];          // { name, img, pixels }
  let combined = [];        // quantized pool {r,g,b,count}
  let paletteSize = 8;
  let activeIndex = 0;      // preview image
  let activeCategory = 'primary';
  let assignments = {};     // key -> hex
  let optionSets = [];      // [{name, colors:{key:hex}}]

  // ---------- upload ----------
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('dragover');
    addFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  function addFiles(fileList) {
    const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
    if (!files.length) { window.showToast('No image files found', 'error'); return; }
    let pending = files.length;
    files.forEach(file => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        images.push({ name: file.name, img, pixels: samplePixels(img, 12000) });
        if (--pending === 0) {
          activeIndex = images.length - 1;
          rebuildAll(true);
          window.showToast(files.length + ' image' + (files.length > 1 ? 's' : '') + ' added');
        }
      };
      img.onerror = () => { if (--pending === 0) rebuildAll(true); };
      img.src = url;
    });
  }

  function removeImage(i) {
    images.splice(i, 1);
    if (activeIndex >= images.length) activeIndex = images.length - 1;
    rebuildAll(true);
  }

  // ---------- combined palette + auto assignment ----------
  function rebuildAll(reassign) {
    const all = [];
    images.forEach(item => { all.push(...item.pixels); });
    combined = quantize(all, paletteSize);
    renderThumbs();
    renderPreview();
    renderPaletteStrip();
    if (reassign && combined.length) {
      optionSets = [buildOption(0), buildOption(1)];
      assignments = Object.assign({}, optionSets[0].colors);
    }
    renderCategories();
    renderOptions();
    renderHarmonies();
  }

  function buildOption(variant) {
    const pool = combined.map(c => Object.assign({ hsl: rgbToHsl(c.r, c.g, c.b), hex: rgbToHex(c.r, c.g, c.b) }, c));
    const total = pool.reduce((s, c) => s + c.count, 0) || 1;

    // primary candidates: saturated, mid lightness, weighted by share
    const cands = pool
      .map(c => Object.assign({ score: c.hsl.s * (1 - Math.abs(c.hsl.l - 0.45)) * (0.4 + c.count / total) }, c))
      .sort((a, b) => b.score - a.score);
    let primary = cands[0];
    if (variant === 1) {
      const alt = cands.find(c => hueDist(c.hsl.h, cands[0].hsl.h) > 40);
      primary = alt || cands[1] || cands[0];
    }
    const ph = primary.hsl.h, ps = Math.max(primary.hsl.s, 0.25);

    // primary dark: existing darker color of similar hue, else darkened primary
    const darker = pool.find(c => c !== primary && hueDist(c.hsl.h, ph) < 30 && c.hsl.l < primary.hsl.l - 0.15);
    const primaryDark = darker ? darker.hex : hslToHex(ph, Math.min(1, ps * 1.05), Math.max(0.14, primary.hsl.l * 0.55));

    // backgrounds
    const lights = pool.filter(c => c.hsl.l > 0.8 && c.hsl.s < 0.4).sort((a, b) => b.hsl.l - a.hsl.l);
    const pageBg = lights[0] ? lights[0].hex : hslToHex(ph, ps * 0.22, 0.965);
    const pageL = lights[0] ? lights[0].hsl.l : 0.965;
    const secondaryBg = lights[1] ? lights[1].hex : hslToHex(ph, ps * 0.25, Math.max(0.84, pageL - 0.06));

    // accent text: saturated, hue far from primary, dark enough for text
    const acc = pool
      .filter(c => c !== primary && c.hsl.s > 0.25 && hueDist(c.hsl.h, ph) > 50)
      .sort((a, b) => b.hsl.s - a.hsl.s)[0];
    const accentText = acc
      ? hslToHex(acc.hsl.h, Math.max(acc.hsl.s, 0.45), Math.min(0.42, Math.max(0.28, acc.hsl.l)))
      : hslToHex(ph + 180, 0.55, 0.36);

    // header & body text: darkest pool color, else near-black tinted with primary hue
    const darks = pool.filter(c => c.hsl.l < 0.25).sort((a, b) => a.hsl.l - b.hsl.l);
    const bodyText = darks[0] ? darks[0].hex : hslToHex(ph, 0.28, 0.13);

    // danger: red from images if present, else a red harmonized to the palette
    const red = pool.find(c => c.hsl.s > 0.4 && c.hsl.l > 0.2 && c.hsl.l < 0.7 &&
      (c.hsl.h <= 18 || c.hsl.h >= 345));
    const danger = red ? red.hex : hslToHex(4, 0.72, 0.5);

    // action button: strong saturated CTA color — accent hue if present, else primary
    const actionBtn = acc
      ? hslToHex(acc.hsl.h, Math.max(acc.hsl.s, 0.5), 0.48)
      : hslToHex(ph, Math.max(ps, 0.5), 0.48);

    return {
      name: variant === 0 ? 'Option A — Dominant' : 'Option B — Alternate Hue',
      colors: {
        primary: primary.hex, primaryDark, pageBg, secondaryBg,
        accentText, bodyText, danger, actionBtn
      }
    };
  }

  // ---------- rendering ----------
  function renderThumbs() {
    const strip = document.getElementById('thumbStrip');
    strip.innerHTML = '';
    images.forEach((item, i) => {
      const d = document.createElement('div');
      d.className = 'thumb' + (i === activeIndex ? ' active' : '');
      const im = document.createElement('img');
      im.src = item.img.src; im.alt = item.name;
      const x = document.createElement('button');
      x.className = 'thumb-x'; x.textContent = '✕'; x.title = 'Remove';
      x.addEventListener('click', e => { e.stopPropagation(); removeImage(i); });
      d.addEventListener('click', () => { activeIndex = i; renderThumbs(); renderPreview(); });
      d.appendChild(im); d.appendChild(x);
      strip.appendChild(d);
    });
  }

  const previewWrap = document.getElementById('previewWrap');
  const previewCanvas = document.getElementById('previewCanvas');
  const loupe = document.getElementById('loupe');
  const loupeCanvas = document.getElementById('loupeCanvas');
  let fullCanvas = null; // natural-size copy for pixel reads

  function renderPreview() {
    if (activeIndex < 0 || !images[activeIndex]) { previewWrap.hidden = true; return; }
    previewWrap.hidden = false;
    const img = images[activeIndex].img;
    const maxW = 1100;
    const scale = Math.min(1, maxW / img.naturalWidth);
    previewCanvas.width = Math.round(img.naturalWidth * scale);
    previewCanvas.height = Math.round(img.naturalHeight * scale);
    previewCanvas.getContext('2d').drawImage(img, 0, 0, previewCanvas.width, previewCanvas.height);
    fullCanvas = document.createElement('canvas');
    fullCanvas.width = img.naturalWidth; fullCanvas.height = img.naturalHeight;
    fullCanvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
  }

  function canvasPoint(e) {
    const rect = previewCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * fullCanvas.width;
    const y = (e.clientY - rect.top) / rect.height * fullCanvas.height;
    return {
      x: Math.min(fullCanvas.width - 1, Math.max(0, Math.round(x))),
      y: Math.min(fullCanvas.height - 1, Math.max(0, Math.round(y))),
      rect, ex: e.clientX - rect.left, ey: e.clientY - rect.top
    };
  }

  previewCanvas.addEventListener('mousemove', e => {
    if (!fullCanvas) return;
    const p = canvasPoint(e);
    loupe.hidden = false;
    loupe.style.left = Math.min(p.rect.width - 160, Math.max(0, p.ex + 18)) + 'px';
    loupe.style.top = Math.max(0, p.ey - 168) + 'px';
    const lx = loupeCanvas.getContext('2d');
    const N = 15, half = (N - 1) / 2, cell = 150 / N;
    lx.imageSmoothingEnabled = false;
    lx.fillStyle = '#fff'; lx.fillRect(0, 0, 150, 150);
    lx.drawImage(fullCanvas, p.x - half, p.y - half, N, N, 0, 0, 150, 150);
    lx.strokeStyle = 'rgba(255,255,255,.45)'; lx.lineWidth = 1;
    for (let i = 1; i < N; i++) {
      lx.beginPath(); lx.moveTo(i * cell, 0); lx.lineTo(i * cell, 150); lx.stroke();
      lx.beginPath(); lx.moveTo(0, i * cell); lx.lineTo(150, i * cell); lx.stroke();
    }
    lx.strokeStyle = '#e11d48'; lx.lineWidth = 2;
    lx.strokeRect(half * cell, half * cell, cell, cell);
  });
  previewCanvas.addEventListener('mouseleave', () => { loupe.hidden = true; });
  previewCanvas.addEventListener('click', e => {
    if (!fullCanvas) return;
    const p = canvasPoint(e);
    const d = fullCanvas.getContext('2d').getImageData(p.x, p.y, 1, 1).data;
    const hex = rgbToHex(d[0], d[1], d[2]);
    setPicked(hex);
    assign(activeCategory, hex);
  });

  function setPicked(hex) {
    const rgb = hexToRgb(hex);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    document.getElementById('pickedSwatch').style.background = hex;
    document.getElementById('pickedHex').textContent = hex;
    document.getElementById('pickedRgb').textContent = 'rgb(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ')';
    document.getElementById('pickedHsl').textContent =
      'hsl(' + Math.round(hsl.h) + ', ' + Math.round(hsl.s * 100) + '%, ' + Math.round(hsl.l * 100) + '%)';
  }
  document.querySelectorAll('.copy-mini[data-copy-target]').forEach(btn => {
    btn.addEventListener('click', () =>
      copyText(document.getElementById(btn.dataset.copyTarget).textContent, 'Copied'));
  });

  function renderPaletteStrip() {
    const strip = document.getElementById('paletteStrip');
    strip.innerHTML = '';
    combined.forEach(c => {
      const hex = rgbToHex(c.r, c.g, c.b);
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.style.background = hex;
      chip.title = hex + ' — click to assign to ' + labelOf(activeCategory);
      chip.addEventListener('click', () => { setPicked(hex); assign(activeCategory, hex); });
      strip.appendChild(chip);
    });
  }
  document.getElementById('paletteMinus').addEventListener('click', () => {
    if (paletteSize > 4) { paletteSize--; rebuildAll(false); }
  });
  document.getElementById('palettePlus').addEventListener('click', () => {
    if (paletteSize < 14) { paletteSize++; rebuildAll(false); }
  });
  document.getElementById('paletteCopy').addEventListener('click', () => {
    if (!combined.length) { window.showToast('Upload images first', 'error'); return; }
    copyText(combined.map(c => rgbToHex(c.r, c.g, c.b)).join('\n'), 'Palette copied');
  });

  function labelOf(key) { return (CATEGORIES.find(c => c.key === key) || {}).label || key; }

  function assign(key, hex) {
    assignments[key] = hex;
    renderCategories();
    if (key === 'primary') renderHarmonies();
    window.showToast(hex + ' → ' + labelOf(key));
  }

  function renderCategories() {
    const list = document.getElementById('categoryList');
    list.innerHTML = '';
    CATEGORIES.forEach(cat => {
      const hex = assignments[cat.key] || '#ffffff';
      const row = document.createElement('div');
      row.className = 'cat-row' + (cat.key === activeCategory ? ' active' : '');
      row.addEventListener('click', () => {
        activeCategory = cat.key;
        renderCategories(); renderPaletteStrip();
      });
      const sw = document.createElement('div');
      sw.className = 'cat-swatch'; sw.style.background = hex;
      sw.title = 'Click to edit this color';
      const name = document.createElement('div');
      name.className = 'cat-name'; name.textContent = cat.label;
      const input = document.createElement('input');
      input.className = 'cat-hex'; input.value = hex; input.spellcheck = false;
      input.addEventListener('click', e => e.stopPropagation());
      input.addEventListener('change', () => {
        const rgb = hexToRgb(input.value);
        if (rgb) {
          assignments[cat.key] = input.value.startsWith('#') ? input.value.toLowerCase() : '#' + input.value.toLowerCase();
          renderCategories();
          if (cat.key === 'primary') renderHarmonies();
        } else {
          window.showToast('Invalid hex value', 'error');
          input.value = hex;
        }
      });
      // clicking the swatch opens the color picker to fine-tune the assigned color
      sw.addEventListener('click', e => {
        e.stopPropagation();
        window.openColorPicker(sw, assignments[cat.key] || hex, newHex => {
          assignments[cat.key] = newHex;
          input.value = newHex;
          setPicked(newHex);
          if (cat.key === 'primary') renderHarmonies();
        });
      });
      const copy = document.createElement('button');
      copy.className = 'copy-mini'; copy.innerHTML = '&#10697;'; copy.title = 'Copy ' + hex;
      copy.addEventListener('click', e => { e.stopPropagation(); copyText(assignments[cat.key] || hex, hex + ' copied'); });
      row.appendChild(sw); row.appendChild(name); row.appendChild(input); row.appendChild(copy);
      list.appendChild(row);
    });
  }

  document.getElementById('copyAllBtn').addEventListener('click', () => {
    if (!Object.keys(assignments).length) { window.showToast('Upload images first', 'error'); return; }
    const text = CATEGORIES.map(c => assignments[c.key] || '').join('\n');
    copyText(text, 'All ' + CATEGORIES.length + ' hex values copied — paste into your spreadsheet column');
  });

  function renderOptions() {
    const wrap = document.getElementById('optionsWrap');
    wrap.innerHTML = '';
    optionSets.forEach(opt => {
      const card = document.createElement('div');
      card.className = 'option-card';
      const head = document.createElement('div');
      head.className = 'option-head';
      const name = document.createElement('div');
      name.className = 'option-name'; name.textContent = opt.name;
      const apply = document.createElement('button');
      apply.className = 'ghost-btn'; apply.textContent = 'Apply';
      apply.addEventListener('click', () => {
        assignments = Object.assign({}, opt.colors);
        renderCategories(); renderHarmonies();
        window.showToast(opt.name + ' applied');
      });
      head.appendChild(name); head.appendChild(apply);
      const strip = document.createElement('div');
      strip.className = 'option-strip';
      CATEGORIES.forEach(cat => {
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.style.background = opt.colors[cat.key];
        chip.title = cat.label + ' ' + opt.colors[cat.key] + ' — click to assign to ' + labelOf(activeCategory);
        chip.addEventListener('click', () => { setPicked(opt.colors[cat.key]); assign(activeCategory, opt.colors[cat.key]); });
        strip.appendChild(chip);
      });
      card.appendChild(head); card.appendChild(strip);
      wrap.appendChild(card);
    });
  }

  function renderHarmonies() {
    const wrap = document.getElementById('harmoniesWrap');
    wrap.innerHTML = '';
    const base = assignments.primary;
    if (!base) return;
    const rgb = hexToRgb(base);
    const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
    const sets = [
      ['Complementary', [base, hslToHex(h + 180, s, l)]],
      ['Analogous', [hslToHex(h - 30, s, l), base, hslToHex(h + 30, s, l)]],
      ['Split Complementary', [base, hslToHex(h + 150, s, l), hslToHex(h + 210, s, l)]],
      ['Triadic', [base, hslToHex(h + 120, s, l), hslToHex(h + 240, s, l)]],
      ['Shades & Tints', [hslToHex(h, s, Math.max(0.1, l * 0.4)), hslToHex(h, s, Math.max(0.15, l * 0.7)), base,
        hslToHex(h, s, Math.min(0.92, l + (1 - l) * 0.5)), hslToHex(h, s * 0.5, 0.95)]]
    ];
    sets.forEach(([label, colors]) => {
      const row = document.createElement('div');
      row.className = 'harmony-row';
      const lab = document.createElement('div');
      lab.className = 'harmony-label'; lab.textContent = label;
      const strip = document.createElement('div');
      strip.className = 'harmony-strip';
      colors.forEach(hex => {
        const chip = document.createElement('div');
        chip.className = 'chip'; chip.style.background = hex;
        chip.title = hex + ' — click to assign to ' + labelOf(activeCategory);
        chip.addEventListener('click', () => { setPicked(hex); assign(activeCategory, hex); });
        strip.appendChild(chip);
      });
      row.appendChild(lab); row.appendChild(strip);
      wrap.appendChild(row);
    });
  }

  // initial render (empty state)
  renderCategories();
})();
