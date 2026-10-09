// photo-preview.js — full-screen photo viewer: the photo (with its markup), a title, Download /
// Share, and ‹ › to step through the other photos. Used by the Photos tab and by view-only items.
//
// openPhotoPreview({ photos: [{ blob, title, subtitle, fileName }], index })

import { el, toast } from './ui.js';
import { downloadBlob } from './export.js';

export function openPhotoPreview({ photos, index = 0 }) {
  const list = photos.filter((p) => p && p.blob);
  if (!list.length) {
    toast('This photo hasn\'t downloaded yet. It needs signal; try again in a moment.');
    return;
  }
  let i = Math.min(Math.max(index, 0), list.length - 1);
  let url = null;

  const img = el('img', { class: 'preview-img', alt: '' });
  const title = el('strong', {});
  const subtitle = el('small', {});
  const counter = el('span', { class: 'preview-count' });
  const prev = el('button', { type: 'button', class: 'preview-nav prev', 'aria-label': 'Previous photo', onclick: () => go(-1) }, '‹');
  const next = el('button', { type: 'button', class: 'preview-nav next', 'aria-label': 'Next photo', onclick: () => go(1) }, '›');
  const shareBtn = el('button', { type: 'button', class: 'btn', onclick: share }, 'Share');
  const layer = el('div', { class: 'photo-preview', role: 'dialog', 'aria-label': 'Photo' },
    el('div', { class: 'preview-head' },
      el('div', { class: 'preview-title' }, title, subtitle),
      el('button', { type: 'button', class: 'btn btn-ghost preview-close', onclick: close }, 'Close')),
    el('div', { class: 'preview-stage' }, img, prev, next),
    el('div', { class: 'preview-foot' }, counter,
      el('span', { class: 'preview-actions' }, shareBtn,
        el('button', { type: 'button', class: 'btn btn-primary', onclick: download }, 'Download'))));
  document.body.append(layer);

  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') go(-1);
    if (e.key === 'ArrowRight') go(1);
  };
  document.addEventListener('keydown', onKey);
  // Swipe left / right on phones.
  let startX = null;
  img.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
  img.addEventListener('touchend', (e) => {
    if (startX == null) return;
    const dx = e.changedTouches[0].clientX - startX;
    startX = null;
    if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
  });

  show();

  function show() {
    const p = list[i];
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(p.blob);
    img.src = url;
    img.alt = p.title || 'Photo';
    title.textContent = p.title || 'Photo';
    subtitle.textContent = p.subtitle || '';
    counter.textContent = list.length > 1 ? `${i + 1} of ${list.length}` : '';
    prev.hidden = next.hidden = list.length < 2;
    shareBtn.hidden = !canShare(file());
  }

  function go(step) {
    if (list.length < 2) return;
    i = (i + step + list.length) % list.length;
    show();
  }

  function file() {
    const p = list[i];
    return new File([p.blob], p.fileName || 'photo.jpg', { type: p.blob.type || 'image/jpeg' });
  }

  function canShare(f) {
    try { return !!(navigator.canShare && navigator.canShare({ files: [f] })); } catch { return false; }
  }

  function download() {
    const f = file();
    downloadBlob(f, f.name);
  }

  function share() {
    navigator.share({ files: [file()] }).catch(() => {});
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    if (url) URL.revokeObjectURL(url);
    layer.remove();
  }
}
