// ui.js — small shared helpers for building screens.

// Build a DOM element: el('button', { class: 'btn', onclick: fn }, 'Save')
// Children that are strings become text (never HTML), so user-typed text is always safe.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'value') node.value = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (typeof value === 'boolean') node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

// ---------- Brand ----------
// The app's name and logo live here (and in brand/). To rebrand, replace
// brand/logo.png (square, ~192px; PNG or JPG) and change BRAND.name. The logo is
// used in the top bar (as the "home" button) and on exported drawing PDFs.
// App-icon files for the home screen are separate: icons/ and manifest.json.
// Shown on the Projects screen so you can tell which version a device is running.
// Must match VERSION in sw.js — bump both on every publish.
export const APP_VERSION = 'v13';

export const BRAND = {
  name: 'Punch List',
  logo: new URL('../brand/logo.png', import.meta.url).href,
};

// Top-bar logo that goes back to the Projects screen.
// showName: also show the app name next to it (the Projects screen does).
// back: put a "‹" in front, so it reads as a back button inside a project.
export function brandLink({ showName = false, back = false } = {}) {
  return el('a', { class: 'brand', href: '#/', title: 'All projects', 'aria-label': `${BRAND.name} – all projects` },
    back ? el('span', { class: 'brand-back', 'aria-hidden': 'true' }, '‹') : null,
    el('img', { class: 'brand-logo', src: BRAND.logo, alt: '' }),
    showName ? el('span', { class: 'brand-name' }, BRAND.name) : null);
}

// Status colors for things drawn outside the page's CSS (Excel fills, PDF pins).
// Keep these the same as --st-* in css/app.css.
export const STATUS_COLORS = {
  'Open': '#d93025',
  'In Progress': '#e37400',
  'Ready for Review': '#1a73e8',
  'Closed': '#188038',
};

// Status name -> short key used for CSS colors (e.g. data-status="progress").
export function statusKey(status) {
  return {
    'Open': 'open',
    'In Progress': 'progress',
    'Ready for Review': 'review',
    'Closed': 'closed',
  }[status] || 'open';
}

let toastTimer;
export function toast(message, ms = 2400) {
  let node = document.querySelector('.pl-note');
  if (!node) {
    node = el('div', { class: 'pl-note', role: 'status' });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), ms);
}

// Full-screen "working…" overlay. Returns a function that hides it.
export function busy(message) {
  const overlay = el('div', { class: 'pl-working' },
    el('div', { class: 'pl-working-box' }, el('div', { class: 'spinner' }), message));
  document.body.append(overlay);
  return () => overlay.remove();
}
