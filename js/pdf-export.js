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
import { el, toast, busy, BRAND, STATUS_COLORS } from './ui.js';
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
  await loadPdfLib();
  const { PDFDocument, StandardFonts } = window.PDFLib;
  const out = await PDFDocument.create();
  out.setTitle(`${project.name} – Punch list drawings`);
  out.setCreator(BRAND.name);
  out.setProducer(BRAND.name);
  const fonts = {
    regular: await out.embedFont(StandardFonts.Helvetica),
    bold: await out.embedFont(StandardFonts.HelveticaBold),
  };
  const logo = await embedLogo(out);

  const sheets = drawings.filter((d) => (sheetIds ? sheetIds.includes(d.id) : items.some((i) => i.drawingId === d.id)));
  if (!sheets.length) throw new Error('None of these items are on a drawing.');

  const sources = new Map(); // fileId -> Promise<PDFDocument | null>
  const today = new Date().toLocaleDateString();
  for (const drawing of sheets) {
    const pins = items.filter((i) => i.drawingId === drawing.id).sort(compareItems);
    await addSheet(out, { drawing, pins, project, filterText, today, fonts, logo, sources });
  }
  return new Blob([await out.save()], { type: 'application/pdf' });
}

async function addSheet(out, { drawing, pins, project, filterText, today, fonts, logo, sources }) {
  // Page size = the sheet as shown in the app (PDF points, rotation already applied).
  const k = drawing.fileType === 'image' ? Math.min(1, MAX_IMAGE_PT / Math.max(drawing.widthPx, drawing.heightPx)) : 1;
  const pw = drawing.widthPx * k;
  const ph = drawing.heightPx * k;
  const bandH = clamp(Math.min(pw, ph) * 0.045, 50, 110);
  const page = out.addPage([pw, ph + bandH]);

  if (drawing.fileType === 'pdf') await placePdfPage(out, page, drawing, pw, ph, sources);
  else await placeImage(out, page, drawing, pw, ph);

  drawPins(page, pins, pw, ph, fonts.bold);
  drawBand(page, {
    x: 0, y: ph, w: pw, h: bandH, fonts, logo, pins, today,
    title: project.name, sheet: drawing.name, filterText,
  });
}

// ---------- The drawing itself ----------

