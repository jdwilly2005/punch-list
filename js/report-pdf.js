// report-pdf.js — the "Printed report": one PDF to print or email to a trade.
//
//   1. Cover — project, who it's for, date, what's included, counts by status, contents
//   2. Item list — a table made for paper (letter, landscape)
//   3. Drawings — each sheet with these items' pins, fitted to 11x17
//   4. Photos — 4 per page (letter), labeled to match the list
// Every page gets a footer with the project and "Page X of Y".
// Items appear in item-number order throughout.

import * as data from './db.js';
import { itemRef, itemName, compareItems, tradesText, STATUSES } from './db.js';
import { STATUS_COLORS } from './ui.js';
import { NO_TRADE } from './filters.js';
import { startPdf, addDrawingPage, color, safeText, fitText, pill } from './pdf-export.js';

const LETTER = [612, 792];
const TABLOID = [1224, 792]; // 11x17
const M = 36; // page margin (1/2")
const FOOTER = 22;
const PHOTO_EDGE = 1100; // px: plenty for a quarter page, keeps the file small enough to email

const pad2 = (n) => String(n).padStart(2, '0');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clean = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').trim();

// Who the report is for, from the trade filter ('' if not filtered to one trade).
export function reportAudience(filter) {
  if (!filter || !filter.trade) return '';
  return filter.trade === NO_TRADE ? 'Items with no trade set' : filter.trade;
}

export function reportFileName(projectName, filter) {
  const d = new Date();
  const who = reportAudience(filter);
  const parts = [clean(projectName) || 'Project', who && filter.trade !== NO_TRADE ? clean(who) : '', 'Punch Report'];
  return `${parts.filter(Boolean).join(' - ')} ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.pdf`;
}

// items: the items to include (already filtered). photoVersion: 'marked' | 'original'.
export async function reportPdf({ project, drawings, items, filter, filterText = '', photoVersion = 'marked' }) {
  const kit = await startPdf(`${project.name} – Punch list report`);
  const { out, fonts } = kit;
  const list = [...items].sort(compareItems);
  const drawingsById = Object.fromEntries(drawings.map((d) => [d.id, d]));
  const sheetName = (i) => (i.drawingId && drawingsById[i.drawingId] ? drawingsById[i.drawingId].name : 'List only');

  // Photos for these items, in item order.
  const allPhotos = await data.listProjectPhotos(project.id);
  const photosByItem = new Map();
  for (const p of allPhotos) {
    if (!photosByItem.has(p.itemId)) photosByItem.set(p.itemId, []);
    photosByItem.get(p.itemId).push(p);
  }

  const contents = [];

  // --- 2. Item list ---
  const listStart = out.getPageCount();
  drawItemTable(kit, list, { sheetName, photoCount: (i) => (photosByItem.get(i.id) || []).length });
  contents.push({ label: `Item list (${plural(list.length, 'item')})`, page: listStart });

  // --- 3. Drawings ---
  const sheets = drawings.filter((d) => list.some((i) => i.drawingId === d.id));
  if (sheets.length) {
    contents.push({ label: `Drawings (${plural(sheets.length, 'sheet')})`, page: out.getPageCount() });
    for (const drawing of sheets) {
      const pins = list.filter((i) => i.drawingId === drawing.id);
      await addDrawingPage(kit, { drawing, pins, title: project.name, filterText, paper: TABLOID, footerSpace: FOOTER - 8 });
    }
  }

  // --- 4. Photos ---
  const photoEntries = [];
  for (const item of list) {
    const ps = photosByItem.get(item.id) || [];
    ps.forEach((p, n) => photoEntries.push({ item, photo: p, n: n + 1, of: ps.length }));
  }
  if (photoEntries.length) {
    contents.push({ label: `Photos (${plural(photoEntries.length, 'photo')})`, page: out.getPageCount() });
    await drawPhotoPages(kit, photoEntries, { sheetName, photoVersion });
  }

  // --- 1. Cover (made last so it can list page numbers, then moved to the front) ---
  drawCover(kit, { project, list, filter, filterText, contents });

  // --- Footers ---
  const pages = out.getPages();
  pages.forEach((page, i) => {
    const w = page.getWidth();
    const size = 8.5;
    const left = fitText(fonts.regular, `${project.name} · Punch list report · ${kit.today}`, size, w / 2);
    const right = `Page ${i + 1} of ${pages.length}`;
    const muted = color('#5f6b7a');
    page.drawText(left, { x: M / 2, y: 10, size, font: fonts.regular, color: muted });
    page.drawText(right, {
      x: w - M / 2 - fonts.regular.widthOfTextAtSize(right, size), y: 10, size, font: fonts.regular, color: muted,
    });
  });

  return new Blob([await out.save()], { type: 'application/pdf' });
}

