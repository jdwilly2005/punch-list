// project-screen.js — one project, with tabs that share the same items and filters:
//   Drawing: sheets with pins (long-press to add)
//   List:    every item as an editable spreadsheet (+ Excel / CSV / Procore export)
//   Photos:  every item's photos, to download / share (e.g. into Procore)
// Any change on either tab updates the other, because both read the same `items`.

import * as data from './db.js';
import { el, toast, busy, statusKey, brandLink } from './ui.js';
import { readPdfPages, readImageSize } from './sheet-render.js';
import { DrawingView } from './drawing-view.js';
import { openItemForm } from './item-form.js';
import { openTradeManager, resolveTrade } from './trades.js';
import { createListView } from './list-view.js';
import { createPhotosView } from './photos-view.js';
import { openDrawingPdfDialog } from './pdf-export.js';
import {
  NO_TRADE, matches, matchesTrade, isFiltering, defaultFilter, loadFilter, saveFilter, describeFilter,
} from './filters.js';

// Chip labels: [normal, extra-short for phones]
const CHIP_LABEL = {
  'Open': ['Open', 'Open'],
  'In Progress': ['In Progress', 'Progress'],
  'Ready for Review': ['Review', 'Review'],
  'Closed': ['Closed', 'Closed'],
};
const MANAGE_TRADES = '__manage__';