async function placePdfPage(out, page, drawing, pw, ph, sources) {
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
      const box = {
        left: Math.max(crop.x, media.x),
        bottom: Math.max(crop.y, media.y),
        right: Math.min(crop.x + crop.width, media.x + media.width),
        top: Math.min(crop.y + crop.height, media.y + media.height),
      };
      const embedded = await out.embedPage(sp, box);
      // Pages can be stored sideways with a "rotate" setting. Turn the page so it
      // matches what the app shows; pdf-lib rotates around the bottom-left corner.
      const rot = (((sp.getRotation().angle || 0) % 360) + 360) % 360;
      const at = { 0: [0, 0], 90: [0, ph], 180: [pw, ph], 270: [pw, 0] }[rot] || [0, 0];
      page.drawPage(embedded, {
        x: at[0], y: at[1], width: box.right - box.left, height: box.top - box.bottom, rotate: degrees(-rot),
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
  page.drawImage(await out.embedJpg(jpg), { x: 0, y: 0, width: pw, height: ph });
}

async function placeImage(out, page, drawing, pw, ph) {
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
  page.drawImage(image, { x: 0, y: 0, width: pw, height: ph });
}

async function canvasToJpeg(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  canvas.width = canvas.height = 0; // frees memory on iOS
  if (!blob) throw new Error('This sheet is too big to turn into a picture on this device.');
  return blob.arrayBuffer();
}

async function embedLogo(out) {
  try {
    const res = await fetch(BRAND.logo);
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    return /png/i.test(res.headers.get('content-type') || BRAND.logo) ? out.embedPng(bytes) : out.embedJpg(bytes);
  } catch {
    return null; // no logo on the PDF; not worth failing the export over
  }
}

// ---------- Pins and the header strip ----------

function color(hex) {
  const n = parseInt(hex.slice(1), 16);
  return window.PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// The standard PDF fonts only know Western characters; swap anything else for "?".
function safeText(font, text) {
  let s = '';
  for (const ch of String(text || '').replace(/[\r\n\t]+/g, ' ')) {
    try { font.widthOfTextAtSize(ch, 10); s += ch; } catch { s += '?'; }
  }
  return s;
}

// Shortens text with "…" until it fits in maxW.
function fitText(font, text, size, maxW) {
  let s = safeText(font, text);
  if (font.widthOfTextAtSize(s, size) <= maxW) return s;
  while (s.length > 1 && font.widthOfTextAtSize(`${s}…`, size) > maxW) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

// A circle, or a pill if w > h (for custom tags like CB-12). (cx, cy) is the center.
function pill(page, cx, cy, w, h, c) {
  const r = h / 2;
  if (w <= h) {
    page.drawCircle({ x: cx, y: cy, size: r, color: c });
    return;
  }
  page.drawRectangle({ x: cx - w / 2 + r, y: cy - r, width: w - h, height: h, color: c });
  page.drawCircle({ x: cx - w / 2 + r, y: cy, size: r, color: c });
  page.drawCircle({ x: cx + w / 2 - r, y: cy, size: r, color: c });
}

// Same shape as the app's pins: a numbered circle with a point at the exact spot.
function drawPins(page, pins, pw, ph, font) {
  const white = color('#ffffff');
  const d = clamp(Math.min(pw, ph) * 0.017, 17, 40); // circle size scales with the sheet
  const border = d * 0.07;
  const fs = d * 0.42;
  for (const item of pins) {
    const c = color(STATUS_COLORS[item.status] || STATUS_COLORS.Open);
    const tipX = item.x * pw;
    const tipY = (1 - item.y) * ph; // app measures from the top; PDF from the bottom
    const cy = tipY + d * 0.81;
    const label = safeText(font, itemRef(item));
    const tw = font.widthOfTextAtSize(label, fs);
    const w = Math.max(d, tw + d * 0.45);
    const a = d * 0.22;
    const tail = `M 0 0 L ${-a} ${-d * 0.41} L ${a} ${-d * 0.41} Z`; // SVG y points down
    page.drawSvgPath(tail, { x: tipX, y: tipY, color: white, borderColor: white, borderWidth: border * 1.6 });
    pill(page, tipX, cy, w + border * 2, d + border * 2, white);
    page.drawSvgPath(tail, { x: tipX, y: tipY, color: c });
    pill(page, tipX, cy, w, d, c);
    page.drawText(label, { x: tipX - tw / 2, y: cy - fs * 0.36, size: fs, font, color: white });
  }
}

function drawBand(page, { x, y, w, h, fonts, logo, pins, today, title, sheet, filterText }) {
  const ink = color('#1f2933');
  const muted = color('#5f6b7a');
  page.drawRectangle({ x, y, width: w, height: h, color: color('#ffffff') });
  page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: Math.max(1, h * 0.025), color: ink });

  const pad = h * 0.22;
  let left = x + pad;
  if (logo) {
    const s = h * 0.62;
    page.drawImage(logo, { x: left, y: y + (h - s) / 2, width: s, height: s });
    left += s + pad * 0.8;
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

  const run = async (sheetIds) => {
    const done = busy('Making PDF…');
    try {
      const blob = await drawingsPdf({ project, drawings, items: pinned, filterText, sheetIds });
      downloadBlob(blob, pdfFileName(project.name));
      close();
      toast(`Saved ${plural(sheetIds ? sheetIds.length : sheetsWithPins.length, 'sheet')} as a PDF`);
    } catch (err) {
      console.error(err);
      toast(`Could not make the PDF: ${err.message}`, 4000);
    } finally {
      done();
    }
  };

  const thisBtn = el('button', { type: 'button', class: 'btn btn-primary export-choice', disabled: !current },
    el('strong', {}, 'This sheet'),
    el('small', {}, current ? `${current.name} · ${plural(onCurrent.length, 'pin')}` : 'No sheet open'));
  thisBtn.addEventListener('click', () => run([current.id]));
  const allBtn = el('button', { type: 'button', class: 'btn export-choice', disabled: !sheetsWithPins.length },
    el('strong', {}, 'All sheets with pins'),
    el('small', {}, sheetsWithPins.length
      ? `${plural(sheetsWithPins.length, 'sheet')} · ${plural(pinned.length, 'pin')}`
      : 'No pins match your filters'));
  allBtn.addEventListener('click', () => run(sheetsWithPins.map((d) => d.id)));

  const backdrop = el('div', { class: 'modal-backdrop' },
    el('div', { class: 'modal' },
      el('div', { class: 'modal-head' },
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close() }, 'Cancel'),
        el('h2', {}, 'Drawings PDF'),
        el('span', { class: 'head-spacer' })),
      el('div', { class: 'modal-body' },
        el('p', { class: 'meta' }, filterText
          ? `Only the pins your filters show are included (${filterText}).`
          : 'All pins are included. Use the status chips or trade filter first to narrow it down.'),
        thisBtn, allBtn)));
  document.body.append(backdrop);
  function close() { backdrop.remove(); }
}