// ---------- Text helpers ----------

// Splits text into lines that fit maxW (breaking very long words if needed).
function wrap(font, text, size, maxW) {
  const lines = [];
  for (const para of safeText(font, text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const tryLine = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(tryLine, size) <= maxW) { line = tryLine; continue; }
      if (line) lines.push(line);
      line = word;
      while (font.widthOfTextAtSize(line, size) > maxW && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > maxW) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

// A status-colored number badge, like the pins. (x, y) = left edge, vertical center.
function badge(page, font, item, x, y, h) {
  const fs = h * 0.5;
  const label = safeText(font, itemRef(item));
  const tw = font.widthOfTextAtSize(label, fs);
  const w = Math.max(h, tw + h * 0.6);
  pill(page, x + w / 2, y, w, h, color(STATUS_COLORS[item.status] || STATUS_COLORS.Open));
  page.drawText(label, { x: x + (w - tw) / 2, y: y - fs * 0.35, size: fs, font, color: color('#ffffff') });
  return w;
}

// ---------- 1. Cover ----------

function drawCover(kit, { project, list, filter, filterText, contents }) {
  const { out, fonts, logo, today } = kit;
  const page = out.insertPage(0, LETTER);
  // Everything after the cover moved down one page.
  for (const c of contents) c.page += 1;
  const [W, H] = LETTER;
  const ink = color('#1f2933');
  const muted = color('#5f6b7a');
  const line = color('#d5dae1');
  let y = H - M;

  if (logo) {
    page.drawImage(logo, { x: M, y: y - 52, width: 52 * logo.width / logo.height, height: 52 });
  }
  y -= 96;
  page.drawText('Punch List', { x: M, y, size: 30, font: fonts.bold, color: ink });
  y -= 32;
  for (const l of wrap(fonts.bold, project.name, 20, W - 2 * M)) {
    page.drawText(l, { x: M, y, size: 20, font: fonts.bold, color: ink });
    y -= 25;
  }
  const who = reportAudience(filter);
  if (who) {
    y -= 4;
    page.drawText(fitText(fonts.regular, `For: ${who}`, 16, W - 2 * M), { x: M, y, size: 16, font: fonts.regular, color: ink });
    y -= 22;
  }
  y -= 6;
  page.drawText(`Printed ${today}`, { x: M, y, size: 11, font: fonts.regular, color: muted });
  y -= 16;
  for (const l of wrap(fonts.regular, `Included: ${filterText || 'All items'}`, 11, W - 2 * M)) {
    page.drawText(l, { x: M, y, size: 11, font: fonts.regular, color: muted });
    y -= 15;
  }

  // Counts by status
  y -= 22;
  page.drawText('Summary', { x: M, y, size: 13, font: fonts.bold, color: ink });
  y -= 10;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: line });
  for (const s of STATUSES) {
    const n = list.filter((i) => i.status === s).length;
    if (!n) continue;
    y -= 22;
    page.drawCircle({ x: M + 6, y: y + 4, size: 5.5, color: color(STATUS_COLORS[s]) });
    page.drawText(s, { x: M + 20, y, size: 12, font: fonts.regular, color: ink });
    const t = String(n);
    page.drawText(t, { x: W - M - fonts.bold.widthOfTextAtSize(t, 12), y, size: 12, font: fonts.bold, color: ink });
  }
  y -= 12;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: line });
  y -= 20;
  page.drawText('Total', { x: M + 20, y, size: 12, font: fonts.bold, color: ink });
  const tot = String(list.length);
  page.drawText(tot, { x: W - M - fonts.bold.widthOfTextAtSize(tot, 12), y, size: 12, font: fonts.bold, color: ink });

  // Contents
  y -= 40;
  page.drawText('Contents', { x: M, y, size: 13, font: fonts.bold, color: ink });
  y -= 10;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: line });
  for (const c of contents) {
    y -= 22;
    page.drawText(c.label, { x: M + 20, y, size: 12, font: fonts.regular, color: ink });
    const t = `page ${c.page + 1}`;
    page.drawText(t, { x: W - M - fonts.regular.widthOfTextAtSize(t, 12), y, size: 12, font: fonts.regular, color: muted });
  }
}

