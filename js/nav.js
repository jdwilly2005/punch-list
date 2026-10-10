// nav.js — controls that appear on every page:
//   • headerActions(): the ☰ menu and the account button, top right of every screen
//   • the ☰ menu: Account, Backup & sharing, This device (photos & drawings, storage)
//   • syncButton(): the small sync button, bottom left of every screen
// Screens redraw themselves after menu actions via the window events
//   'punchlist:rerender' (redraw the current screen) and 'punchlist:account-changed'.

import { el, toast, choose, APP_VERSION, getTheme, setTheme } from './ui.js';
import { openAccountDialog } from './account.js';
import { currentUser } from './cloud.js';
import { backUpEverything, pickAndImport, lastBackupDate } from './backup.js';
import { syncNow, onSyncStatus, syncStatus, fileMode, setFileMode, freeUpSpace, storageUsed } from './sync.js';
import * as data from './db.js';

const rerender = () => window.dispatchEvent(new Event('punchlist:rerender'));
const accountChanged = () => window.dispatchEvent(new Event('punchlist:account-changed'));

const ICONS = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  sync: '<path d="M20 12a8 8 0 0 1-13.7 5.6M4 12a8 8 0 0 1 13.7-5.6"/><path d="M18 3v4h-4M6 21v-4h4"/>',
};
function icon(name) {
  const span = el('span', { class: 'ui-icon', 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

// ---------- Top right: ☰ menu + account ----------

export function headerActions() {
  return el('div', { class: 'header-actions' }, menuButton(), accountButton());
}

function menuButton() {
  return el('button', { type: 'button', class: 'menu-btn', 'aria-label': 'Menu', onclick: openMenu }, icon('menu'));
}

// A person icon, or the first letter of the email once signed in.
function accountButton() {
  const btn = el('button', {
    type: 'button', class: 'account-btn', 'aria-label': 'Account – sign in',
    onclick: () => openAccountDialog({ onChange: accountChanged }),
  }, el('span', { class: 'account-icon', 'aria-hidden': 'true' }));
  currentUser().then((user) => {
    if (!user) return;
    btn.classList.add('signed-in');
    btn.setAttribute('aria-label', `Account – signed in as ${user.email}`);
    btn.firstChild.textContent = user.email[0].toUpperCase();
  }).catch(() => { /* offline before the account code was ever loaded: keep the sign-in icon */ });
  return btn;
}

// ---------- The ☰ menu ----------

export async function openMenu() {
  const body = el('div', { class: 'pl-sheet-body menu-body' });
  const layer = el('div', { class: 'pl-layer' },
    el('div', { class: 'pl-sheet', role: 'dialog', 'aria-label': 'Menu' },
      el('div', { class: 'pl-sheet-head' },
        el('span', { class: 'head-spacer' }),
        el('h2', {}, 'Menu'),
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => layer.remove() }, 'Done')),
      body));
  layer.addEventListener('click', (e) => { if (e.target === layer) layer.remove(); });
  document.body.append(layer);
  const close = () => layer.remove();

  const projects = await data.listProjects();
  body.replaceChildren(
    section('Account',
      el('button', {
        type: 'button', class: 'btn menu-wide',
        onclick: () => { close(); openAccountDialog({ onChange: accountChanged }); },
      }, 'Account & company settings'),
      el('p', { class: 'backup-note' }, 'Sign in, your name, your company and its people.')),
    backupSection(projects, close),
    deviceSection(),
    el('p', { class: 'app-version' }, `Punch List · Version ${APP_VERSION}`));
}

function section(title, ...children) {
  return el('section', { class: 'menu-section' }, el('h3', { class: 'section-title' }, title), ...children);
}

function backupSection(projects, close) {
  const last = lastBackupDate();
  return section('Backup & sharing',
    el('div', { class: 'backup-buttons' },
      el('button', {
        type: 'button', class: 'btn',
        onclick: async () => {
          close();
          const done = await pickAndImport();
          if (done.length === 1) location.hash = `#/p/${done[0].id}`;
          else if (done.length) rerender();
        },
      }, 'Import project file'),
      el('button', {
        type: 'button', class: 'btn', disabled: !projects.length,
        onclick: async () => { close(); await backUpEverything(); },
      }, 'Back up everything')),
    el('p', { class: 'backup-note' },
      'To send one project to someone, use its ⋯ menu › Share project file. ',
      projects.length ? (last ? `Last full backup from this device: ${last}.` : 'No full backup from this device yet.') : null));
}

// Keep all photos & drawings on this device, or only what you open; storage used; free up space.
function deviceSection() {
  const mode = el('select', { class: 'device-mode', 'aria-label': 'Photos and drawings on this device' },
    el('option', { value: 'all' }, 'Download everything (works without signal)'),
    el('option', { value: 'open' }, 'Only what I open (saves space)'));
  mode.value = fileMode();
  const used = el('span', {});
  const refreshUsed = () => storageUsed().then((u) => { used.textContent = u ? `Punch List is using about ${u} on this device. ` : ''; });
  refreshUsed();
  mode.addEventListener('change', () => {
    setFileMode(mode.value);
    toast(mode.value === 'all' ? 'Downloading photos and drawings in the background' : 'Photos and drawings will download when you open them');
  });
  const free = el('button', { type: 'button', class: 'btn' }, 'Free up space');
  free.addEventListener('click', async () => {
    const all = fileMode() === 'open';
    const ok = await choose({
      title: 'Free up space?',
      message: all
        ? 'Removes this device\'s copies of photos and drawings that are safely in the cloud. They download again when you open them (needs signal).'
        : 'Removes this device\'s copies of photos and drawings for ARCHIVED projects that are safely in the cloud. Active projects keep theirs so they work without signal.',
      choices: [{ label: 'Free up space', value: 'yes', kind: 'primary' }],
    });
    if (ok !== 'yes') return;
    const n = await freeUpSpace();
    toast(n ? `Cleared ${n} file${n === 1 ? '' : 's'} from this device` : 'Nothing to clear: everything here is still needed or not uploaded yet', 4000);
    setTimeout(refreshUsed, 1500);
  });
  const theme = el('select', { class: 'device-mode', 'aria-label': 'Appearance' },
    el('option', { value: 'auto' }, 'Auto (match this phone or computer)'),
    el('option', { value: 'light' }, 'Light'),
    el('option', { value: 'dark' }, 'Dark'));
  theme.value = getTheme();
  theme.addEventListener('change', () => setTheme(theme.value));
  return section('This device',
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Appearance'), theme),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Photos and drawings from the cloud'), mode),
    el('div', { class: 'backup-buttons' }, free),
    el('p', { class: 'backup-note' }, used, 'Phones and tablets usually keep everything (for no-signal areas); a computer can save space with "Only what I open". Your item lists always sync in full.'));
}

