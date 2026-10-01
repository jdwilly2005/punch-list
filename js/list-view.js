// list-view.js — every punch item in the project as an editable spreadsheet.
//
// Edits made in the cells save right away and are reported back through
// onItemSaved, so the drawing's pins update to match.

import * as data from './db.js';
import { el, toast, busy, statusKey, optionCards } from './ui.js';
import { itemRef, itemName, compareItems, tradesText } from './db.js';
import { openTradePicker } from './trade-picker.js';
import { matches, isFiltering, describeFilter } from './filters.js';
import {
  toCsv, toXlsx, toProcoreXlsx, exportFileName, downloadBlob,
} from './export.js';
import { drawingsPdf, pdfFileName } from './pdf-export.js';
import { reportPdf, reportFileName } from './report-pdf.js';

const COLUMNS = [
  { key: 'number', label: '#' },
  { key: 'title', label: 'Title' },
  { key: 'status', label: 'Status' },
  { key: 'trade', label: 'Trades / Subs' },
  { key: 'location', label: 'Location' },
  { key: 'description', label: 'Description' },
  { key: 'sheet', label: 'Sheet' },
  { key: 'updatedAt', label: 'Updated' },
];

const SORT_KEY = 'punchlist:listSort';
const NO_SHEET = '__none__'; // sheet filter: items that aren't on a drawing

// Export dialog choices remembered on this device (conveniences only).
function loadPref(key, fallback) {
  try { const v = localStorage.getItem(`punchlist:${key}`); return v == null ? fallback : v; } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(`punchlist:${key}`, value); } catch { /* not remembered */ }
}

function loadSort() {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_KEY));
    if (saved && COLUMNS.some((c) => c.key === saved.key)) return saved;
  } catch {
    // fall through to default
  }
  return { key: 'number', dir: 'asc' };
}

function saveSort(sort) {
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify(sort));
  } catch {
    // not remembered; fine
  }
}