// ---------- 2. Item list ----------

function drawItemTable(kit, list, { sheetName, photoCount }) {
  const { out, fonts } = kit;
  const [W, H] = [LETTER[1], LETTER[0]]; // landscape
  const ink = color('#1f2933');
  const muted = color('#5f6b7a');
  const size = 9.5;
  const lh = 12; // line height
  const cols = [
    { key: 'num', label: '#', w: 50 },
    { key: 'item', label: 'Item', w: 228 },
    { key: 'status', label: 'Status', w: 100 },
    { key: 'trades', label: 'Trades / Subs', w: 112 },
    { key: 'location', label: 'Location', w: 100 },
    { key: 'sheet', label: 'Sheet', w: 88 },
    { key: 'photos', label: 'Photos', w: 42 },
  ];
  const pad = 5;
  let page;
  let y;

  const newPage = (first) => {
    page = out.addPage([W, H]);
    y = H - M;
    if (first) {
      page.drawText('Item list', { x: M, y: y - 14, size: 16, font: fonts.bold, color: ink });
      y -= 30;
    }
    // Header row (repeated on every page)
    page.drawRectangle({ x: M, y: y - 20, width: W - 2 * M, height: 20, color: color('#1f2933') });
    let x = M;
    for (const c of cols) {
      page.drawText(c.label, { x: x + pad, y: y - 14, size: 9, font: fonts.bold, color: color('#ffffff') });
      x += c.w;
    }
    y -= 20;
  };
  newPage(true);

  list.forEach((item, idx) => {
    const cell = (c) => c.w - 2 * pad;
    const titleLines = wrap(fonts.bold, item.title || '', size, cell(cols[1]));
    const descLines = item.description ? wrap(fonts.regular, item.description, size - 0.5, cell(cols[1])) : [];
    const cellLines = {
      trades: wrap(fonts.regular, tradesText(item) || '—', size, cell(cols[3])),
      location: wrap(fonts.regular, item.location || '—', size, cell(cols[4])),
      sheet: wrap(fonts.regular, sheetName(item), size, cell(cols[5])),
    };
    const lines = Math.max(titleLines.length + descLines.length, ...Object.values(cellLines).map((l) => l.length), 1);
    const rowH = Math.max(26, lines * lh + 2 * pad + 2);
    if (y - rowH < M + FOOTER) newPage(false);

    if (idx % 2 === 1) page.drawRectangle({ x: M, y: y - rowH, width: W - 2 * M, height: rowH, color: color('#f5f6f8') });
    page.drawLine({ start: { x: M, y: y - rowH }, end: { x: W - M, y: y - rowH }, thickness: 0.5, color: color('#d5dae1') });

    const top = y - pad - size; // baseline of the first text line
    let x = M;
    // #
    badge(page, fonts.bold, item, x + pad, y - pad - 8, 16);
    x += cols[0].w;
    // Item: title (bold) + description
    let ty = top;
    for (const l of titleLines) { page.drawText(l, { x: x + pad, y: ty, size, font: fonts.bold, color: ink }); ty -= lh; }
    for (const l of descLines) { page.drawText(l, { x: x + pad, y: ty, size: size - 0.5, font: fonts.regular, color: muted }); ty -= lh; }
    x += cols[1].w;
    // Status (colored dot + name)
    page.drawCircle({ x: x + pad + 4, y: top + 3, size: 4, color: color(STATUS_COLORS[item.status] || STATUS_COLORS.Open) });
    page.drawText(item.status, { x: x + pad + 12, y: top, size, font: fonts.regular, color: ink });
    x += cols[2].w;
    // Trades, location, sheet
    for (const key of ['trades', 'location', 'sheet']) {
      let cy = top;
      for (const l of cellLines[key]) { page.drawText(l, { x: x + pad, y: cy, size, font: fonts.regular, color: ink }); cy -= lh; }
      x += cols.find((c) => c.key === key).w;
    }
    // Photos
    const n = photoCount(item);
    page.drawText(n ? String(n) : '—', { x: x + pad, y: top, size, font: fonts.regular, color: n ? ink : muted });

    y -= rowH;
  });
}