// Remember which sheet was open last, per project (a convenience only).
function lastSheet(projectId, id) {
  const key = `punchlist:lastSheet:${projectId}`;
  try {
    if (id) localStorage.setItem(key, id);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// Draws the project screen into `app`. Returns a cleanup function (or null).
export async function renderProject(app, projectId, initialTab, isStale) {
  let project = await data.getProject(projectId);
  if (!project) {
    location.hash = '#/';
    return null;
  }
  let drawings = await data.listDrawings(projectId);
  let items = await data.listItems(projectId);
  if (isStale()) return null;

  let tab = initialTab;
  let current = null;        // sheet shown on the Drawing tab
  let drawingLoaded = false; // the Drawing tab loads its sheet the first time it's shown
  let filter = loadFilter(projectId);

  // ---------- Top bar with Drawing | List tabs ----------
  const tabBtns = {
    drawing: el('button', { type: 'button', class: 'tab', role: 'tab', onclick: () => setTab('drawing') }, 'Drawing'),
    list: el('button', { type: 'button', class: 'tab', role: 'tab', onclick: () => setTab('list') }, 'List'),
    photos: el('button', { type: 'button', class: 'tab', role: 'tab', onclick: () => setTab('photos') }, 'Photos'),
  };

  // ---------- Drawing tab ----------
  const sheetSelect = el('select', { class: 'sheet-select', 'aria-label': 'Sheet' });
  sheetSelect.addEventListener('change', () => showDrawing(sheetSelect.value));
  const fileInput = el('input', { type: 'file', accept: 'application/pdf,image/*', hidden: true });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (file) importFile(file);
  });
  const renameBtn = el('button', { type: 'button', class: 'btn', onclick: renameSheet }, 'Rename');
  const addBtn = el('button', { type: 'button', class: 'btn', onclick: () => fileInput.click() }, '+ Sheet');
  const pdfBtn = el('button', {
    type: 'button', class: 'btn', title: 'Save the drawings with pins as a PDF', onclick: exportPdf,
  }, 'PDF');
  const drawingToolbar = el('div', { class: 'toolbar' }, sheetSelect, renameBtn, addBtn, pdfBtn, fileInput);

  const stage = el('div', { class: 'stage' });
  const empty = el('div', { class: 'stage-empty' },
    el('p', { class: 'empty-title' }, 'Add a drawing to start dropping pins'),
    el('p', {}, 'PDF (every page becomes a sheet) or an image (JPG / PNG).'),
    el('button', { type: 'button', class: 'btn btn-primary', onclick: () => fileInput.click() }, 'Upload drawing'));
  const fitBtn = el('button', { type: 'button', class: 'btn fab', onclick: () => view.fit() }, 'Fit');
  const hint = el('div', { class: 'hint', hidden: true }, 'Press and hold the drawing to drop a pin · pinch to zoom');
  const filterCount = el('span', {});
  const filterNote = el('div', { class: 'filter-note', hidden: true }, filterCount,
    el('button', { type: 'button', class: 'link-btn', onclick: clearFilters }, 'Clear filters'));
  const drawingPane = el('div', { class: 'stage-wrap' }, stage, empty, fitBtn, hint, filterNote);

  // ---------- List tab ----------
  const list = createListView({
    ctx: () => ({ project, items, drawings, filter }),
    onOpenItem: openExisting,
    onNewItem: newListItem,
    onShowOnDrawing: showOnDrawing,
    onItemSaved: (updated) => {
      items = items.map((i) => (i.id === updated.id ? updated : i));
      refreshPins();
      refreshFilterBar();
    },
    onClearFilters: clearFilters,
  });
  list.onFiltersChanged = refreshFilterBar;

  // ---------- Photos tab ----------
  const photos = createPhotosView({ ctx: () => ({ project, items, filter }), onOpenItem: openExisting });

  // ---------- Filter bar (shared by both tabs) ----------
  const tradeFilter = el('select', { class: 'trade-filter', 'aria-label': 'Filter by trade' });
  tradeFilter.addEventListener('change', () => {
    if (tradeFilter.value === MANAGE_TRADES) {
      tradeFilter.value = filter.trade;
      manageTrades();
      return;
    }
    filter.trade = tradeFilter.value;
    filterChanged();
  });
  const chipRow = el('div', { class: 'chips', role: 'group', 'aria-label': 'Show statuses' });
  const filterBar = el('div', { class: 'filterbar' }, tradeFilter, chipRow);

  app.replaceChildren(
    el('header', { class: 'topbar' },
      brandLink({ back: true }),
      el('h1', {}, project.name),
      el('div', { class: 'tabs', role: 'tablist' }, tabBtns.drawing, tabBtns.list, tabBtns.photos)),
    drawingToolbar, list.toolbar, photos.toolbar, filterBar, drawingPane, list.body, photos.body);

  const view = new DrawingView(stage, {
    onLongPress: newItemAt,
    onEmptyTap: () => toast('Press and hold to drop a pin'),
    onPinTap: openExisting,
  });

  // ---------- Tabs ----------

  function setTab(next) {
    tab = next;
    for (const [key, btn] of Object.entries(tabBtns)) {
      btn.classList.toggle('active', key === tab);
      btn.setAttribute('aria-selected', String(key === tab));
    }
    drawingToolbar.hidden = drawingPane.hidden = tab !== 'drawing';
    list.toolbar.hidden = list.body.hidden = tab !== 'list';
    photos.toolbar.hidden = photos.body.hidden = tab !== 'photos';
    // Keep the tab in the address so a reload stays put (replaceState doesn't trigger a re-route).
    history.replaceState(null, '', `#/p/${projectId}${tab === 'drawing' ? '' : `/${tab}`}`);
    if (tab === 'drawing' && !drawingLoaded && drawings.length) showDrawing(lastSheet(projectId));
    if (tab === 'list') list.render();
    if (tab === 'photos') photos.render();
    refreshFilterBar();
  }

  // ---------- Drawing tab ----------

  const itemsOnSheet = () => items.filter((i) => current && i.drawingId === current.id);

  function refreshSheets() {
    sheetSelect.replaceChildren(...drawings.map((d) => el('option', { value: d.id }, d.name)));
    const has = drawings.length > 0;
    empty.hidden = has;
    sheetSelect.hidden = renameBtn.hidden = pdfBtn.hidden = fitBtn.hidden = !has;
    if (current) sheetSelect.value = current.id;
  }

  function refreshPins() {
    const onSheet = itemsOnSheet();
    const shown = onSheet.filter((i) => matches(i, filter));
    view.setItems(shown);
    hint.hidden = !current || onSheet.length > 0;
    filterNote.hidden = !isFiltering(filter) || onSheet.length === 0;
    filterCount.textContent = `Showing ${shown.length} of ${onSheet.length} pins · `;
  }

  async function showDrawing(id) {
    drawingLoaded = true;
    current = drawings.find((d) => d.id === id) || drawings[0];
    if (!current) return;
    sheetSelect.value = current.id;
    lastSheet(projectId, current.id);
    refreshPins();
    refreshFilterBar();
    try {
      await view.show(current, await data.getFileBlob(current.fileId));
    } catch (err) {
      console.error(err);
      toast(`Could not display this sheet: ${err.message}`);
    }
  }

  async function importFile(file) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf && !file.type.startsWith('image/')) {
      toast('Please pick a PDF or an image file.');
      return;
    }
    const done = busy(isPdf ? 'Reading PDF…' : 'Reading image…');
    try {
      const pages = isPdf ? await readPdfPages(file) : [{ pageNumber: 1, ...(await readImageSize(file)) }];
      const added = await data.addDrawings(projectId, file, isPdf ? 'pdf' : 'image', pages);
      drawings = await data.listDrawings(projectId);
      refreshSheets();
      refreshFilterBar();
      await showDrawing(added[0].id);
      toast(added.length > 1 ? `Added ${added.length} sheets` : 'Sheet added');
    } catch (err) {
      console.error(err);
      toast(`Could not import that file: ${err.message}`);
    } finally {
      done();
    }
  }

  async function renameSheet() {
    if (!current) return;
    const name = (window.prompt('Sheet name (e.g. A-101 Level 1 Plan)', current.name) || '').trim();
    if (!name) return;
    await data.updateDrawing(current.id, { name });
    drawings = await data.listDrawings(projectId);
    current = drawings.find((d) => d.id === current.id);
    refreshSheets();
  }

  // From the list's 📍 button: switch to the drawing, zoom to the pin, and flash it.
  async function showOnDrawing(id) {
    const item = items.find((i) => i.id === id);
    if (!item || !item.drawingId) return;
    const needLoad = !drawingLoaded || !current || current.id !== item.drawingId;
    drawingLoaded = true; // stop setTab from loading the last-viewed sheet instead
    setTab('drawing');
    if (needLoad) await showDrawing(item.drawingId);
    view.focusOn(item.x, item.y);
    if (matches(item, filter)) view.flashPin(item.id);
    else toast(`Pin ${data.itemName(item)} is hidden by your filters`);
  }

  // ---------- Items ----------

  async function reloadData() {
    project = await data.getProject(projectId);
    items = await data.listItems(projectId);
  }

  function refreshAll() {
    refreshPins();
    refreshFilterBar();
    if (tab === 'list') list.render();
    if (tab === 'photos') photos.render();
  }

  async function afterForm(result) {
    view.clearPendingPin();
    await reloadData();
    refreshAll();
    if (result && result.saved && !matches(result.saved, filter)) {
      toast(`Item ${data.itemName(result.saved)} saved, but it's hidden by your filters`, 3500);
    }
  }

  function newItemAt(x, y) {
    view.setPendingPin(x, y);
    openItemForm({
      project,
      drawing: current,
      item: { projectId, drawingId: current.id, x, y, status: 'Open', trade: '' },
      onClose: afterForm,
    });
  }

  // From the List tab's "+ Item": an item with no pin (it won't appear on any drawing).
  function newListItem() {
    openItemForm({
      project,
      drawing: null,
      item: { projectId, drawingId: null, x: null, y: null, status: 'Open', trade: '' },
      onClose: afterForm,
    });
  }

  function openExisting(id) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    const drawing = drawings.find((d) => d.id === item.drawingId) || null;
    openItemForm({ project, drawing, item, onClose: afterForm });
  }

  // Drawing tab's PDF button: this sheet or every sheet, with the pins the filters show.
  function exportPdf() {
    openDrawingPdfDialog({
      project,
      drawings,
      current,
      items: items.filter((i) => matches(i, filter)),
      filterText: describeFilter(filter),
    });
  }

  // ---------- Filters ----------

  function refreshFilterBar() {
    filterBar.hidden = tab === 'drawing' && drawings.length === 0;
    // Counts follow what's in view: this sheet on the Drawing tab; search/sheet choice on the List tab.
    const scope = { drawing: itemsOnSheet, list: list.scopeItems, photos: () => items }[tab]();
    const count = (test) => scope.filter(test).length;

    const trades = [...new Set([...project.trades, ...items.map((i) => i.trade).filter(Boolean)])];
    if (filter.trade && filter.trade !== NO_TRADE && !trades.includes(filter.trade)) trades.push(filter.trade);
    tradeFilter.replaceChildren(
      el('option', { value: '' }, 'All trades'),
      ...trades.map((t) => el('option', { value: t }, `${t} (${count((i) => i.trade === t)})`)),
      el('option', { value: NO_TRADE }, `No trade set (${count((i) => !i.trade)})`),
      el('option', { value: MANAGE_TRADES }, '⚙︎ Manage trades…'));
    tradeFilter.value = filter.trade;
    tradeFilter.classList.toggle('active', !!filter.trade);

    const tradeItems = scope.filter((i) => matchesTrade(i, filter));
    chipRow.replaceChildren(...data.STATUSES.map((s) => el('button', {
      type: 'button',
      class: 'chip',
      dataset: { status: statusKey(s) },
      'aria-pressed': String(filter.statuses.includes(s)),
      title: s,
      onclick: () => toggleStatus(s),
    }, el('span', { class: 'dot' }),
    el('span', { class: 'label-long' }, CHIP_LABEL[s][0]),
    el('span', { class: 'label-short' }, CHIP_LABEL[s][1]),
    el('span', { class: 'count' }, String(tradeItems.filter((i) => i.status === s).length)))));
  }

  function toggleStatus(status) {
    filter.statuses = filter.statuses.includes(status)
      ? filter.statuses.filter((s) => s !== status)
      : data.STATUSES.filter((s) => s === status || filter.statuses.includes(s));
    filterChanged();
  }

  function filterChanged() {
    saveFilter(projectId, filter);
    refreshAll();
  }

  function clearFilters() {
    filter = defaultFilter();
    filterChanged();
  }

  function manageTrades() {
    openTradeManager({
      projectId,
      onClose: async (result) => {
        if (!result.changed) return;
        await reloadData();
        if (filter.trade !== NO_TRADE) filter.trade = resolveTrade(filter.trade, result);
        filterChanged();
      },
    });
  }

  // ---------- Start ----------
  refreshSheets();
  setTab(tab);
  return () => {
    view.destroy();
    photos.destroy();
  };
}
