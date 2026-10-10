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
// brand/logo.png (white + light blue, for the navy top bar, where it's the "home"
// button) and brand/logo-color.png (full color, for white PDF pages), and change BRAND.name.
// Both are made from the original logo artwork; keep them see-through (PNG).
// App-icon files for the home screen are separate: icons/ and manifest.json.
// Shown on the Projects screen so you can tell which version a device is running.
// Must match VERSION in sw.js — bump both on every publish.
export const APP_VERSION = 'v36';

export const BRAND = {
  name: 'Scope Optimized',
  logo: new URL('../brand/logo.png', import.meta.url).href,
  logoOnLight: new URL('../brand/logo-color.png', import.meta.url).href,
};

// ---------- Light / dark appearance ----------
// 'auto' follows the phone's setting; 'light'/'dark' force it on this device.
// The colors themselves are in css/app.css; index.html applies the saved choice before
// the page draws, so there's no white flash at night.
const THEME_KEY = 'punchlist:theme';
const HEADER_COLORS = { light: '#1a315d', dark: '#132544' }; // = --header in css/app.css

export function getTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; }
}

export function setTheme(theme) {
  try {
    if (theme === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch { /* private mode: still applies until the page reloads */ }
  applyTheme();
}

// Sets html[data-theme] and the browser's top-bar color to match.
export function applyTheme() {
  const theme = getTheme();
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', HEADER_COLORS[dark ? 'dark' : 'light']);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

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
// Gray for grouped pins ("+N" on screen, combined labels on PDFs). Same as --pin-group in app.css.
export const GROUP_PIN_COLOR = '#59636e';

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

// Full-screen "working…" overlay. Returns a function that hides it;
// hide.update('new message') changes the text while it's showing.
export function busy(message) {
  const text = el('span', {}, message);
  const overlay = el('div', { class: 'pl-working' },
    el('div', { class: 'pl-working-box' }, el('div', { class: 'spinner' }), text));
  document.body.append(overlay);
  const hide = () => overlay.remove();
  hide.update = (m) => { text.textContent = m; };
  return hide;
}

// A small pop-up with a few choices; resolves with the chosen value, or null if cancelled.
//   choices: [{ label, value, kind: 'primary' | 'danger' | undefined, note }]
// Used for "are you sure?" questions and short menus (e.g. a project's ⋯ menu).
export function choose({ title, message = '', choices }) {
  return new Promise((resolve) => {
    const layer = el('div', { class: 'pl-layer' },
      el('div', { class: 'pl-sheet pl-choose', role: 'dialog', 'aria-label': title },
        el('div', { class: 'pl-sheet-body' },
          el('h2', { class: 'choose-title' }, title),
          message ? el('p', { class: 'choose-message' }, message) : null,
          ...choices.map((c) => el('button', {
            type: 'button',
            class: `btn choose-btn${c.kind ? ` btn-${c.kind}` : ''}`,
            onclick: () => done(c.value),
          }, el('span', {}, c.label), c.note ? el('small', {}, c.note) : null)),
          el('button', { type: 'button', class: 'btn btn-ghost choose-btn', onclick: () => done(null) }, 'Cancel'))));
    layer.addEventListener('click', (e) => { if (e.target === layer) done(null); }); // tap outside = cancel
    document.body.append(layer);
    function done(value) {
      layer.remove();
      resolve(value);
    }
  });
}

// A list of options where tapping one only SELECTS it (a separate button then acts on it),
// so a stray tap never starts an export.
//   options: [{ value, label, note, disabled }]
// Returns { node, value } — `value` is the selected option's value (or null).
export function optionCards({ options, value = null, onSelect = () => {} }) {
  let selected = options.some((o) => o.value === value && !o.disabled) ? value : null;
  const node = el('div', { class: 'option-cards', role: 'radiogroup' });
  const render = () => node.replaceChildren(...options.map((o) => el('button', {
    type: 'button',
    class: 'option-card',
    role: 'radio',
    'aria-checked': String(o.value === selected),
    disabled: !!o.disabled,
    onclick: () => { selected = o.value; render(); onSelect(selected); },
  }, el('span', { class: 'option-dot', 'aria-hidden': 'true' }),
  el('span', { class: 'option-text' }, el('strong', {}, o.label), o.note ? el('small', {}, o.note) : null))));
  render();
  return { node, get value() { return selected; } };
}
