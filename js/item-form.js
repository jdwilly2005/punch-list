// item-form.js — the pop-up form for creating or editing a punch item.

import * as data from './db.js';
import { el, toast, statusKey } from './ui.js';
import { preparePhoto, openMarkup } from './photo-markup.js';
import { createTradeChips } from './trade-picker.js';

// item: an existing punch item, or for a new one { projectId, drawingId, x, y }
// (drawingId/x/y null = a list-only item with no pin). drawing: its sheet, or null.
// onClose(result) is called with { saved } / { deleted } / null (cancelled).
// onTradesChanged(): the project's trade list was changed from inside the form.
export async function openItemForm({ project, drawing, item, onClose, onTradesChanged = () => {} }) {
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

  function thumbUrl(p) {
    if (!p.url) {
      p.url = URL.createObjectURL(p.annotatedBlob || p.originalBlob);
      objectUrls.push(p.url);
    }
    return p.url;
  }

  async function editPhoto(p) {
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
        el('button', { type: 'button', class: 'thumb-open', 'aria-label': 'Mark up photo', onclick: () => editPhoto(p) },
          el('img', { src: thumbUrl(p), alt: '' })),
        el('button', {
          type: 'button', class: 'thumb-remove', 'aria-label': 'Remove photo',
          onclick: () => {
            if (window.confirm('Remove this photo?')) { p.removed = true; renderPhotos(); }
          },
        }, '×'))),
      el('label', { class: 'thumb add-photo' }, fileInput, el('span', {}, '＋'), el('small', {}, 'Add photo')));
  }
  renderPhotos();

  // ----- Layout -----
  const saveBtn = el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save');
  const field = (label, control) => el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), control);

  const form = el('form', { class: 'pl-sheet', novalidate: true },
    el('div', { class: 'pl-sheet-head' },
      el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close(null) }, 'Cancel'),
      el('h2', {}, isNew ? 'New punch item' : `Item ${data.itemName(item)}`),
      saveBtn),
    el('div', { class: 'pl-sheet-body' },
      field('Title', titleInput),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Number / tag'), tagInput,
        el('small', { class: 'field-hint' }, 'Leave blank to number automatically, or type your own tag (e.g. CB-12).')),
      el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Status'), statusSeg),
      el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Responsible trades / subs'), tradeChips.node),
      field('Location', locationInput),
      field('Description', descInput),
      el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Photos'), photoGrid),
      el('p', { class: 'meta' }, drawing ? `Sheet: ${drawing.name}` : 'Not on a drawing (list only)',
        isNew ? null : ` · Created ${new Date(item.createdAt).toLocaleDateString()}`),
      isNew ? null : el('button', { type: 'button', class: 'btn btn-danger', onclick: remove }, 'Delete item')));

  const backdrop = el('div', { class: 'pl-layer' }, form);
  document.body.append(backdrop);
  if (isNew) setTimeout(() => titleInput.focus(), 50);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = titleInput.value.trim();
    if (!title) {
      titleInput.classList.add('invalid');
      titleInput.focus();
      toast('Give the item a title.');
      return;
    }
    saveBtn.disabled = true;
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
      toast(`Item ${data.itemName(saved)} saved`);
      close({ saved });
    } catch (err) {
      console.error(err);
      if (/already used|start at 1/.test(err.message)) {
        tagInput.classList.add('invalid');
        tagInput.focus();
      }
      toast(`Could not save: ${err.message}`, 3500);
      saveBtn.disabled = false;
    }
  });

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