const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// ctx() returns the project screen's current { project, items, drawings, filter }.
export function createListView({
  ctx, onOpenItem, onNewItem, onShowOnDrawing, onItemSaved, onClearFilters, onTradesChanged,
}) {
  let sort = loadSort();
  let search = '';
  let sheetId = '';

  const searchInput = el('input', {
    type: 'search', placeholder: 'Search title, location, #…', 'aria-label': 'Search items', autocomplete: 'off',
  });
  searchInput.addEventListener('input', () => {
    search = searchInput.value.trim().toLowerCase().replace(/^#/, '');
    render();
    onFiltersChanged();
  });
  const sheetFilter = el('select', { class: 'list-sheet-filter', 'aria-label': 'Filter by sheet' });
  sheetFilter.addEventListener('change', () => {
    sheetId = sheetFilter.value;
    render();
    onFiltersChanged();
  });

  const summary = el('div', { class: 'list-summary' });
  const table = el('table', { class: 'punch-table' });
  const exportBtn = el('button', { type: 'button', class: 'btn', onclick: openExportDialog }, 'Export');
  const newBtn = el('button', {
    type: 'button', class: 'btn', title: 'Add an item that isn\'t on a drawing', onclick: () => onNewItem(),
  }, '+ Item');
  const toolbar = el('div', { class: 'toolbar' }, searchInput, sheetFilter, newBtn, exportBtn);
  const body = el('div', { class: 'list-body' }, summary, el('div', { class: 'table-wrap' }, table));

  // Set by the project screen so chip counts follow the search / sheet choice.
  let onFiltersChanged = () => {};

  function matchesSearch(item) {
    if (!search) return true;
    return [itemRef(item), item.title, item.description, item.location, tradesText(item)]
      .join(' ').toLowerCase().includes(search);
  }

  // Items that pass the list-only filters (sheet + search), before status/trade filters.
  const matchesSheet = (item) => !sheetId || (sheetId === NO_SHEET ? !item.drawingId : item.drawingId === sheetId);

  function scopeItems() {
    return ctx().items.filter((i) => matchesSheet(i) && matchesSearch(i));
  }

  const isShown = (item) => matchesSheet(item) && matchesSearch(item) && matches(item, ctx().filter);

  function sortItems(list, drawingsById) {
    const dir = sort.dir === 'asc' ? 1 : -1;
    if (sort.key === 'number') return list.sort((a, b) => compareItems(a, b) * dir);
    const value = (item) => {
      switch (sort.key) {
        case 'status': return data.STATUSES.indexOf(item.status);
        case 'trade': return tradesText(item).toLowerCase();
        case 'sheet': return drawingsById[item.drawingId] ? drawingsById[item.drawingId].sortOrder : Infinity;
        default: return (item[sort.key] || '').toString().toLowerCase();
      }
    };
    return list.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === '' && vb !== '') return 1; // blanks always at the bottom
      if (vb === '' && va !== '') return -1;
      if (typeof va === 'number') return (va - vb) * dir || compareItems(a, b); // (Infinity - Infinity is NaN, so falls through)
      return va.localeCompare(vb, undefined, { numeric: true }) * dir || compareItems(a, b);
    });
  }

  // The rows the list is showing right now, in on-screen order.
  function shownItems() {
    const { items, drawings } = ctx();
    const drawingsById = Object.fromEntries(drawings.map((d) => [d.id, d]));
    return sortItems(items.filter(isShown), drawingsById);
  }

  function render() {
    const { project, items, drawings } = ctx();
    const drawingsById = Object.fromEntries(drawings.map((d) => [d.id, d]));

    if (sheetId && sheetId !== NO_SHEET && !drawingsById[sheetId]) sheetId = '';
    sheetFilter.replaceChildren(
      el('option', { value: '' }, 'All sheets'),
      ...drawings.map((d) => el('option', { value: d.id }, d.name)),
      el('option', { value: NO_SHEET }, 'Not on a drawing'));
    sheetFilter.value = sheetId;

    const shown = shownItems();

    const narrowed = shown.length < items.length;
    summary.replaceChildren(...[
      el('span', {}, narrowed ? `Showing ${shown.length} of ${items.length} items` : `${items.length} items`),
      narrowed ? el('button', { type: 'button', class: 'link-btn dark', onclick: clearAll }, 'Clear filters') : null,
      el('span', { class: 'summary-tip' }, 'Tap a cell to edit · changes save automatically'),
    ].filter(Boolean));

    const header = el('tr', {}, COLUMNS.map((c) => {
      const active = sort.key === c.key;
      return el('th', {
        class: `col-${c.key}`,
        'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : null,
      }, el('button', { type: 'button', onclick: () => setSort(c.key) },
        c.label, active ? el('span', { class: 'sort-arrow' }, sort.dir === 'asc' ? '▲' : '▼') : null));
    }));

    const rows = shown.map((item) => makeRow(item, drawingsById, project));
    if (!items.length) {
      rows.push(el('tr', {}, el('td', { class: 'table-empty', colspan: String(COLUMNS.length) },
        'No punch items yet. Long-press on a drawing to add one, or tap + Item.')));
    } else if (!shown.length) {
      rows.push(el('tr', {}, el('td', { class: 'table-empty', colspan: String(COLUMNS.length) },
        'No items match your filters.')));
    }
    table.replaceChildren(el('thead', {}, header), el('tbody', {}, rows));
  }

  function setSort(key) {
    sort = sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
    saveSort(sort);
    render();
  }

  function clearAll() {
    search = '';
    searchInput.value = '';
    sheetId = '';
    onClearFilters(); // resets status/trade filters and re-renders everything
  }

  // ----- Export -----

  // Plain-English summary of what's included, e.g. "Statuses: Open · Trade: ABC Drywall".
  function describeFilters() {
    const { filter, drawings } = ctx();
    const parts = [describeFilter(filter)].filter(Boolean);
    if (sheetId === NO_SHEET) parts.push('Not on a drawing');
    else if (sheetId) parts.push(`Sheet: ${(drawings.find((d) => d.id === sheetId) || {}).name}`);
    if (search) parts.push(`Search: "${search}"`);
    return parts.length ? parts.join(' · ') : 'All items';
  }

  // Pick a format, then tap Export (picking alone never exports).
  function openExportDialog() {
    const rows = shownItems();
    if (!rows.length) {
      toast('Nothing to export — no items match your filters.');
      return;
    }
    const narrowed = rows.length < ctx().items.length;
    const pinned = rows.filter((i) => i.drawingId);
    const closedCount = rows.filter((i) => i.status === 'Closed').length;
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

    const options = [
      { value: 'report', label: 'Printed report (.pdf)', note: 'Cover, item list, drawings on 11×17, photos 4 per page — to print or email to a trade' },
      { value: 'xlsx', label: 'Excel (.xlsx)', note: 'Formatted, with a summary tab' },
      { value: 'csv', label: 'CSV', note: 'Plain text, opens anywhere' },
      { value: 'procore', label: 'Procore import (.xlsx)', note: 'Filled-in copy of Procore\'s punch item import template' },
      {
        value: 'pdf',
        label: 'Drawings with pins (.pdf)',
        note: pinned.length ? 'Each sheet at full size with these items\' pins' : 'None of these items are on a drawing',
        disabled: !pinned.length,
      },
    ];

    // The "also save…" checkbox changes with the choice.
    const extras = {
      report: { key: 'exportReportXlsx', label: 'Also save the Excel list (.xlsx)' },
      xlsx: { key: 'exportPdfToo', label: 'Also save the drawings with pins (.pdf)', needsPins: true },
      csv: { key: 'exportPdfToo', label: 'Also save the drawings with pins (.pdf)', needsPins: true },
      procore: { key: 'exportPdfToo', label: 'Also save the drawings with pins (.pdf)', needsPins: true },
    };
    const alsoBox = el('input', { type: 'checkbox' });
    const alsoText = el('span', {});
    const alsoRow = el('label', { class: 'check-row' }, alsoBox, alsoText);
    alsoBox.addEventListener('change', () => {
      const x = extras[cards.value];
      if (x) savePref(x.key, alsoBox.checked ? '1' : '0');
    });
    const procoreNote = el('p', { class: 'meta' },
      'Procore\'s template has no status or photo columns, and people / due date / priority are '
      + 'left blank to fill in Procore. Get the photos from the Photos tab.',
      closedCount ? el('strong', { class: 'warn' },
        ` Heads up: ${closedCount} of these ${closedCount === 1 ? 'is' : 'are'} Closed — `
        + 'turn off the Closed chip first if you don\'t want to import them.') : null);
    const exportBtn = el('button', { type: 'button', class: 'btn btn-primary', onclick: run }, 'Export');

    const update = (kind) => {
      savePref('exportKind', kind || '');
      const x = extras[kind];
      alsoRow.hidden = !x;
      if (x) {
        alsoText.textContent = x.label;
        alsoBox.disabled = !!x.needsPins && !pinned.length;
        alsoBox.checked = !alsoBox.disabled && loadPref(x.key, '0') === '1';
      }
      procoreNote.hidden = kind !== 'procore';
      exportBtn.disabled = !kind;
    };
    const cards = optionCards({ options, value: loadPref('exportKind', null), onSelect: update });
    update(cards.value);

    async function run() {
      const kind = cards.value;
      if (!kind) return;
      const also = !alsoRow.hidden && alsoBox.checked;
      const { project, drawings, filter } = ctx();
      const filterText = describeFilters();
      exportBtn.disabled = true;
      const done = busy(kind === 'report' ? 'Making the report…' : 'Exporting…');
      try {
        const files = []; // [blob, fileName]
        if (kind === 'report') {
          files.push([await reportPdf({ project, drawings, items: rows, filter, filterText }), reportFileName(project.name, filter)]);
          if (also) files.push([await toXlsx(rows, drawings, project, filterText), exportFileName(project.name, 'xlsx')]);
        } else if (kind === 'pdf') {
          files.push([await drawingsPdf({ project, drawings, items: pinned, filterText }), pdfFileName(project.name)]);
        } else {
          if (kind === 'procore') {
            files.push([await toProcoreXlsx(rows, drawings),
              exportFileName(project.name, 'xlsx').replace('Punch List', 'Procore Punch Import')]);
          } else if (kind === 'xlsx') {
            files.push([await toXlsx(rows, drawings, project, filterText), exportFileName(project.name, 'xlsx')]);
          } else {
            files.push([toCsv(rows, drawings), exportFileName(project.name, 'csv')]);
          }
          if (also) files.push([await drawingsPdf({ project, drawings, items: pinned, filterText }), pdfFileName(project.name)]);
        }
        for (let i = 0; i < files.length; i++) {
          if (i) await new Promise((r) => setTimeout(r, 400)); // browsers drop downloads fired all at once
          downloadBlob(...files[i]);
        }
        close();
        toast(kind === 'pdf'
          ? `Saved ${plural(pinned.length, 'pin')} on the drawings`
          : `Exported ${plural(rows.length, 'item')}${files.length > 1 ? ` (${files.length} files)` : ''}`);
      } catch (err) {
        console.error(err);
        toast(`Export failed: ${err.message}`, 4000);
        exportBtn.disabled = false;
      } finally {
        done();
      }
    }

    const layer = el('div', { class: 'pl-layer' },
      el('div', { class: 'pl-sheet' },
        el('div', { class: 'pl-sheet-head' },
          el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close() }, 'Cancel'),
          el('h2', {}, 'Export'),
          exportBtn),
        el('div', { class: 'pl-sheet-body' },
          el('p', { class: 'meta' },
            `${plural(rows.length, 'item')}, as shown in the list.`,
            narrowed || isFiltering(ctx().filter) ? ` Included: ${describeFilters()}.` : ''),
          cards.node,
          alsoRow,
          procoreNote,
          el('p', { class: 'meta' }, 'Pick a format, then tap Export.'))));
    document.body.append(layer);
    function close() { layer.remove(); }
  }

  // ----- One row -----

  function makeRow(item, drawingsById, project) {
    const id = item.id;
    const tr = el('tr', { dataset: { id } });

    const badge = el('button', {
      type: 'button', class: 'num-badge', dataset: { status: statusKey(item.status) },
      title: 'Open full item (photos, delete…)', onclick: () => onOpenItem(id),
    }, itemRef(item));

    const textCell = (field, placeholder) => {
      const input = el('input', {
        type: 'text', class: 'cell-input', value: item[field] || '', placeholder, maxlength: '500',
        'aria-label': `${field} for item ${itemName(item)}`,
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
      input.addEventListener('change', () => {
        const value = input.value.trim();
        if (field === 'title' && !value) {
          toast('Title can\'t be empty');
          input.value = currentItem().title;
          return;
        }
        commit({ [field]: value });
      });
      return input;
    };

    const statusSelect = el('select', {
      class: 'cell-select status-select', dataset: { status: statusKey(item.status) },
      'aria-label': `Status for item ${itemName(item)}`,
    }, data.STATUSES.map((s) => el('option', { value: s }, s)));
    statusSelect.value = item.status;
    statusSelect.addEventListener('change', () => commit({ status: statusSelect.value }));

    // Trades: tap to pick one or more in a pop-up.
    const tradeCell = el('button', {
      type: 'button', class: 'trade-cell', 'aria-label': `Trades for item ${itemName(item)}`,
      onclick: () => openTradePicker({
        project,
        item: currentItem(),
        onTradesChanged,
        onDone: (trades) => commit({ trades }),
      }),
    });
    const showTrades = (it) => {
      tradeCell.textContent = tradesText(it) || '—';
      tradeCell.classList.toggle('empty-cell', !(it.trades || []).length);
    };
    showTrades(item);

    const drawing = drawingsById[item.drawingId];
    const updatedCell = el('td', { class: 'col-updatedAt muted' }, shortDate(item.updatedAt));

    tr.append(
      el('td', { class: 'col-number' }, badge),
      el('td', { class: 'col-title' }, textCell('title', 'Title')),
      el('td', { class: 'col-status' }, statusSelect),
      el('td', { class: 'col-trade' }, tradeCell),
      el('td', { class: 'col-location' }, textCell('location', '—')),
      el('td', { class: 'col-description' }, textCell('description', '—')),
      el('td', { class: 'col-sheet' }, item.drawingId
        ? el('button', {
          type: 'button', class: 'sheet-link', title: 'Show this pin on the drawing', onclick: () => onShowOnDrawing(id),
        }, '📍 ', drawing ? drawing.name : '?')
        : el('span', { class: 'muted no-pin', title: 'Added from the list — not on a drawing' }, 'List only')),
      updatedCell);

    const currentItem = () => ctx().items.find((i) => i.id === id) || item;

    async function commit(changes) {
      try {
        const updated = await data.updateItem(id, changes);
        onItemSaved(updated);
        // Update this row in place (no full re-render, so you don't lose your place).
        const key = statusKey(updated.status);
        badge.dataset.status = key;
        statusSelect.dataset.status = key;
        updatedCell.textContent = shortDate(updated.updatedAt);
        showTrades(updated);
        tr.classList.toggle('filtered-out', !isShown(updated));
        tr.title = isShown(updated) ? '' : 'Hidden by your filters — will disappear when the list refreshes';
        tr.classList.remove('saved');
        void tr.offsetWidth; // restart the flash animation
        tr.classList.add('saved');
      } catch (err) {
        console.error(err);
        toast(`Could not save: ${err.message}`);
      }
    }

    return tr;
  }

  return {
    toolbar,
    body,
    render,
    scopeItems,
    set onFiltersChanged(fn) { onFiltersChanged = fn; },
  };
}
