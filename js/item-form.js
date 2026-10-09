// item-form.js — the pop-up form for creating or editing a punch item.

import * as data from './db.js';
import { el, toast, statusKey, choose } from './ui.js';
import { preparePhoto, openMarkup } from './photo-markup.js';
import { createTradeChips } from './trade-picker.js';
import { openPhotoPreview } from './photo-preview.js';

// Gray "photo not downloaded yet" tile (synced photo opened with no signal).
const OFFLINE_THUMB = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#dde1e6"/><text x="50" y="47" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#5f6b7a">Not</text><text x="50" y="61" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#5f6b7a">downloaded</text></svg>')}`;

// item: an existing punch item, or for a new one { projectId, drawingId, x, y }
// (drawingId/x/y null = a list-only item with no pin). drawing: its sheet, or null.
// onClose(result) is called with { saved } / { deleted } / null (cancelled).
// onTradesChanged(): the project's trade list was changed from inside the form.
// canPlace: the project has drawings, so offer "Place on a drawing" / "Move pin"
//   (saves, then onClose({ saved, place: true }) — the project screen does the placing).
// readOnly: a Viewer / Trade member's view — everything shown, nothing editable, photos open in the preview.
export async function openItemForm({ project, drawing, item, onClose, onTradesChanged = () => {}, canPlace = false, readOnly = false }) {
  const isNew = !item.id;
  const photos = isNew ? [] : (await data.listPhotos(item.id)).map((p) => ({ ...p, isNew: false }));
  const objectUrls = [];

  // ----- Fields -----
  const titleInput = el('input', {
    type: 'text', value: item.title || '', maxlength: '120', autocomplete: 'off',
    placeholder: 'e.g. Missing cover plate',
  });

  // Blank = automatic number. A number (e.g. 12) renumbers the item; anything else
  // (e.g. CB-12) is a custom tag and frees up its number. See resolveNumber in db.js.
  const autoNumber = item.tag || item.number == null ? await data.nextItemNumber(project.id) : item.number;
  const tagInput = el('input', {
    type: 'text', value: item.tag || '', maxlength: '20', autocomplete: 'off', autocapitalize: 'characters',
    placeholder: `Automatic: #${autoNumber}`,
  });
  tagInput.addEventListener('input', () => tagInput.classList.remove('invalid'));

  const statusSeg = el('div', { class: 'status-seg', role: 'radiogroup', 'aria-label': 'Status' },
    data.STATUSES.map((s) => el('label', { class: 'seg', dataset: { status: statusKey(s) } },
      el('input', { type: 'radio', name: 'status', value: s, checked: (item.status || 'Open') === s }),
      el('span', {}, s))));

  // Tap one or more trades / subs. (Adding or managing trades here updates the project's list.)
  const tradeChips = createTradeChips({ project, selected: item.trades || [], onTradesChanged });

  const locationInput = el('input', {
    type: 'text', value: item.location || '', maxlength: '120', autocomplete: 'off',
    placeholder: 'e.g. Room 204, north wall',
  });
  const descInput = el('textarea', { rows: '4', placeholder: 'What needs to be fixed?' });
  descInput.value = item.description || '';

  // ----- Photos -----
  const photoGrid = el('div', { class: 'photo-grid' });
  const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    const added = [];
    for (const f of files) {
      try {
        const blob = await preparePhoto(f);
        const photo = { id: data.newId(), originalBlob: blob, annotatedBlob: null, markup: [], isNew: true };
        photos.push(photo);
        added.push(photo);
      } catch (err) {
        toast(err.message);
      }
    }
    renderPhotos();
    // One photo at a time? Jump straight into markup (tap Done to skip).
    if (added.length === 1) editPhoto(added[0]);
  });

  // A synced photo not downloaded yet (no signal) has no image: show a placeholder.
  function thumbUrl(p) {
    if (!p.annotatedBlob && !p.originalBlob) return OFFLINE_THUMB;
    if (!p.url) {
      p.url = URL.createObjectURL(p.annotatedBlob || p.originalBlob);
      objectUrls.push(p.url);
    }
    return p.url;
  }

  async function editPhoto(p) {
    if (readOnly) {
      const shown = photos.filter((x) => !x.removed);
      openPhotoPreview({
        photos: shown.map((x, n) => ({
          blob: x.annotatedBlob || x.originalBlob,
          title: `Item ${data.itemName(item)}${item.title ? ` · ${item.title}` : ''}`,
          subtitle: `Photo ${n + 1}${x.annotatedBlob ? ' (marked up)' : ''}`,
          fileName: `Item ${data.itemRef(item)} - ${n + 1}.jpg`,
        })),
        index: shown.indexOf(p),
      });
      return;
    }
    if (!p.originalBlob) {
      toast('This photo hasn\'t downloaded yet. It needs signal; try again in a moment.');
      return;
    }
    const result = await openMarkup(p.originalBlob, p.markup || []);
    if (!result) return;
    p.markup = result.markup;
    p.annotatedBlob = result.annotatedBlob;
    p.dirty = true;
    p.url = null;
    renderPhotos();
  }

  function renderPhotos() {
    photoGrid.replaceChildren(
      ...photos.filter((p) => !p.removed).map((p) => el('div', { class: 'thumb' },
        el('button', { type: 'button', class: 'thumb-open', 'aria-label': readOnly ? 'View photo' : 'Mark up photo', onclick: () => editPhoto(p) },
          el('img', { src: thumbUrl(p), alt: '' })),
        readOnly ? null : el('button', {
          type: 'button', class: 'thumb-remove', 'aria-label': 'Remove photo',
          onclick: () => {
            if (window.confirm('Remove this photo?')) { p.removed = true; renderPhotos(); }
          },
        }, '×'))),
      readOnly ? el('span', { hidden: true }) : el('label', { class: 'thumb add-photo' }, fileInput, el('span', {}, '＋'), el('small', {}, 'Add photo')));
  }
  renderPhotos();

  // ----- Layout -----
  const saveBtn = el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save');
  // Pin button: list-only items can be placed on a drawing; pinned items can be moved.
  // (Not shown for a brand-new pin that's being dropped right now.)
  const pinned = !!item.drawingId;
  const placeBtn = canPlace && (!isNew || !pinned)
    ? el('button', { type: 'button', class: 'btn place-btn', onclick: placeOnDrawing },
      pinned ? '📍 Move pin' : '📍 Place on a drawing')
    : null;
  // Pinned items can also drop their pin and become list-only.
  const unpinBtn = pinned && !isNew
    ? el('button', { type: 'button', class: 'btn place-btn', onclick: removeFromDrawing }, 'Remove from drawing')
    : null;
  const field = (label, control) => el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), control);

  const form = el('form', { class: 'pl-sheet', novalidate: true },
    el('div', { class: 'pl-sheet-head' },
      el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close(null) }, 'Cancel'),
      el('h2', {}, isNew ? 'New punch item' : `Item ${data.itemName(item)}`),
      saveBtn),
    el('div', { class: 'pl-sheet-body' },
      field('Title', titleInput),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Number / tag'), tagInput,
        el('small', { class: 'field-hint' }, 'Leave blank to number automatically, or type your own tag (e.g. CB-12).'),
        !isNew && data.isNumberPending(item)
          ? el('small', { class: 'field-hint unsynced-hint' },
            'Not synced yet: if someone else used this number while you were offline, it will get a new one when it syncs (you\'ll be told).')
          : null),
      el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Status'), statusSeg),
      el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Responsible trades / subs'), tradeChips.node),
      field('Location', locationInput),
      field('Description', descInput),
      el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Photos'), photoGrid),
      el('div', { class: 'sheet-row' },
        el('p', { class: 'meta' }, drawing ? `Sheet: ${drawing.name}` : 'Not on a drawing (list only)',
          isNew ? null : ` · Created ${new Date(item.createdAt).toLocaleDateString()}`),
        el('div', { class: 'pin-actions' }, placeBtn, unpinBtn)),
      isNew ? null : el('button', { type: 'button', class: 'btn btn-danger', onclick: remove }, 'Delete item')));

  // View only: show everything, change nothing.
  if (readOnly) {
    for (const c of form.querySelectorAll('input, textarea, select')) c.disabled = true;
    for (const b of tradeChips.node.querySelectorAll('button')) {
      if (b.classList.contains('trade-chip-tool')) b.hidden = true;
      else b.disabled = true;
    }
    for (const n of form.querySelectorAll('.thumb-remove, .add-photo, .pin-actions, .btn-danger')) n.hidden = true;
    saveBtn.hidden = true;
    form.querySelector('.pl-sheet-head .btn-ghost').textContent = 'Close';
    form.querySelector('.pl-sheet-head h2').textContent += ' · view only';
    form.querySelector('.pl-sheet-body').prepend(el('p', { class: 'view-only-note in-form' },
      'You have view-only access to this project, so you can\'t change this item.'));
  }

  const backdrop = el('div', { class: 'pl-layer' }, form);
  document.body.append(backdrop);
  if (isNew && !readOnly) setTimeout(() => titleInput.focus(), 50);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const saved = await save();
    if (saved) {
      toast(`Item ${data.itemName(saved)} saved`);
      close({ saved });
    }
  });

  // Saves first (the item needs to exist), then hands off to the Drawing tab to pick the spot.
  async function placeOnDrawing() {
    const saved = await save();
    if (saved) close({ saved, place: true });
  }

  // Keeps the item (List tab, exports, photos) but takes its pin off the drawing.
  async function removeFromDrawing() {
    const ok = await choose({
      title: `Remove item ${data.itemName(item)} from the drawing?`,
      message: 'It stays in the List tab, exports, and Photos — it just won\'t have a pin. '
        + 'You can put it back on any sheet later with "Place on a drawing".',
      choices: [{ label: 'Remove pin, keep item', value: true, kind: 'primary' }],
    });
    if (!ok) return;
    const saved = await save(); // keep any edits made in the form
    if (!saved) return;
    const updated = await data.updateItem(saved.id, { drawingId: null, x: null, y: null });
    toast(`Item ${data.itemName(updated)} is now list-only`);
    close({ saved: updated });
  }

  // Validates and saves the form. Returns the saved item, or null if it couldn't be saved.
  async function save() {
    const title = titleInput.value.trim();
    if (!title) {
      titleInput.classList.add('invalid');
      titleInput.focus();
      toast('Give the item a title.');
      return null;
    }
    saveBtn.disabled = true;
    for (const b of [placeBtn, unpinBtn]) if (b) b.disabled = true;
    try {
      const saved = await data.saveItem({
        ...item,
        title,
        tag: tagInput.value.trim(),
        status: form.querySelector('input[name=status]:checked').value,
        trades: tradeChips.selected,
        location: locationInput.value.trim(),
        description: descInput.value.trim(),
      }, photos);
      return saved;
    } catch (err) {
      console.error(err);
      if (/already used|start at 1/.test(err.message)) {
        tagInput.classList.add('invalid');
        tagInput.focus();
      }
      toast(`Could not save: ${err.message}`, 3500);
      saveBtn.disabled = false;
      for (const b of [placeBtn, unpinBtn]) if (b) b.disabled = false;
      return null;
    }
  }

  async function remove() {
    if (!window.confirm(`Delete item ${data.itemName(item)}? This can't be undone from the app.`)) return;
    await data.deleteItem(item.id);
    toast(`Item ${data.itemName(item)} deleted`);
    close({ deleted: true });
  }

  function close(result) {
    backdrop.remove();
    for (const u of objectUrls) URL.revokeObjectURL(u);
    onClose(result);
  }
}
