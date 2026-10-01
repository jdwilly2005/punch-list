// list-view.js — every punch item in the project as an editable spreadsheet.
//
// Edits made in the cells save right away and are reported back through
// onItemSaved, so the drawing's pins update to match.

import * as data from './db.js';
import { el, toast, statusKey } from './ui.js';
import { itemRef, itemName, compareItems, tradesText } from './db.js';
import { openTradePicker } from './trade-picker.js';
import { matches, isFiltering, describeFilter } from './filters.js';
import {
  toCsv, toXlsx, toProcoreXlsx, exportFileName, downloadBlob,
} from './export.js';
import { drawingsPdf, pdfFileName } from './pdf-export.js';

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
const PDF_TOO_KEY = 'punchlist:exportPdfToo';
const NO_SHEET = '__none__'; // sheet filter: items that aren't on a drawing

function loadPdfToo() {
  try { return localStorage.getItem(PDF_TOO_KEY) === '1'; } catch { return false; }
}
function savePdfToo(on) {
  try { localStorage.setItem(PDF_TOO_KEY, on ? '1' : '0'); } catch { /* not remembered */ }
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

  function openExportDialog() {
    const rows = shownItems();
    if (!rows.length) {
      toast('Nothing to export — no items match your filters.');
      return;
    }
    const narrowed = rows.length < ctx().items.length;
    const pinned = rows.filter((i) => i.drawingId);

    // "Also download the drawings PDF" — remembered on this device.
    const pdfToo = el('input', { type: 'checkbox', checked: loadPdfToo() && pinned.length > 0, disabled: !pinned.length });
    pdfToo.addEventListener('change', () => savePdfToo(pdfToo.checked));

    const makePdf = async () => {
      const { project, drawings } = ctx();
      return drawingsPdf({ project, drawings, items: pinned, filterText: describeFilters() });
    };

    const run = async (kind, btn) => {
      const buttons = [xlsxBtn, csvBtn, procoreBtn, pdfBtn];
      for (const b of buttons) b.disabled = true;
      const note = btn.querySelector('small');
      const noteText = note.textContent;
      try {
        const { project, drawings } = ctx();
        if (kind === 'pdf') {
          note.textContent = 'Making PDF…';
          downloadBlob(await makePdf(), pdfFileName(project.name));
        } else {
          let blob;
          let fileName;
          if (kind === 'procore') {
            blob = await toProcoreXlsx(rows, drawings);
            fileName = exportFileName(project.name, 'xlsx').replace('Punch List', 'Procore Punch Import');
          } else {
            blob = kind === 'xlsx' ? await toXlsx(rows, drawings, project, describeFilters()) : toCsv(rows, drawings);
            fileName = exportFileName(project.name, kind);
          }
          const pdf = pdfToo.checked ? (note.textContent = 'Making PDF…', await makePdf()) : null;
          downloadBlob(blob, fileName);
          if (pdf) {
            await new Promise((r) => setTimeout(r, 400)); // browsers drop downloads fired all at once
            downloadBlob(pdf, pdfFileName(project.name));
          }
        }
        close();
        toast(kind === 'pdf'
          ? `Saved ${pinned.length} pin${pinned.length === 1 ? '' : 's'} on the drawings`
          : `Exported ${rows.length} item${rows.length === 1 ? '' : 's'}${pdfToo.checked ? ' + drawings PDF' : ''}`);
      } catch (err) {
        console.error(err);
        toast(`Export failed: ${err.message}`, 4000);
        note.textContent = noteText;
        for (const b of buttons) b.disabled = false;
        pdfBtn.disabled = !pinned.length;
      }
    };
    const xlsxBtn = el('button', { type: 'button', class: 'btn btn-primary export-choice' },
      el('strong', {}, 'Excel (.xlsx)'), el('small', {}, 'Formatted, with a summary tab'));
    const csvBtn = el('button', { type: 'button', class: 'btn export-choice' },
      el('strong', {}, 'CSV'), el('small', {}, 'Plain text, opens anywhere'));
    const procoreBtn = el('button', { type: 'button', class: 'btn export-choice' },
      el('strong', {}, 'Procore import (.xlsx)'),
      el('small', {}, 'Filled-in copy of Procore\'s punch item import template'));
    const pdfBtn = el('button', { type: 'button', class: 'btn export-choice', disabled: !pinned.length },
      el('strong', {}, 'Drawings with pins (.pdf)'),
      el('small', {}, pinned.length
        ? 'Each sheet with these items\' pins, plus a legend'
        : 'None of these items are on a drawing'));
    xlsxBtn.addEventListener('click', () => run('xlsx', xlsxBtn));
    csvBtn.addEventListener('click', () => run('csv', csvBtn));
    procoreBtn.addEventListener('click', () => run('procore', procoreBtn));
    pdfBtn.addEventListener('click', () => run('pdf', pdfBtn));
    const closedCount = rows.filter((i) => i.status === 'Closed').length;

    const backdrop = el('div', { class: 'pl-layer' },
      el('div', { class: 'pl-sheet' },
        el('div', { class: 'pl-sheet-head' },
          el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close() }, 'Cancel'),
          el('h2', {}, 'Export punch list'),
          el('span', { class: 'head-spacer' })),
        el('div', { class: 'pl-sheet-body' },
          el('p', { class: 'meta' },
            `${rows.length} item${rows.length === 1 ? '' : 's'}, in the order shown in the list.`,
            narrowed || isFiltering(ctx().filter) ? ` Included: ${describeFilters()}.` : ''),
          xlsxBtn, csvBtn, procoreBtn,
          el('label', { class: 'check-row' }, pdfToo,
            el('span', {}, 'Also download the drawings with pins (.pdf) as a separate file')),
          pdfBtn,
          el('p', { class: 'meta' },
            'Procore\'s template has no status or photo columns, and people / due date / priority are '
            + 'left blank to fill in Procore. Get the photos from the Photos tab.',
            closedCount ? el('strong', { class: 'warn' },
              ` Heads up: ${closedCount} of these ${closedCount === 1 ? 'is' : 'are'} Closed — `
              + 'turn off the Closed chip first if you don\'t want to import them.') : null))));
    document.body.append(backdrop);
    function close() { backdrop.remove(); }
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
