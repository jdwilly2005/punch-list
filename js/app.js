// app.js — starts the app, draws the Projects screen, and picks the screen to show.
//
// Screens are picked from the address bar "hash":
//   #/              -> list of projects
//   #/p/<id>        -> a project, Drawing tab
//   #/p/<id>/list   -> a project, List tab
//   #/p/<id>/photos -> a project, Photos tab

import * as data from './db.js';
import { el, toast, brandLink, APP_VERSION } from './ui.js';
import { renderProject } from './project-screen.js';

const app = document.getElementById('app');
let cleanup = null;
let renderToken = 0;

function route() {
  if (cleanup) cleanup();
  cleanup = null;
  const token = ++renderToken;
  const isStale = () => token !== renderToken;
  const m = location.hash.match(/^#\/p\/([\w-]+)(?:\/(list|photos))?/);
  const screen = m
    ? renderProject(app, m[1], m[2] || 'drawing', isStale).then((done) => {
      if (isStale()) { if (done) done(); } else cleanup = done;
    })
    : renderHome(token);
  screen.catch((err) => {
    console.error(err);
    toast(`Something went wrong: ${err.message}`);
  });
}

// ---------- Projects screen ----------

async function renderHome(token) {
  const projects = await data.listProjects();
  const summaries = await Promise.all(projects.map((p) => data.projectSummary(p.id)));
  if (token !== renderToken) return;

  const nameInput = el('input', {
    type: 'text', placeholder: 'New project name', maxlength: '80', autocomplete: 'off', 'aria-label': 'New project name',
  });
  const form = el('form', { class: 'new-project' },
    nameInput, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Create'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return nameInput.focus();
    const project = await data.createProject(name);
    location.hash = `#/p/${project.id}`;
  });

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const list = projects.length
    ? el('div', { class: 'project-list' }, projects.map((p, i) => el('a', { class: 'card', href: `#/p/${p.id}` },
      el('div', { class: 'card-title' }, p.name),
      el('div', { class: 'card-meta' },
        `${plural(summaries[i].sheets, 'sheet')} · ${plural(summaries[i].items, 'item')} · ${summaries[i].notClosed} not closed`))))
    : el('p', { class: 'empty' }, 'No projects yet. Create one above to get started.');

  app.replaceChildren(
    el('header', { class: 'topbar' }, brandLink({ showName: true })),
    el('main', { class: 'scroll' }, el('h2', { class: 'section-title' }, 'Projects'), form, list,
      el('p', { class: 'app-version' }, `Version ${APP_VERSION}`)));
}

// ---------- Start up ----------

// Show unexpected errors on screen, so a problem on a phone isn't silent.
window.addEventListener('error', (e) => toast(`Error: ${e.message}`, 6000));
window.addEventListener('unhandledrejection', (e) => {
  toast(`Error: ${(e.reason && e.reason.message) || e.reason}`, 6000);
});

window.addEventListener('hashchange', route);
route();

// Ask the browser not to clear our data when the phone is low on space.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// Offline support (only works over https:// or on localhost).
if ('serviceWorker' in navigator) {
  const hadVersion = !!navigator.serviceWorker.controller; // false on the very first visit
  const registering = navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
  registering.catch((err) => console.warn('Offline mode unavailable:', err));
  // Check for a new version each time the app is opened or brought back to the front
  // (a home-screen app usually resumes instead of starting fresh, which skips the browser's own check).
  const checkForUpdate = () => registering.then((reg) => reg.update()).catch(() => {});
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
  // A new version was just swapped in: reload so every file comes from it. Waits until
  // no form or dialog is open, so nothing you're typing is lost.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadVersion) return;
    toast('Updating the app…');
    const tryReload = () => {
      if (document.querySelector('.pl-layer, .markup, .pl-working')) setTimeout(tryReload, 1500);
      else location.reload();
    };
    setTimeout(tryReload, 800);
  });
}
