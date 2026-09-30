// photo-markup.js — shrinking photos on import, and the arrow/circle markup editor.
//
// Markup is saved two ways: as a list of shapes (so it can be re-edited later)
// and as a flattened copy of the photo with the shapes burned in (for reports).

import { el } from './ui.js';

const MAX_PHOTO_EDGE = 2000; // px; phone photos are shrunk to this to save space
const COLORS = ['#ff3b30', '#ffcc00', '#0a84ff'];
const TOOLS = [
  { id: 'arrow', label: '↗ Arrow' },
  { id: 'circle', label: '◯ Circle' },
  { id: 'pen', label: '✎ Pen' },
];

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That photo could not be read.'));
    };
    img.src = url;
  });
}

function canvasToJpeg(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

// Downscale a camera photo to a sensible size and re-save as JPEG.
export async function preparePhoto(file) {
  const { img, url } = await loadImage(file);
  try {
    const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await canvasToJpeg(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Shapes are stored in the photo's own pixel coordinates.
function drawShape(ctx, shape, lineWidth) {
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 4;
  if (shape.type === 'arrow') {
    const { x1, y1, x2, y2 } = shape;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = lineWidth * 4.5;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2 - Math.cos(angle) * head * 0.6, y2 - Math.sin(angle) * head * 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45));
    ctx.lineTo(x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45));
    ctx.closePath();
    ctx.fill();
  } else if (shape.type === 'circle') {
    const { x1, y1, x2, y2 } = shape;
    ctx.beginPath();
    ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (shape.type === 'pen') {
    const [first, ...rest] = shape.points;
    ctx.beginPath();
    ctx.moveTo(first[0], first[1]);
    for (const [x, y] of rest) ctx.lineTo(x, y);
    ctx.stroke();
  }
  ctx.restore();
}

function shapeIsBigEnough(shape, minSize) {
  if (shape.type === 'pen') return shape.points.length > 2;
  return Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) >= minSize;
}

// Opens the full-screen editor. Resolves to { markup, annotatedBlob } on Done,
// or null on Cancel.
export async function openMarkup(photoBlob, initialShapes = []) {
  const { img, url } = await loadImage(photoBlob);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const lineWidth = Math.max(4, Math.round(Math.max(W, H) / 120));
  const shapes = initialShapes.map((s) => ({ ...s }));
  let tool = 'arrow';
  let color = COLORS[0];
  let current = null; // shape being drawn right now

  return new Promise((resolve) => {
    const canvas = el('canvas', { class: 'markup-canvas' });
    const stage = el('div', { class: 'markup-stage' }, canvas);

    const toolButtons = TOOLS.map((t) => el('button', {
      type: 'button', class: 'tool', dataset: { tool: t.id }, onclick: () => { tool = t.id; syncButtons(); },
    }, t.label));
    const colorButtons = COLORS.map((c) => el('button', {
      type: 'button', class: 'swatch', style: `background:${c}`, 'aria-label': `Color ${c}`,
      dataset: { color: c }, onclick: () => { color = c; syncButtons(); },
    }));
    const undoBtn = el('button', { type: 'button', class: 'tool', onclick: () => { shapes.pop(); redraw(); } }, '↶ Undo');
    const clearBtn = el('button', {
      type: 'button', class: 'tool', onclick: () => { shapes.length = 0; redraw(); },
    }, 'Clear');

    const overlay = el('div', { class: 'markup' },
      el('div', { class: 'markup-bar' },
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => finish(null) }, 'Cancel'),
        el('div', { class: 'markup-title' }, 'Mark up photo'),
        el('button', { type: 'button', class: 'btn btn-primary', onclick: done }, 'Done')),
      stage,
      el('div', { class: 'markup-tools' },
        el('div', { class: 'tool-row' }, toolButtons),
        el('div', { class: 'tool-row' }, colorButtons, undoBtn, clearBtn)));
    document.body.append(overlay);

    function syncButtons() {
      for (const b of toolButtons) b.classList.toggle('active', b.dataset.tool === tool);
      for (const b of colorButtons) b.classList.toggle('active', b.dataset.color === color);
      undoBtn.disabled = clearBtn.disabled = shapes.length === 0;
    }

    function layout() {
      const r = stage.getBoundingClientRect();
      const s = Math.min(r.width / W, r.height / H);
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = `${W * s}px`;
      canvas.style.height = `${H * s}px`;
      canvas.width = Math.round(W * s * dpr);
      canvas.height = Math.round(H * s * dpr);
      redraw();
    }

    function redraw() {
      const ctx = canvas.getContext('2d');
      const k = canvas.width / W;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.drawImage(img, 0, 0, W, H);
      for (const shape of shapes) drawShape(ctx, shape, lineWidth);
      if (current) drawShape(ctx, current, lineWidth);
      syncButtons();
    }

    function toImage(e) {
      const r = canvas.getBoundingClientRect();
      return {
        x: Math.round(((e.clientX - r.left) * W) / r.width),
        y: Math.round(((e.clientY - r.top) * H) / r.height),
      };
    }

    let frame = 0;
    canvas.addEventListener('pointerdown', (e) => {
      if (current) return; // ignore a second finger
      canvas.setPointerCapture(e.pointerId);
      const p = toImage(e);
      current = tool === 'pen'
        ? { type: 'pen', color, points: [[p.x, p.y]] }
        : { type: tool, color, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      current.pointerId = e.pointerId;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!current || e.pointerId !== current.pointerId) return;
      const p = toImage(e);
      if (current.type === 'pen') current.points.push([p.x, p.y]);
      else { current.x2 = p.x; current.y2 = p.y; }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(redraw);
    });
    const endShape = (e) => {
      if (!current || e.pointerId !== current.pointerId) return;
      delete current.pointerId;
      if (shapeIsBigEnough(current, lineWidth * 3)) shapes.push(current);
      current = null;
      redraw();
    };
    canvas.addEventListener('pointerup', endShape);
    canvas.addEventListener('pointercancel', endShape);

    window.addEventListener('resize', layout);
    requestAnimationFrame(layout);

    async function done() {
      if (!shapes.length) {
        finish({ markup: [], annotatedBlob: null });
        return;
      }
      const full = document.createElement('canvas');
      full.width = W;
      full.height = H;
      const ctx = full.getContext('2d');
      ctx.drawImage(img, 0, 0);
      for (const shape of shapes) drawShape(ctx, shape, lineWidth);
      finish({ markup: shapes, annotatedBlob: await canvasToJpeg(full) });
    }

    function finish(result) {
      window.removeEventListener('resize', layout);
      overlay.remove();
      URL.revokeObjectURL(url);
      resolve(result);
    }
  });
}
