// pdf-export.js — the drawings as a PDF, with the (filtered) pins drawn on them.
//
// One PDF page per sheet: the original drawing, the pins on top, and a strip across
// the top with the project, sheet, date, what's included, and a status legend.
//
// For PDF sheets the original page is copied in as-is (pdf-lib), so the linework stays
// sharp at any zoom and the file stays small. Image sheets are placed as images. If a
// PDF can't be copied (e.g. it's password-protected), that page falls back to a
// high-resolution picture of the sheet made with pdf.js.

import * as data from './db.js';
import { itemRef, compareItems, STATUSES } from './db.js';
import { el, toast, busy, optionCards, BRAND, STATUS_COLORS, GROUP_PIN_COLOR } from './ui.js';
import { getPdf } from './sheet-render.js';
import { loadVendorScript, downloadBlob } from './export.js';

const loadPdfLib = () => loadVendorScript('pdf-lib.min.js', 'PDFLib'); // ~0.5 MB

const MAX_IMAGE_PT = 2592;         // image sheets: long side at most 36" on the PDF page
const MAX_RASTER_PIXELS = 12_000_000; // fallback picture of a PDF page (fits phone memory)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pad2 = (n) => String(n).padStart(2, '0');

export function pdfFileName(projectName) {
  const d = new Date();
  const safe = projectName.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Project';
  return `${safe} - Punch Drawings ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.pdf`;
}

// Makes the PDF. `items` are the items to show as pins (already filtered).
// sheetIds: which sheets to include; default = every sheet that has at least one of the items.
// filterText: plain-English note of what's included ('' = everything).
export async function drawingsPdf({ project, drawings, items, filterText = '', sheetIds = null }) {
  const kit = await startPdf(`${project.name} – Punch list drawings`);
  const sheets = drawings.filter((d) => (sheetIds ? sheetIds.includes(d.id) : items.some((i) => i.drawingId === d.id)));
  if (!sheets.length) throw new Error('None of these items are on a drawing.');
  for (const drawing of sheets) {
    const pins = items.filter((i) => i.drawingId === drawing.id).sort(compareItems);
    await addDrawingPage(kit, { drawing, pins, title: project.name, filterText });
  }
  return new Blob([await kit.out.save()], { type: 'application/pdf' });
}

// A new PDF plus what every page needs: fonts, the logo, and a cache of opened drawing files.
// (Also used by report-pdf.js.)
export async function startPdf(title) {
  await loadPdfLib();
  const { PDFDocument, StandardFonts } = window.PDFLib;
  const out = await PDFDocument.create();
  out.setTitle(title);
  out.setCreator(BRAND.name);
  out.setProducer(BRAND.name);
  return {
    out,
    fonts: {
      regular: await out.embedFont(StandardFonts.Helvetica),
      bold: await out.embedFont(StandardFonts.HelveticaBold),
    },
    logo: await embedLogo(out),
    sources: new Map(), // fileId -> Promise<PDFDocument | null>
    today: new Date().toLocaleDateString(),
  };
}

// One sheet with its pins and the header strip.
// paper: null = page is the drawing's own size (e.g. 24x36); or [w, h] in points (e.g. 11x17 =
// [1224, 792]) to fit the drawing on that paper, turned to match the drawing's orientation.
export async function addDrawingPage(kit, { drawing, pins, title, filterText, paper = null, footerSpace = 0 }) {
  const { out, fonts, logo, sources, today } = kit;
  // The sheet's size as shown in the app (PDF points, rotation already applied).
  const k = drawing.fileType === 'image' ? Math.min(1, MAX_IMAGE_PT / Math.max(drawing.widthPx, drawing.heightPx)) : 1;
  const sw = drawing.widthPx * k;
  const sh = drawing.heightPx * k;
  let page;
  let box; // where the drawing goes on the page
  let bandH;
  let pinSize = null;
  if (!paper) {
    bandH = clamp(Math.min(sw, sh) * 0.045, 50, 110);
    page = out.addPage([sw, sh + bandH]);
    box = { x: 0, y: 0, w: sw, h: sh };
  } else {
    const [a, b] = paper;
    const [pw, ph] = sw >= sh ? [Math.max(a, b), Math.min(a, b)] : [Math.min(a, b), Math.max(a, b)];
    page = out.addPage([pw, ph]);
    bandH = 50;
    const m = 18;
    const area = { x: m, y: m + footerSpace, w: pw - 2 * m, h: ph - bandH - 2 * m - footerSpace };
    const s = Math.min(area.w / sw, area.h / sh);
    box = { x: area.x + (area.w - sw * s) / 2, y: area.y + (area.h - sh * s) / 2, w: sw * s, h: sh * s };
    page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, borderColor: color('#d5dae1'), borderWidth: 0.75 });
    pinSize = 15;
  }

  if (drawing.fileType === 'pdf') await placePdfPage(out, page, drawing, box, sources);
  else await placeImage(out, page, drawing, box);

  drawPins(page, pins, box, fonts.bold, pinSize);
  drawBand(page, {
    x: 0, y: page.getHeight() - bandH, w: page.getWidth(), h: bandH, fonts, logo, pins, today,
    title, sheet: drawing.name, filterText,
  });
  return page;
}

