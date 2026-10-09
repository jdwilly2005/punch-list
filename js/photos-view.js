// photos-view.js — every item's photos in one place, ready to download or share.
//
// Built for getting photos into Procore: download them as files named by item
// ("Item 012 - Missing cover plate - 1.jpg"), then drag them from your Downloads
// folder into the Procore punch item. Dragging straight from this web page into
// Procore's page usually doesn't work (browsers pass a link, not the file).

import * as data from './db.js';
import { itemRef, itemName, compareItems, tradesText } from './db.js';
import { el, toast, statusKey } from './ui.js';
import { matches } from './filters.js';
import { downloadBlob, loadVendorScript } from './export.js';
import { openPhotoPreview } from './photo-preview.js';

const PREF_KEY = 'punchlist:photoVersion';

const clean = (s) => String(s || '').replace(/[\\/:*?"<>|#%\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
// Numbers are zero-padded so files sort in order ("Item 007"); custom tags are used as typed.
const itemLabel = (item) => `Item ${item.tag ? clean(item.tag) : String(item.number).padStart(3, '0')} - ${clean(item.title) || 'Untitled'}`;
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function loadPref() {
  try { return localStorage.getItem(PREF_KEY) === 'original' ? 'original' : 'marked'; } catch { return 'marked'; }
}
function savePref(v) {
  try { localStorage.setItem(PREF_KEY, v); } catch { /* not remembered */ }
}

// ctx() returns the project screen's current { project, items, filter }.
export function createPhotosView({ ctx, onOpenItem }) {
  let version = loadPref(); // 'marked' | 'original'
  let objectUrls = [];
  let renderToken = 0;
  let current = []; // [{ item, files: [File] }] for what's on screen

  const versionSelect = el('select', { class: 'photo-version', 'aria-label': 'Which version of the photos' },
    el('option', { value: 'marked' }, 'Marked-up photos'),
    el('option', { value: 'original' }, 'Original photos'));
  versionSelect.value = version;
  versionSelect.addEventListener('change', () => {
    version = versionSelect.value;
    savePref(version);
    render();
  });
  const zipBtn = el('button', { type: 'button', class: 'btn btn-primary', onclick: downloadZip }, 'Download all (.zip)');
  const toolbar = el('div', { class: 'toolbar' }, versionSelect, zipBtn);
  const summary = el('div', { class: 'list-summary' });
  const cards = el('div', { class: 'photo-items' });
  const body = el('div', { class: 'photos-body' }, summary, el('div', { class: 'photos-scroll' }, cards));

  const canShareFiles = (files) => {
    try { return !!(navigator.canShare && navigator.canShare({ files })); } catch { return false; }
  };

  function fileFor(item, photo, n) {
    const blob = version === 'original' ? photo.originalBlob : (photo.annotatedBlob || photo.originalBlob);
    const suffix = version === 'original' ? ' (original)' : '';
    return new File([blob], `${itemLabel(item)} - ${n}${suffix}.jpg`, { type: 'image/jpeg' });
  }

  async function render() {
    const token = ++renderToken;
    const { project, items, filter } = ctx();
    const photos = await data.listProjectPhotos(project.id);
    if (token !== renderToken) return;

    for (const u of objectUrls) URL.revokeObjectURL(u);
    objectUrls = [];

    const byItem = new Map();
    for (const p of photos) {
      if (!byItem.has(p.itemId)) byItem.set(p.itemId, []);
      byItem.get(p.itemId).push(p);
    }
    const shown = items.filter((i) => matches(i, filter)).sort(compareItems);
    const withPhotos = shown.filter((i) => byItem.has(i.id));
    const without = shown.filter((i) => !byItem.has(i.id));
    // (Synced photos that couldn't download — no signal — are left out and counted below.)
    const missing = photos.filter((p) => !p.originalBlob && !p.annotatedBlob).length;
    current = withPhotos.map((item) => ({
      item,
      files: byItem.get(item.id).filter((p) => p.originalBlob || p.annotatedBlob).map((p, n) => fileFor(item, p, n + 1)),
    })).filter((c) => c.files.length);
    const photoCount = current.reduce((sum, c) => sum + c.files.length, 0);

    zipBtn.disabled = photoCount === 0;
    summary.replaceChildren(
      el('span', {}, `${photoCount} photo${photoCount === 1 ? '' : 's'} on ${current.length} item${current.length === 1 ? '' : 's'}`),
      missing
        ? el('span', { class: 'summary-tip' }, `${missing} photo${missing === 1 ? '' : 's'} not downloaded yet (needs signal)`)
        : el('span', { class: 'summary-tip' }, 'Download, then drag the files from your Downloads folder into Procore'));

    cards.replaceChildren(...[
      ...current.map(({ item, files }) => makeCard(item, files)),
      without.length
        ? el('p', { class: 'meta no-photos' }, `No photos yet: ${without.map((i) => itemName(i)).join(', ')}`)
        : null,
      !shown.length ? el('p', { class: 'empty' }, items.length ? 'No items match your filters.' : 'No punch items yet.') : null,
    ].filter(Boolean)); // (replaceChildren would print a leftover null as the text "null")
  }

  // Every photo on screen, in order, so the preview can step through them.
  function previewFrom(file) {
    const all = [];
    for (const { item, files } of current) {
      files.forEach((f, n) => all.push({
        file: f,
        blob: f,
        title: `Item ${itemName(item)}${item.title ? ` · ${item.title}` : ''}`,
        subtitle: `Photo ${n + 1} of ${files.length}${version === 'original' ? ' (original)' : ''}${tradesText(item) ? ` · ${tradesText(item)}` : ''}`,
        fileName: f.name,
      }));
    }
    openPhotoPreview({ photos: all, index: Math.max(0, all.findIndex((p) => p.file === file)) });
  }

  function makeCard(item, files) {
    const thumbs = files.map((file) => {
      const url = URL.createObjectURL(file);
      objectUrls.push(url);
      // Tap = preview (the Download button below saves files). On a computer the photo can still be
      // dragged out to the desktop / a Finder folder as a file.
      const link = el('a', {
        class: 'photo-thumb', href: url, title: `View ${file.name}`, draggable: 'true',
      }, el('img', { src: url, alt: file.name, loading: 'lazy' }));
      link.addEventListener('click', (e) => {
        e.preventDefault();
        previewFrom(file);
      });
      // Chrome can drag this straight to the desktop / a Finder folder as a real file.
      link.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('DownloadURL', `image/jpeg:${file.name}:${url}`);
      });
      return link;
    });

    const buttons = [];
    if (canShareFiles(files)) {
      buttons.push(el('button', {
        type: 'button', class: 'btn btn-small',
        onclick: () => navigator.share({ files, title: itemLabel(item) }).catch(() => {}),
      }, 'Share'));
    }
    buttons.push(el('button', {
      type: 'button', class: 'btn btn-small', onclick: () => downloadFiles(files),
    }, files.length > 1 ? `Download ${files.length}` : 'Download'));

    return el('section', { class: 'photo-item' },
      el('div', { class: 'photo-item-head' },
        el('button', {
          type: 'button', class: 'num-badge', dataset: { status: statusKey(item.status) },
          title: 'Open item', onclick: () => onOpenItem(item.id),
        }, itemRef(item)),
        el('div', { class: 'photo-item-title' },
          el('strong', {}, item.title),
          el('small', {}, [item.status, tradesText(item), item.location].filter(Boolean).join(' · '))),
        el('div', { class: 'photo-item-actions' }, buttons)),
      el('div', { class: 'photo-strip' }, thumbs));
  }

  async function downloadFiles(files) {
    for (const f of files) {
      downloadBlob(f, f.name);
      await new Promise((r) => setTimeout(r, 350)); // browsers drop downloads fired all at once
    }
  }

  async function downloadZip() {
    if (!current.length) return;
    zipBtn.disabled = true;
    const original = zipBtn.textContent;
    zipBtn.textContent = 'Zipping…';
    try {
      await loadVendorScript('jszip.min.js', 'JSZip');
      const zip = new window.JSZip();
      for (const { item, files } of current) {
        const folder = zip.folder(itemLabel(item));
        for (const f of files) folder.file(f.name, f);
      }
      // Photos are already compressed JPEGs, so "STORE" (no extra compression) is fastest.
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      const kind = version === 'original' ? 'Punch Photos (originals)' : 'Punch Photos';
      downloadBlob(blob, `${clean(ctx().project.name) || 'Project'} - ${kind} ${today()}.zip`);
      toast(`Zipped ${current.length} item folder${current.length === 1 ? '' : 's'}`);
    } catch (err) {
      console.error(err);
      toast(`Could not make the zip: ${err.message}`);
    } finally {
      zipBtn.textContent = original;
      zipBtn.disabled = false;
    }
  }

  function destroy() {
    renderToken++;
    for (const u of objectUrls) URL.revokeObjectURL(u);
    objectUrls = [];
  }

  return { toolbar, body, render, destroy };
}
