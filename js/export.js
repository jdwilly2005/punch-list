// export.js — downloads the punch list as an Excel (.xlsx) or CSV file.
//
// Columns are defined once in COLUMNS; add or reorder columns there and both
// formats follow. (A future "Procore import" format can reuse this file.)

import { STATUSES, itemRef } from './db.js';
import { STATUS_COLORS } from './ui.js';

const COLUMNS = [
  { header: '#', width: 8, value: (i) => (i.tag ? i.tag : i.number) }, // tag stays text, numbers stay numbers
  { header: 'Title', width: 34, value: (i) => i.title },
  { header: 'Status', width: 18, value: (i) => i.status },
  { header: 'Trade / Sub', width: 22, value: (i) => i.trade || '' },
  { header: 'Location', width: 24, value: (i) => i.location || '' },
  { header: 'Description', width: 50, value: (i) => i.description || '', wrap: true },
  { header: 'Sheet', width: 26, value: (i, sheetName) => sheetName(i) },
  { header: 'Created', width: 12, value: (i) => new Date(i.createdAt), date: true },
  { header: 'Updated', width: 12, value: (i) => new Date(i.updatedAt), date: true },
];

// Same colors as the app's pins (ARGB for Excel).
const STATUS_FILL = Object.fromEntries(
  Object.entries(STATUS_COLORS).map(([status, hex]) => [status, `FF${hex.slice(1).toUpperCase()}`]));
const HEADER_FILL = 'FF1F2933';

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function exportFileName(projectName, ext) {
  const safe = projectName.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Project';
  return `${safe} - Punch List ${isoDay(new Date())}.${ext}`;
}

function sheetNamer(drawings) {
  const byId = Object.fromEntries(drawings.map((d) => [d.id, d.name]));
  return (item) => byId[item.drawingId] || '';
}

// ---------- CSV ----------

export function toCsv(items, drawings) {
  const sheetName = sheetNamer(drawings);
  const cell = (v) => {
    let s = v instanceof Date ? isoDay(v) : String(v == null ? '' : v);
    if (/^[=+@\t]/.test(s)) s = `'${s}`; // stop Excel treating typed text as a formula
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [
    COLUMNS.map((c) => c.header),
    ...items.map((item) => COLUMNS.map((c) => c.value(item, sheetName))),
  ];
  const text = rows.map((r) => r.map(cell).join(',')).join('\r\n');
  // The leading BOM tells Excel the file is UTF-8 (so symbols like ° and ″ survive).
  return new Blob([`﻿${text}\r\n`], { type: 'text/csv;charset=utf-8' });
}

// ---------- Loading big libraries only when needed ----------

const loading = {};
// Loads vendor/<file> once and resolves when window[globalName] exists.
export function loadVendorScript(file, globalName) {
  if (window[globalName]) return Promise.resolve();
  if (!loading[file]) {
    loading[file] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL(`../vendor/${file}`, import.meta.url).href;
      s.onload = resolve;
      s.onerror = () => {
        delete loading[file];
        reject(new Error(`Could not load ${file}.`));
      };
      document.head.append(s);
    });
  }
  return loading[file];
}

const loadExcelJS = () => loadVendorScript('exceljs.min.js', 'ExcelJS'); // ~1 MB

// ---------- Excel ----------

function styleHeader(row) {
  row.height = 22;
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    c.alignment = { vertical: 'middle' };
  });
}

// filterText: plain-English description of what's included, shown on the Summary tab.
export async function toXlsx(items, drawings, project, filterText) {
  await loadExcelJS();
  const sheetName = sheetNamer(drawings);
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Punch List';
  wb.created = new Date();

  // --- Tab 1: the punch list ---
  const ws = wb.addWorksheet('Punch List', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, width: c.width }));
  styleHeader(ws.getRow(1));
  for (const item of items) {
    const row = ws.addRow(COLUMNS.map((c) => c.value(item, sheetName)));
    row.alignment = { vertical: 'top' };
    COLUMNS.forEach((c, idx) => {
      const cell = row.getCell(idx + 1);
      if (c.date) {
        // Excel reads dates as UTC; rebuild from local calendar parts so evening items don't roll to tomorrow.
        const d = cell.value;
        cell.value = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        cell.numFmt = 'm/d/yyyy';
      }
      if (c.wrap) cell.alignment = { vertical: 'top', wrapText: true };
    });
    const statusCell = row.getCell(COLUMNS.findIndex((c) => c.header === 'Status') + 1);
    statusCell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_FILL[item.status] || HEADER_FILL } };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };

  // --- Tab 2: summary counts by trade and status ---
  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ width: 28 }, ...STATUSES.map(() => ({ width: 16 })), { width: 10 }];
  sum.addRow([project.name]).font = { bold: true, size: 14 };
  sum.addRow([`Exported ${new Date().toLocaleString()}`]);
  sum.addRow([`Included: ${filterText}`]);
  sum.addRow([]);
  styleHeader(sum.addRow(['Trade / Sub', ...STATUSES, 'Total']));
  const trades = [...new Set(items.map((i) => i.trade || ''))]
    .sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
  for (const t of trades) {
    const mine = items.filter((i) => (i.trade || '') === t);
    sum.addRow([t || '(No trade set)', ...STATUSES.map((s) => mine.filter((i) => i.status === s).length), mine.length]);
  }
  const totals = sum.addRow(['Total', ...STATUSES.map((s) => items.filter((i) => i.status === s).length), items.length]);
  totals.font = { bold: true };
  totals.eachCell((c) => { c.border = { top: { style: 'thin' } }; });

  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---------- Procore punch item import ----------
//
// Fills in Procore's own import template (templates/procore-punch-import.xlsx) so its
// dropdowns and formatting are kept. Columns are found by their header text, so a newer
// template with columns moved around still works. Procore-only fields (people, due date,
// priority, cost/schedule impact) are left blank to fill in Procore. The template has no
// Status or photo columns.

export async function toProcoreXlsx(items, drawings) {
  await loadExcelJS();
  const res = await fetch(new URL('../templates/procore-punch-import.xlsx', import.meta.url));
  if (!res.ok) throw new Error('The Procore template file is missing.');
  const wb = new window.ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  const ws = wb.worksheets[0];

  const colOf = {};
  ws.getRow(1).eachCell((cell, n) => { colOf[String(cell.value).trim().toLowerCase()] = n; });
  if (!colOf['item name']) throw new Error('The Procore template doesn\'t look right (no "Item Name" column).');

  const sheetName = sheetNamer(drawings);
  items.forEach((item, idx) => {
    const row = ws.getRow(idx + 2);
    const put = (header, value) => {
      const n = colOf[header.toLowerCase()];
      if (n && value !== '' && value != null) row.getCell(n).value = value;
    };
    put('Item Name', item.title);
    put('Punch Item Number', item.tag || item.number);
    put('Location', item.location || '');
    put('Trade', item.trade || '');
    if (item.drawingId) put('Reference', `${sheetName(item)} – pin ${itemRef(item)}`);
    put('Description', item.description || '');
    row.commit();
  });

  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---------- Saving ----------

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