// ---------- 4. Photos ----------

async function drawPhotoPages(kit, entries, { sheetName, photoVersion }) {
  const { out, fonts } = kit;
  const [W, H] = LETTER;
  const ink = color('#1f2933');
  const muted = color('#5f6b7a');
  const gap = 18;
  const headH = 28;
  const capH = 40;
  const cellW = (W - 2 * M - gap) / 2;
  const cellH = (H - 2 * M - FOOTER - headH - gap) / 2;
  const imgH = cellH - capH;

  for (let i = 0; i < entries.length; i += 4) {
    const page = out.addPage(LETTER);
    page.drawText(i === 0 ? 'Photos' : 'Photos (continued)', { x: M, y: H - M - 14, size: 16, font: fonts.bold, color: ink });
    const group = entries.slice(i, i + 4);
    for (let j = 0; j < group.length; j++) {
      const { item, photo, n, of } = group[j];
      const col = j % 2;
      const row = Math.floor(j / 2);
      const x = M + col * (cellW + gap);
      const top = H - M - headH - row * (cellH + gap);

      // Photo, fitted inside its box
      const blob = photoVersion === 'original' ? photo.originalBlob : (photo.annotatedBlob || photo.originalBlob);
      const box = { x, y: top - imgH, w: cellW, h: imgH };
      page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, color: color('#eef0f3') });
      if (blob) {
        try {
          const img = await out.embedJpg(await shrinkPhoto(blob));
          const s = Math.min(box.w / img.width, box.h / img.height);
          const w = img.width * s;
          const h = img.height * s;
          page.drawImage(img, { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, width: w, height: h });
        } catch (err) {
          console.warn('Photo skipped', err);
          page.drawText('Photo could not be read', { x: box.x + 10, y: box.y + box.h / 2, size: 9, font: fonts.regular, color: muted });
        }
      }

      // Caption: badge + title, then details
      const cy = box.y - 14;
      const bw = badge(page, fonts.bold, item, x, cy + 3, 15);
      page.drawText(fitText(fonts.bold, item.title || itemName(item), 10, cellW - bw - 8), {
        x: x + bw + 6, y: cy, size: 10, font: fonts.bold, color: ink,
      });
      const details = [
        of > 1 ? `photo ${n} of ${of}` : '',
        tradesText(item),
        item.location,
        sheetName(item),
      ].filter(Boolean).join(' · ');
      page.drawText(fitText(fonts.regular, details, 8.5, cellW), { x, y: cy - 14, size: 8.5, font: fonts.regular, color: muted });
    }
  }
}

// Shrinks a photo to PHOTO_EDGE on its long side (JPEG), so the PDF stays email-sized.
async function shrinkPhoto(blob) {
  const bitmap = await createImageBitmap(blob);
  const k = Math.min(1, PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * k);
  canvas.height = Math.round(bitmap.height * k);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const jpg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  canvas.width = canvas.height = 0; // frees memory on iOS
  return jpg.arrayBuffer();
}
