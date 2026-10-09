// project-screen.js — one project, with tabs that share the same items and filters:
//   Drawing: sheets with pins (long-press to add)
//   List:    every item as an editable spreadsheet (+ Excel / CSV / Procore export)
//   Photos:  every item's photos, to download / share (e.g. into Procore)
// Any change on either tab updates the other, because both read the same `items`.

import * as data from './db.js';
import { el, toast, busy, statusKey, brandLink, choose } from './ui.js';
import { readPdfPages, readImageSize } from './sheet-render.js';
import { DrawingView } from './drawing-view.js';
import { openItemForm } from './item-form.js';
import { openTradeManager, resolveTrade } from './trades.js';
import { createListView } from './list-view.js';
import { createPhotosView } from './photos-view.js';
import { openDrawingPdfDialog } from './pdf-export.js';
import { headerActions } from './nav.js';
import { createPeopleTab } from './people.js';
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
  let sheetWaiting = false;  // the shown sheet's drawing file hasn't downloaded yet
  let filter = loadFilter(projectId);

  // ---------- Top bar with Drawing | List tabs ----------
  const tabBtns = {
    drawing: el('button', { type: 'button', class: 'tab', role: 'tab', onclick: () => setTab('drawing') }, 'Drawing'),
    list: el('button', { type: 'button', class: 'tab', role: 'tab', onclick: () => setTab('list') }, 'List'),
    photos: el('button', { type: 'button', class: 'tab', role: 'tab', onclick: () => setTab('photos') }, 'Photos'),
    people: el('button', { type: 'button', class: 'tab', role: 'tab', onclick: () => setTab('people') }, 'People'),
  };

  // Viewers and Trade members can look but not change anything (sync.js sets project.myRole).
  const readOnly = () => data.isReadOnlyRole(project.myRole);
  const VIEW_ONLY_MSG = 'You have view-only access to this project, so you can\'t add or change anything.';
  const startedReadOnly = readOnly();

  // ---------- Drawing tab ----------
  const sheetSelect = el('select', { class: 'sheet-select', 'aria-label': 'Sheet' });
  sheetSelect.addEventListener('change', () => showDrawing(sheetSelect.value));
  const fileInput = el('input', { type: 'file', accept: 'application/pdf,image/*', hidden: true });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (file) importFile(file);
  });
  const editBtn = el('button', { type: 'button', class: 'btn', onclick: editSheet }, 'Edit');
  const addBtn = el('button', { type: 'button', class: 'btn', onclick: () => fileInput.click() }, '+ Sheet');
  const pdfBtn = el('button', {
    type: 'button', class: 'btn', title: 'Save the drawings with pins as a PDF', onclick: exportPdf,
  }, 'PDF');
  const drawingToolbar = el('div', { class: 'toolbar' }, sheetSelect, editBtn, addBtn, pdfBtn, fileInput);

  const stage = el('div', { class: 'stage' });
  const uploadBtn = el('button', { type: 'button', class: 'btn btn-primary', onclick: () => fileInput.click() }, 'Upload drawing');
  const empty = el('div', { class: 'stage-empty' },
    el('p', { class: 'empty-title' }, 'Add a drawing to start dropping pins'),
    el('p', {}, 'PDF (every page becomes a sheet) or an image (JPG / PNG).'),
    uploadBtn);
  const fitBtn = el('button', { type: 'button', class: 'btn fab', onclick: () => view.fit() }, 'Fit');
  const hint = el('div', { class: 'hint', hidden: true }, readOnly() ? 'View only · pinch to zoom, tap a pin to see it' : 'Press and hold the drawing to drop a pin · pinch to zoom');
  const filterCount = el('span', {});
  const filterNote = el('div', { class: 'filter-note', hidden: true }, filterCount,
    el('button', { type: 'button', class: 'link-btn', onclick: clearFilters }, 'Clear filters'));
  // Shown while placing an existing item on a drawing ("tap where it goes").
  const placeText = el('span', {});
  const placeHint = el('div', { class: 'place-hint', hidden: true }, placeText,
    el('button', { type: 'button', class: 'btn btn-small', onclick: () => stopPlacing() }, 'Cancel'));
  const drawingPane = el('div', { class: 'stage-wrap' }, stage, empty, fitBtn, hint, filterNote, placeHint);

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
    onTradesChanged: tradesChanged,
  });
  list.onFiltersChanged = refreshFilterBar;

  // ---------- Photos tab ----------
  const photos = createPhotosView({ ctx: () => ({ project, items, filter }), onOpenItem: openExisting });

  // ---------- People tab ----------
  const peopleTab = createPeopleTab();

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

  app.replaceChildren(...[ // (filter: a null child would print "null")
    el('header', { class: 'topbar' },
      brandLink({ back: true }),
      el('h1', {}, project.name),
      el('div', { class: 'tabs', role: 'tablist' }, tabBtns.drawing, tabBtns.list, tabBtns.photos, tabBtns.people),
      headerActions()),
    data.isReadOnlyRole(project.myRole)
      ? el('div', { class: 'view-only-note' }, project.myRole === 'trade'
        ? 'View only: you see the items for your trade(s). Changes can\'t be saved.'
        : 'View only: you can look, but changes can\'t be saved.')
      : null,
    drawingToolbar, list.toolbar, photos.toolbar, filterBar, drawingPane, list.body, photos.body, peopleTab.node].filter(Boolean));

  const view = new DrawingView(stage, {
    onLongPress: (x, y) => (placing ? placeAt(x, y) : newItemAt(x, y)),
    onEmptyTap: (x, y) => (placing ? placeAt(x, y) : toast('Press and hold to drop a pin')),
    onPinTap: openExisting,
    onGroupTap: openGroup,
  });
  let placing = null; // the item being placed / moved, if any

  // ---------- Tabs ----------

  function setTab(next) {
    if (next !== 'drawing' && placing) stopPlacing();
    tab = next;
    for (const [key, btn] of Object.entries(tabBtns)) {
      btn.classList.toggle('active', key === tab);
      btn.setAttribute('aria-selected', String(key === tab));
    }
    drawingToolbar.hidden = drawingPane.hidden = tab !== 'drawing';
    list.toolbar.hidden = list.body.hidden = tab !== 'list';
    photos.toolbar.hidden = photos.body.hidden = tab !== 'photos';
    peopleTab.node.hidden = tab !== 'people';
    filterBar.hidden = tab === 'people';
    // Keep the tab in the address so a reload stays put (replaceState doesn't trigger a re-route).
    history.replaceState(null, '', `#/p/${projectId}${tab === 'drawing' ? '' : `/${tab}`}`);
    if (tab === 'drawing' && !drawingLoaded && drawings.length) showDrawing(lastSheet(projectId));
    if (tab === 'list') list.render();
    if (tab === 'photos') photos.render();
    if (tab === 'people') peopleTab.render(project);
    refreshFilterBar();
  }

  // ---------- Drawing tab ----------

  const itemsOnSheet = () => items.filter((i) => current && i.drawingId === current.id);

  function refreshSheets() {
    sheetSelect.replaceChildren(...drawings.map((d) => el('option', { value: d.id }, d.name)));
    const has = drawings.length > 0;
    empty.hidden = has;
    sheetSelect.hidden = editBtn.hidden = pdfBtn.hidden = fitBtn.hidden = !has;
    if (readOnly()) {
      editBtn.hidden = addBtn.hidden = uploadBtn.hidden = true;
      empty.querySelector('.empty-title').textContent = 'No drawings in this project yet';
    }
    if (current) sheetSelect.value = current.id;
  }

  function refreshPins() {
    const onSheet = itemsOnSheet();
    const shown = onSheet.filter((i) => matches(i, filter));
    view.setItems(shown);
    hint.hidden = !current || onSheet.length > 0 || !!placing;
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
      const blob = await data.getFileBlob(current.fileId);
      sheetWaiting = !blob;
      if (!blob) {
        view.showWaiting(current); // still downloading from the cloud; shown when it lands
        return;
      }
      await view.show(current, blob);
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

  // Edit menu for the sheet on screen: rename or delete it.
  async function editSheet() {
    if (!current) return;
    if (readOnly()) { toast(VIEW_ONLY_MSG, 3500); return; }
    const action = await choose({
      title: current.name,
      choices: [
        { label: 'Rename sheet', value: 'rename' },
        { label: 'Delete sheet…', value: 'delete', kind: 'danger' },
      ],
    });
    if (action === 'rename') renameSheet();
    if (action === 'delete') deleteSheet();
  }

  async function deleteSheet() {
    const sheet = current;
    const pinned = items.filter((i) => i.drawingId === sheet.id);
    const n = pinned.length;
    const plural = `${n} item${n === 1 ? '' : 's'}`;
    let keepItems = false;
    if (n) {
      const answer = await choose({
        title: `Delete "${sheet.name}"?`,
        message: `This sheet has ${plural} pinned on it. What should happen to ${n === 1 ? 'it' : 'them'}?`,
        choices: [
          { label: `Keep the ${plural}`, value: 'keep', kind: 'primary', note: 'They stay in the List tab and exports, without a pin' },
          { label: `Delete the ${plural} too`, value: 'delete', kind: 'danger', note: 'Their photos are deleted as well' },
        ],
      });
      if (!answer) return;
      keepItems = answer === 'keep';
    } else {
      const ok = await choose({
        title: `Delete "${sheet.name}"?`,
        message: 'No items are pinned on this sheet.',
        choices: [{ label: 'Delete sheet', value: true, kind: 'danger' }],
      });
      if (!ok) return;
    }
    await data.deleteDrawing(sheet.id, { keepItems });
    drawings = await data.listDrawings(projectId);
    await reloadData();
    current = null;
    refreshSheets();
    if (drawings.length) {
      const next = drawings.find((d) => d.sortOrder > sheet.sortOrder) || drawings[drawings.length - 1];
      await showDrawing(next.id);
    } else {
      view.clearSheet();
      refreshPins();
    }
    refreshFilterBar();
    if (tab === 'list') list.render();
    toast(n ? `Sheet deleted · ${plural} ${keepItems ? 'kept as list-only' : 'deleted'}` : 'Sheet deleted');
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
    if (result && result.place) {
      startPlacing(result.saved);
      return;
    }
    if (result && result.saved && !matches(result.saved, filter)) {
      toast(`Item ${data.itemName(result.saved)} saved, but it's hidden by your filters`, 3500);
    }
  }

  // Opens the item form; if it fails, say so on screen instead of silently doing nothing.
  function showForm(opts) {
    openItemForm(opts).catch((err) => {
      console.error(err);
      view.clearPendingPin();
      toast(`Could not open the item form: ${err.message}`, 5000);
    });
  }

  function newItemAt(x, y) {
    if (readOnly()) { toast(VIEW_ONLY_MSG, 3500); return; }
    view.setPendingPin(x, y);
    showForm({
      project,
      drawing: current,
      item: { projectId, drawingId: current.id, x, y, status: 'Open', trades: [] },
      onClose: afterForm,
      onTradesChanged: tradesChanged,
      canPlace: drawings.length > 0,
    });
  }

  // ---------- Placing an existing item on a drawing ----------
  // From the item form's "Place on a drawing" / "Move pin": go to the Drawing tab and
  // put the item wherever the next tap lands (any sheet — switch with the sheet menu).

  async function startPlacing(item) {
    if (!drawings.length) {
      toast('Add a drawing first (Drawing tab → Upload drawing)');
      return;
    }
    placing = item;
    const moving = !!item.drawingId;
    drawingLoaded = true; // stop setTab from loading the last-viewed sheet instead
    setTab('drawing');
    const sheet = (moving && drawings.find((d) => d.id === item.drawingId)) || current || drawings[0];
    if (!current || current.id !== sheet.id) await showDrawing(sheet.id);
    placeText.textContent = `Tap the drawing where item ${data.itemName(item)} ${moving ? 'should move to' : 'goes'}.`
      + (drawings.length > 1 ? ` To use a different sheet, switch sheets with the menu above first.` : '');
    placeHint.hidden = false;
    hint.hidden = true;
    stage.classList.add('placing');
  }

  function stopPlacing() {
    placing = null;
    placeHint.hidden = true;
    stage.classList.remove('placing');
    refreshPins();
  }

  async function placeAt(x, y) {
    const item = placing;
    stopPlacing();
    try {
      const updated = await data.updateItem(item.id, { drawingId: current.id, x, y });
      await reloadData();
      refreshAll();
      if (matches(updated, filter)) {
        view.flashPin(updated.id);
        toast(`Item ${data.itemName(updated)} placed on ${current.name}`);
      } else {
        toast(`Item ${data.itemName(updated)} placed, but it's hidden by your filters`, 3500);
      }
    } catch (err) {
      console.error(err);
      toast(`Could not place the item: ${err.message}`);
    }
  }

  // Tap on a gray "+N" pin: pick one of its items, or zoom in so they spread apart.
  async function openGroup(ids) {
    const group = ids.map((id) => items.find((i) => i.id === id)).filter(Boolean).sort(data.compareItems);
    const choice = await choose({
      title: `${group.length} pins here`,
      choices: [
        ...group.map((i) => ({
          label: `${data.itemName(i)} · ${i.title}`,
          note: [i.status, data.tradesText(i)].filter(Boolean).join(' · '),
          value: i.id,
        })),
        { label: 'Zoom in here', value: '__zoom', note: 'Spread these pins apart' },
      ],
    });
    if (choice === '__zoom') view.zoomToSeparate(group);
    else if (choice) openExisting(choice);
  }

  // From the List tab's "+ Item": an item with no pin (it won't appear on any drawing).
  function newListItem() {
    if (readOnly()) { toast(VIEW_ONLY_MSG, 3500); return; }
    showForm({
      project,
      drawing: null,
      item: { projectId, drawingId: null, x: null, y: null, status: 'Open', trades: [] },
      onClose: afterForm,
      onTradesChanged: tradesChanged,
      canPlace: drawings.length > 0,
    });
  }

  function openExisting(id) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    const drawing = drawings.find((d) => d.id === item.drawingId) || null;
    showForm({ project, drawing, item, onClose: afterForm, onTradesChanged: tradesChanged, canPlace: drawings.length > 0, readOnly: readOnly() });
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

  // A trade was added / renamed / deleted from a form or the List tab's picker.
  async function tradesChanged() {
    await reloadData();
    refreshFilterBar();
    if (tab === 'list') list.render();
  }

  function refreshFilterBar() {
    filterBar.hidden = (tab === 'drawing' && drawings.length === 0) || tab === 'people';
    if (tab === 'people') return; // no status / trade filters on the People tab
    // Counts follow what's in view: this sheet on the Drawing tab; search/sheet choice on the List tab.
    const scope = { drawing: itemsOnSheet, list: list.scopeItems, photos: () => items }[tab]();
    const count = (test) => scope.filter(test).length;

    const trades = [...new Set([...project.trades, ...items.flatMap((i) => i.trades || [])])];
    if (filter.trade && filter.trade !== NO_TRADE && !trades.includes(filter.trade)) trades.push(filter.trade);
    tradeFilter.replaceChildren(
      el('option', { value: '' }, 'All trades'),
      ...trades.map((t) => el('option', { value: t }, `${t} (${count((i) => (i.trades || []).includes(t))})`)),
      el('option', { value: NO_TRADE }, `No trade set (${count((i) => !(i.trades || []).length)})`),
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
    if (readOnly()) { toast(VIEW_ONLY_MSG, 3500); return; }
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

  // ---------- Changes downloaded from the cloud ----------
  // Redraw with the new data — but not while a form or dialog is open (it would yank things away
  // mid-edit); in that case catch up when it closes.
  let remotePending = false;
  async function onRemoteChange(e) {
    if (!e.detail.projectIds.includes(projectId)) return;
    if (document.querySelector('.pl-layer, .markup, .pl-working') || placing) {
      remotePending = true;
      return;
    }
    remotePending = false;
    const stillHere = await data.getProject(projectId);
    if (!stillHere) { location.hash = '#/'; return; }
    // My access changed (e.g. made a Viewer, or an Editor again): redraw the whole screen.
    if (data.isReadOnlyRole(stillHere.myRole) !== startedReadOnly) {
      window.dispatchEvent(new Event('punchlist:rerender'));
      return;
    }
    drawings = await data.listDrawings(projectId);
    await reloadData();
    if (current && !drawings.some((d) => d.id === current.id)) current = null;
    refreshSheets();
    refreshAll();
    if (tab === 'drawing' && drawings.length && (!current || sheetWaiting)) await showDrawing((current || drawings[0]).id);
  }
  window.addEventListener('punchlist:remote-change', onRemoteChange);
  const catchUp = setInterval(() => { if (remotePending) onRemoteChange({ detail: { projectIds: [projectId] } }); }, 2000);

  // ---------- Start ----------
  refreshSheets();
  setTab(tab);
  return () => {
    window.removeEventListener('punchlist:remote-change', onRemoteChange);
    clearInterval(catchUp);
    view.destroy();
    photos.destroy();
  };
}