// ---------- Bottom left: sync button ----------

// Someone else used the same number/tag while this device was offline; the cloud gave ours a new one.
function renumberMessage(items) {
  const where = new Set(items.map((i) => i.projectName)).size === 1 && items[0].projectName ? ` in ${items[0].projectName}` : '';
  if (items.length === 1) {
    const { from, to } = items[0];
    return `Item ${from}${where} is now ${to}: someone else used ${from} while you were offline. Update any tape or notes.`;
  }
  const list = items.slice(0, 4).map((i) => `${i.from} → ${i.to}`).join(', ') + (items.length > 4 ? ', …' : '');
  return `${items.length} items${where} got new numbers because someone else used them while you were offline: ${list}. Update any tape or notes.`;
}

// Created once; stays on screen across pages. Spins while syncing; its dot shows the state.
export function syncButton() {
  const btn = el('button', { type: 'button', class: 'sync-fab', 'aria-label': 'Sync now', title: 'Sync now' },
    icon('sync'), el('span', { class: 'sync-fab-dot', 'aria-hidden': 'true' }));
  let wanted = false; // tapped: say how it went when the sync finishes
  onSyncStatus((st) => {
    btn.dataset.state = st.state === 'idle' && st.message ? 'syncing' : st.state;
    btn.title = {
      'signed-out': 'Not signed in: projects are saved on this device only',
      offline: 'Offline: changes will upload when you have signal',
      error: `Sync problem: ${st.message}`,
      syncing: 'Syncing…',
    }[st.state] || (st.pending ? `${st.pending} change(s) waiting to upload` : 'Everything synced');
    btn.setAttribute('aria-label', `Sync now. ${btn.title}`);
    if (wanted && st.state !== 'syncing') {
      wanted = false;
      toast({
        'signed-out': 'Sign in (person icon, top right) to sync to the cloud.',
        offline: 'No signal right now. Your changes are saved and will upload later.',
        error: `Sync problem: ${st.message}`,
      }[st.state] || (st.message || 'All synced'), 3500);
    }
  });
  window.addEventListener('punchlist:renumbered', (e) => toast(renumberMessage(e.detail.items), 9000));
  btn.addEventListener('click', () => {
    wanted = true;
    if (syncStatus().state === 'signed-out') {
      wanted = false;
      toast('Sign in (person icon, top right) to sync to the cloud.', 3500);
      return;
    }
    syncNow();
  });
  return btn;
}