// ---------- The drawing itself ----------

// box: { x, y, w, h } on the page where the sheet goes (the sheet is scaled to fill it).
async function placePdfPage(out, page, drawing, box, sources) {
  const { PDFDocument, degrees } = window.PDFLib;
  if (!sources.has(drawing.fileId)) {
    sources.set(drawing.fileId, (async () => {
      const blob = await data.getFileBlob(drawing.fileId);
      return PDFDocument.load(await blob.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
    })().catch((err) => { console.warn('Copying the PDF failed; using a picture instead.', err); return null; }));
  }
  const src = await sources.get(drawing.fileId);
  if (src) {
    try {
      const sp = src.getPage(drawing.pageNumber - 1);
      // The app shows the page's crop box (trimmed to its media box), like any PDF viewer.
      const crop = sp.getCropBox();
      const media = sp.getMediaBox();
      const clip = {
        left: Math.max(crop.x, media.x),
        bottom: Math.max(crop.y, media.y),
        right: Math.min(crop.x + crop.width, media.x + media.width),
        top: Math.min(crop.y + crop.height, media.y + media.height),
      };
      const embedded = await out.embedPage(sp, clip);
      const s = box.w / drawing.widthPx; // 1 = full size
      // Pages can be stored sideways with a "rotate" setting. Turn the page so it
      // matches what the app shows; pdf-lib rotates around the bottom-left corner.
      const rot = (((sp.getRotation().angle || 0) % 360) + 360) % 360;
      const at = { 0: [0, 0], 90: [0, box.h], 180: [box.w, box.h], 270: [box.w, 0] }[rot] || [0, 0];
      page.drawPage(embedded, {
        x: box.x + at[0],
        y: box.y + at[1],
        width: (clip.right - clip.left) * s,
        height: (clip.top - clip.bottom) * s,
        rotate: degrees(-rot),
      });
      return;
    } catch (err) {
      console.warn('Copying the PDF page failed; using a picture instead.', err);
    }
  }
  // Fallback: a picture of the page, rendered the same way the app shows it.
  const blob = await data.getFileBlob(drawing.fileId);
  const pdfPage = await (await getPdf(drawing.fileId, blob)).getPage(drawing.pageNumber);
  const scale = Math.min(4, Math.sqrt(MAX_RASTER_PIXELS / (drawing.widthPx * drawing.heightPx)));
  const vp = pdfPage.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
  const jpg = await canvasToJpeg(canvas);
  page.drawImage(await out.embedJpg(jpg), { x: box.x, y: box.y, width: box.w, height: box.h });
}

async function placeImage(out, page, drawing, box) {
  const blob = await data.getFileBlob(drawing.fileId);
  let image;
  if (blob.type === 'image/png') {
    image = await out.embedPng(await blob.arrayBuffer());
  } else {
    // JPEG/HEIC/etc. go through a canvas so phone photos come out the right way up
    // (the browser applies the photo's rotation tag; pdf-lib wouldn't).
    const bitmap = await createImageBitmap(blob);
    const k = Math.min(1, Math.sqrt(MAX_RASTER_PIXELS / (bitmap.width * bitmap.height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * k);
    canvas.height = Math.round(bitmap.height * k);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    image = await out.embedJpg(await canvasToJpeg(canvas));
  }
  page.drawImage(image, { x: box.x, y: box.y, width: box.w, height: box.h });
}

async function canvasToJpeg(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  canvas.width = canvas.height = 0; // frees memory on iOS
  if (!blob) throw new Error('This sheet is too big to turn into a picture on this device.');
  return blob.arrayBuffer();
}

async function embedLogo(out) {
  try {
    const res = await fetch(BRAND.logoOnLight);
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    return /png/i.test(res.headers.get('content-type') || BRAND.logoOnLight) ? out.embedPng(bytes) : out.embedJpg(bytes);
  } catch {
    return null; // no logo on the PDF; not worth failing the export over
  }
}

// ---------- Pins and the header strip ----------

export function color(hex) {
  const n = parseInt(hex.slice(1), 16);
  return window.PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// The standard PDF fonts only know Western characters; swap anything else for "?".
export function safeText(font, text) {
  let s = '';
  for (const ch of String(text || '').replace(/[\r\n\t]+/g, ' ')) {
    try { font.widthOfTextAtSize(ch, 10); s += ch; } catch { s += '?'; }
  }
  return s;
}

// Shortens text with "…" until it fits in maxW.
export function fitText(font, text, size, maxW) {
  let s = safeText(font, text);
  if (font.widthOfTextAtSize(s, size) <= maxW) return s;
  while (s.length > 1 && font.widthOfTextAtSize(`${s}…`, size) > maxW) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

// A circle, or a pill if w > h (for custom tags like CB-12). (cx, cy) is the center.
export function pill(page, cx, cy, w, h, c) {
  const r = h / 2;
  if (w <= h) {
    page.drawCircle({ x: cx, y: cy, size: r, color: c });
    return;
  }
  page.drawRectangle({ x: cx - w / 2 + r, y: cy - r, width: w - h, height: h, color: c });
  page.drawCircle({ x: cx - w / 2 + r, y: cy, size: r, color: c });
  page.drawCircle({ x: cx + w / 2 - r, y: cy, size: r, color: c });
}

// Pins on a printed sheet. There's no zooming on paper, so pins that would overlap at the
// printed size are grouped (by their printed size, so 11x17 groups more than full size):
//   - 1 pin: the normal pin, like the app (numbered circle with a point at the exact spot)
//   - 2-6 overlapping: "balloon" callouts — each item keeps its own numbered, colored circle,
//     fanned out around the spot, with a thin leader line to a dot at its exact location
//   - 7+: one gray pin listing the numbers ("3 · 7 · 12 +4"), with a dot at each exact spot
// (Idea for later, see CLAUDE.md: Bluebeam-style shaded box + enlarged "Detail A" panel.)
const MAX_BALLOONS = 6;

// box: where the sheet sits on the page. size: pin circle size in points (default scales with the sheet).
function drawPins(page, pins, box, font, size = null) {
  const d = size || clamp(Math.min(box.w, box.h) * 0.017, 17, 40);
  const spots = pins.map((item) => ({
    item,
    x: box.x + item.x * box.w,
    y: box.y + (1 - item.y) * box.h, // app measures from the top; PDF from the bottom
  }));
  for (const group of groupSpots(spots, d)) {
    if (group.length === 1) {
      const { item, x, y } = group[0];
      drawPin(page, font, d, x, y, itemRef(item), STATUS_COLORS[item.status] || STATUS_COLORS.Open, true);
    } else if (group.length <= MAX_BALLOONS) {
      drawBalloons(page, font, d, group, box);
    } else {
      drawCombined(page, font, d, group);
    }
  }
}

// Groups pins whose printed markers would overlap (chains count: if A overlaps B and B
// overlaps C, all three are one group).
function groupSpots(spots, d) {
  const overlaps = (a, b) => Math.abs(a.x - b.x) < d * 1.1 && Math.abs(a.y - b.y) < d * 1.5;
  const groups = [];
  for (const spot of spots) {
    const touching = groups.filter((g) => g.some((o) => overlaps(o, spot)));
    const merged = [spot, ...touching.flat()];
    for (const g of touching) groups.splice(groups.indexOf(g), 1);
    groups.push(merged);
  }
  return groups;
}

// One marker: a numbered circle/pill, with the point at (x, y) when `tail` is true,
// or centered on (x, y) when it's a balloon (no tail).
function drawPin(page, font, d, x, y, label, hex, tail) {
  const white = color('#ffffff');
  const c = color(hex);
  const border = d * 0.07;
  const fs = d * 0.42;
  const text = safeText(font, label);
  const tw = font.widthOfTextAtSize(text, fs);
  const w = Math.max(d, tw + d * 0.45);
  const cy = tail ? y + d * 0.81 : y;
  if (tail) {
    const a = d * 0.22;
    const path = `M 0 0 L ${-a} ${-d * 0.41} L ${a} ${-d * 0.41} Z`; // SVG y points down
    page.drawSvgPath(path, { x, y, color: white, borderColor: white, borderWidth: border * 1.6 });
    pill(page, x, cy, w + border * 2, d + border * 2, white);
    page.drawSvgPath(path, { x, y, color: c });
  } else {
    pill(page, x, cy, w + border * 2, d + border * 2, white);
  }
  pill(page, x, cy, w, d, c);
  page.drawText(text, { x: x - tw / 2, y: cy - fs * 0.36, size: fs, font, color: white });
}

// Small dot marking an item's exact spot (used by balloons and combined pins).
function drawSpotDot(page, d, x, y, hex) {
  page.drawCircle({ x, y, size: d * 0.16, color: color(hex), borderColor: color('#ffffff'), borderWidth: d * 0.05 });
}

// 2-6 overlapping pins: fan their circles out on an arc around the spot, each with a leader line.
function drawBalloons(page, font, d, group, box) {
  const ink = color('#1f2933');
  const cx = group.reduce((sum, g) => sum + g.x, 0) / group.length;
  const cy = group.reduce((sum, g) => sum + g.y, 0) / group.length;
  const members = [...group].sort((a, b) => a.x - b.x || compareItems(a.item, b.item)); // left to right = fewer crossings
  const n = members.length;
  const radius = d * (1.5 + n * 0.28);
  const spread = Math.min(150, 45 * (n - 1)); // degrees the fan covers
  const at = (upward) => members.map((m, i) => {
    const deg = 90 + spread / 2 - (n > 1 ? (spread * i) / (n - 1) : 0); // left to right
    const rad = ((upward ? deg : -deg) * Math.PI) / 180;
    return { m, x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
  });
  // Fan upward; if that runs off the sheet, fan downward; keep every balloon on the sheet.
  const inside = (b) => b.x > box.x + d && b.x < box.x + box.w - d && b.y > box.y + d && b.y < box.y + box.h - d;
  let balloons = at(true);
  if (!balloons.every(inside)) {
    const down = at(false);
    if (down.filter(inside).length > balloons.filter(inside).length) balloons = down;
  }
  for (const b of balloons) {
    b.x = clamp(b.x, box.x + d * 0.7, box.x + box.w - d * 0.7);
    b.y = clamp(b.y, box.y + d * 0.7, box.y + box.h - d * 0.7);
  }
  // Leaders first (under the circles), then the dots at the exact spots, then the circles.
  const lineW = Math.max(0.6, d * 0.055);
  for (const b of balloons) {
    page.drawLine({ start: { x: b.x, y: b.y }, end: { x: b.m.x, y: b.m.y }, thickness: lineW * 2.4, color: color('#ffffff') });
    page.drawLine({ start: { x: b.x, y: b.y }, end: { x: b.m.x, y: b.m.y }, thickness: lineW, color: ink });
  }
  for (const b of balloons) drawSpotDot(page, d, b.m.x, b.m.y, STATUS_COLORS[b.m.item.status] || STATUS_COLORS.Open);
  for (const b of balloons) {
    drawPin(page, font, d, b.x, b.y, itemRef(b.m.item), STATUS_COLORS[b.m.item.status] || STATUS_COLORS.Open, false);
  }
}

// 7+ overlapping pins: one gray pin that lists the numbers.
function drawCombined(page, font, d, group) {
  const members = [...group].sort((a, b) => compareItems(a.item, b.item));
  const cx = members.reduce((sum, g) => sum + g.x, 0) / members.length;
  const cy = members.reduce((sum, g) => sum + g.y, 0) / members.length;
  const shown = members.slice(0, 4).map((g) => itemRef(g.item)).join(' · ');
  const label = members.length > 4 ? `${shown} +${members.length - 4}` : shown;
  for (const g of members) drawSpotDot(page, d, g.x, g.y, STATUS_COLORS[g.item.status] || STATUS_COLORS.Open);
  drawPin(page, font, d, cx, cy, label, GROUP_PIN_COLOR, true);
}

function drawBand(page, { x, y, w, h, fonts, logo, pins, today, title, sheet, filterText }) {
  const ink = color('#1f2933');
  const muted = color('#5f6b7a');
  page.drawRectangle({ x, y, width: w, height: h, color: color('#ffffff') });
  page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: Math.max(1, h * 0.025), color: ink });

  const pad = h * 0.22;
  let left = x + pad;
  if (logo) {
    const lh = h * 0.66;
    const lw = lh * logo.width / logo.height;
    page.drawImage(logo, { x: left, y: y + (h - lh) / 2, width: lw, height: lh });
    left += lw + pad * 0.8;
  }

  // Legend on the right: a colored dot + "Open 5" for each status with pins on this sheet.
  const ls = h * 0.19;
  const dot = ls * 0.95;
  const entries = STATUSES
    .map((s) => ({ s, n: pins.filter((i) => i.status === s).length }))
    .filter((e) => e.n > 0)
    .map((e) => ({ ...e, text: `${e.s} ${e.n}`, tw: fonts.regular.widthOfTextAtSize(`${e.s} ${e.n}`, ls) }));
  const gap = ls * 1.2;
  const legendW = entries.reduce((sum, e) => sum + dot + ls * 0.35 + e.tw, 0) + gap * Math.max(0, entries.length - 1);
  let lx = x + w - pad - legendW;
  const ly = y + h / 2 - ls * 0.35;
  for (const e of entries) {
    page.drawCircle({ x: lx + dot / 2, y: ly + ls * 0.35, size: dot / 2, color: color(STATUS_COLORS[e.s]) });
    lx += dot + ls * 0.35;
    page.drawText(e.text, { x: lx, y: ly, size: ls, font: fonts.regular, color: ink });
    lx += e.tw + gap;
  }
  if (!entries.length) {
    const t = 'No pins shown';
    page.drawText(t, { x: x + w - pad - fonts.regular.widthOfTextAtSize(t, ls), y: ly, size: ls, font: fonts.regular, color: muted });
  }

  // Title lines on the left, trimmed so they never run into the legend.
  const maxW = Math.max(40, x + w - pad - Math.max(legendW, ls * 6) - pad - left);
  const t1 = h * 0.24;
  const t2 = h * 0.155;
  const pinCount = `${pins.length} pin${pins.length === 1 ? '' : 's'}`;
  const lines = [
    { text: title, size: t1, font: fonts.bold, c: ink },
    { text: `${sheet}  ·  ${today}  ·  ${pinCount}`, size: t2, font: fonts.regular, c: ink },
    filterText ? { text: `Showing: ${filterText}`, size: t2, font: fonts.regular, c: muted } : null,
  ].filter(Boolean);
  const lineGap = h * 0.05;
  const blockH = lines.reduce((sum, l) => sum + l.size, 0) + lineGap * (lines.length - 1);
  let ty = y + (h + blockH) / 2;
  for (const l of lines) {
    ty -= l.size;
    page.drawText(fitText(l.font, l.text, l.size, maxW), { x: left, y: ty + l.size * 0.2, size: l.size, font: l.font, color: l.c });
    ty -= lineGap;
  }
}

// ---------- Drawing tab: "PDF" button ----------

// items: the items the filters show (pins on screen). current: the sheet being viewed.
export function openDrawingPdfDialog({ project, drawings, current, items, filterText }) {
  const pinned = items.filter((i) => i.drawingId);
  const onCurrent = current ? pinned.filter((i) => i.drawingId === current.id) : [];
  const sheetsWithPins = drawings.filter((d) => pinned.some((i) => i.drawingId === d.id));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // Pick which sheets, then tap Export (picking alone never exports).
  const exportBtn = el('button', { type: 'button', class: 'btn btn-primary', onclick: run }, 'Export');
  const cards = optionCards({
    value: current ? 'this' : null,
    onSelect: () => { exportBtn.disabled = false; },
    options: [
      {
        value: 'this',
        label: 'This sheet',
        note: current ? `${current.name} · ${plural(onCurrent.length, 'pin')}` : 'No sheet open',
        disabled: !current,
      },
      {
        value: 'all',
        label: 'All sheets with pins',
        note: sheetsWithPins.length
          ? `${plural(sheetsWithPins.length, 'sheet')} · ${plural(pinned.length, 'pin')}`
          : 'No pins match your filters',
        disabled: !sheetsWithPins.length,
      },
    ],
  });
  exportBtn.disabled = !cards.value;

  async function run() {
    const sheetIds = cards.value === 'this' ? [current.id] : sheetsWithPins.map((d) => d.id);
    exportBtn.disabled = true;
    const done = busy('Making PDF…');
    try {
      const blob = await drawingsPdf({ project, drawings, items: pinned, filterText, sheetIds });
      downloadBlob(blob, pdfFileName(project.name));
      close();
      toast(`Saved ${plural(sheetIds.length, 'sheet')} as a PDF`);
    } catch (err) {
      console.error(err);
      toast(`Could not make the PDF: ${err.message}`, 4000);
      exportBtn.disabled = false;
    } finally {
      done();
    }
  }

  const layer = el('div', { class: 'pl-layer' },
    el('div', { class: 'pl-sheet' },
      el('div', { class: 'pl-sheet-head' },
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close() }, 'Cancel'),
        el('h2', {}, 'Drawings PDF'),
        exportBtn),
      el('div', { class: 'pl-sheet-body' },
        el('p', { class: 'meta' }, filterText
          ? `Only the pins your filters show are included (${filterText}).`
          : 'All pins are included. Use the status chips or trade filter first to narrow it down.'),
        cards.node,
        el('p', { class: 'meta' }, 'For a full package with the item list and photos, use Export → Printed report on the List tab.'))));
  document.body.append(layer);
  function close() { layer.remove(); }
}
