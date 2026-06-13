// color-picker.js
/* HSB color picker popover. Exposes window.openColorPicker(anchorEl, currentColor, onColorChange)
   and window.closeColorPicker(). Self-contained — no dependencies. */
/* global document, window */
(function () {
  'use strict';

  let _colorPopover = null;
  let _colorCallback = null;

  // Color conversion helpers (scoped to this module)
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return { r: 229, g: 57, b: 53 };
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  }
  function rgbToHsb(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === r) h = ((g - b) / d + 6) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = Math.round(h * 60);
    }
    const s = max > 0 ? Math.round(d / max * 100) : 0;
    const v = Math.round(max * 100);
    return { h, s, v };
  }
  function hsbToRgb(h, s, v) {
    s /= 100; v /= 100;
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
  }
  function hsbToHex(h, s, v) { const { r, g, b } = hsbToRgb(h, s, v); return rgbToHex(r, g, b); }

  function openColorPicker(anchorEl, currentColor, onColorChange) {
    closeColorPicker();
    _colorCallback = onColorChange;

    const { r: ir, g: ig, b: ib } = hexToRgb(currentColor || '#e53935');
    const { h: ih, s: is, v: iv } = rgbToHsb(ir, ig, ib);
    let cpH = ih, cpS = is, cpV = iv;
    let cpMode = 'HSB';

    const pop = document.createElement('div');
    pop.className = 'color-popover';
    pop.innerHTML =
      '<canvas class="cp-sb-canvas" id="cp-sb" width="300" height="160"></canvas>' +
      '<div class="cp-strips">' +
        '<div class="cp-strip-col">' +
          '<div class="cp-hue-bar" id="cp-hue"><div class="cp-strip-thumb" id="cp-hue-thumb"></div></div>' +
        '</div>' +
        '<div class="cp-preview-col"><div class="cp-preview-swatch" id="cp-preview"></div></div>' +
      '</div>' +
      '<div class="cp-mode-row">' +
        '<button class="cp-mode-btn active" data-mode="HSB">HSB</button>' +
        '<button class="cp-mode-btn" data-mode="RGB">RGB</button>' +
      '</div>' +
      '<div class="cp-inputs" id="cp-inputs"></div>';
    document.body.appendChild(pop);
    _colorPopover = pop;

    // Position anchored below the trigger, flipping if near viewport edges
    const r = anchorEl.getBoundingClientRect();
    let top = r.bottom + 6, left = r.left;
    if (left + 300 > window.innerWidth) left = window.innerWidth - 308;
    if (top + 320 > window.innerHeight) top = r.top - 326;
    pop.style.top = Math.max(8, top) + 'px';
    pop.style.left = Math.max(8, left) + 'px';

    const sbCanvas = pop.querySelector('#cp-sb');
    const sbCtx = sbCanvas.getContext('2d');
    const hueBar = pop.querySelector('#cp-hue');
    const hueThumb = pop.querySelector('#cp-hue-thumb');
    const preview = pop.querySelector('#cp-preview');
    const inputsEl = pop.querySelector('#cp-inputs');

    function drawSB() {
      const W = sbCanvas.width, H = sbCanvas.height;
      const gradH = sbCtx.createLinearGradient(0, 0, W, 0);
      gradH.addColorStop(0, '#fff');
      gradH.addColorStop(1, 'hsl(' + cpH + ',100%,50%)');
      sbCtx.fillStyle = gradH; sbCtx.fillRect(0, 0, W, H);
      const gradV = sbCtx.createLinearGradient(0, 0, 0, H);
      gradV.addColorStop(0, 'rgba(0,0,0,0)');
      gradV.addColorStop(1, 'rgba(0,0,0,1)');
      sbCtx.fillStyle = gradV; sbCtx.fillRect(0, 0, W, H);
      const cx = (cpS / 100) * W, cy = (1 - cpV / 100) * H;
      sbCtx.beginPath(); sbCtx.arc(cx, cy, 7, 0, Math.PI * 2);
      sbCtx.strokeStyle = '#fff'; sbCtx.lineWidth = 2; sbCtx.stroke();
      sbCtx.beginPath(); sbCtx.arc(cx, cy, 5, 0, Math.PI * 2);
      sbCtx.strokeStyle = 'rgba(0,0,0,0.4)'; sbCtx.lineWidth = 1; sbCtx.stroke();
    }
    function updateHueThumb() { hueThumb.style.left = (cpH / 360 * 100) + '%'; }
    function updatePreview() {
      const hex = hsbToHex(cpH, cpS, cpV);
      preview.style.background = hex;
      anchorEl.style.background = hex;
      if (_colorCallback) _colorCallback(hex);
    }
    function buildInputs() {
      inputsEl.innerHTML = '';
      if (cpMode === 'HSB') {
        [['H', cpH, 0, 360], ['S', cpS, 0, 100], ['B', cpV, 0, 100]].forEach(([lbl, val, mn, mx]) => {
          const g = document.createElement('div'); g.className = 'cp-input-group';
          g.innerHTML = '<input type="number" min="' + mn + '" max="' + mx + '" value="' + Math.round(val) + '" /><span class="cp-input-label">' + lbl + '</span>';
          const inp = g.querySelector('input');
          inp.addEventListener('change', () => {
            const v = Math.max(mn, Math.min(mx, parseInt(inp.value) || 0));
            inp.value = v;
            if (lbl === 'H') cpH = v; else if (lbl === 'S') cpS = v; else cpV = v;
            refreshAll();
          });
          inputsEl.appendChild(g);
        });
      } else {
        const { r: cr, g: cg, b: cb } = hsbToRgb(cpH, cpS, cpV);
        [['R', cr], ['G', cg], ['B', cb]].forEach(([lbl, val]) => {
          const gp = document.createElement('div'); gp.className = 'cp-input-group';
          gp.innerHTML = '<input type="number" min="0" max="255" value="' + Math.round(val) + '" /><span class="cp-input-label">' + lbl + '</span>';
          const inp = gp.querySelector('input');
          inp.addEventListener('change', () => {
            const ins = pop.querySelectorAll('.cp-input-group input');
            const rv = parseInt(ins[0].value) || 0;
            const gv = parseInt(ins[1].value) || 0;
            const bv = parseInt(ins[2].value) || 0;
            const hsb = rgbToHsb(Math.max(0, Math.min(255, rv)), Math.max(0, Math.min(255, gv)), Math.max(0, Math.min(255, bv)));
            cpH = hsb.h; cpS = hsb.s; cpV = hsb.v;
            refreshAll();
          });
          inputsEl.appendChild(gp);
        });
      }
      const hg = document.createElement('div'); hg.className = 'cp-input-group cp-hex-group';
      const hex = hsbToHex(cpH, cpS, cpV).slice(1).toUpperCase();
      hg.innerHTML = '<input type="text" maxlength="6" value="' + hex + '" /><span class="cp-input-label">#</span>';
      const hexInp = hg.querySelector('input');
      hexInp.addEventListener('change', () => {
        const v = '#' + hexInp.value.replace(/[^0-9a-fA-F]/g, '').padStart(6, '0').slice(0, 6);
        const { r: hr, g: hgr, b: hb } = hexToRgb(v);
        const hsb = rgbToHsb(hr, hgr, hb);
        cpH = hsb.h; cpS = hsb.s; cpV = hsb.v; refreshAll();
      });
      inputsEl.appendChild(hg);
    }
    function refreshAll() { drawSB(); updateHueThumb(); updatePreview(); buildInputs(); }
    refreshAll();

    pop.querySelectorAll('.cp-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        pop.querySelectorAll('.cp-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        cpMode = btn.dataset.mode;
        buildInputs();
      });
    });

    function sbPick(e) {
      const rect = sbCanvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(sbCanvas.width, (e.clientX - rect.left) * sbCanvas.width / rect.width));
      const y = Math.max(0, Math.min(sbCanvas.height, (e.clientY - rect.top) * sbCanvas.height / rect.height));
      cpS = Math.round(x / sbCanvas.width * 100);
      cpV = Math.round((1 - y / sbCanvas.height) * 100);
      refreshAll();
    }
    let sbDragging = false;
    sbCanvas.addEventListener('mousedown', e => { sbDragging = true; sbPick(e); e.preventDefault(); });
    document.addEventListener('mousemove', e => { if (sbDragging) sbPick(e); });
    document.addEventListener('mouseup', () => { sbDragging = false; });

    function huePick(e) {
      const rect = hueBar.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      cpH = Math.round(x / rect.width * 360);
      if (cpH >= 360) cpH = 359;
      refreshAll();
    }
    let hueDragging = false;
    hueBar.addEventListener('mousedown', e => { hueDragging = true; huePick(e); e.preventDefault(); });
    document.addEventListener('mousemove', e => { if (hueDragging) huePick(e); });
    document.addEventListener('mouseup', () => { hueDragging = false; });

    setTimeout(() => { document.addEventListener('mousedown', _outsideClick); }, 20);
  }

  function _outsideClick(e) {
    if (_colorPopover && !_colorPopover.contains(e.target)) closeColorPicker();
  }
  function closeColorPicker() {
    if (_colorPopover) { _colorPopover.remove(); _colorPopover = null; }
    document.removeEventListener('mousedown', _outsideClick);
  }

  window.openColorPicker = openColorPicker;
  window.closeColorPicker = closeColorPicker;
})();
