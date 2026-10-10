// backup.js — project files: pack whole projects into one ".punchlist" file to share or
// keep as a backup, and import them again on any device.
//
// The file is a zip (renamed so phones and Macs don't try to unzip it) holding:
//   punchlist.json  — the project records (projects, sheets, items, photos' notes...)
//   blobs/...       — the original drawing files and photos, unchanged
// Inside punchlist.json every Blob is replaced by { $blob: 'blobs/<id>-<field>', type }.
// Ids are kept, so importing a project that's already on the device can be recognized.

import * as data from './db.js';
import { el, toast, busy, choose, APP_VERSION } from './ui.js';
import { loadVendorScript, downloadBlob } from './export.js';

const FORMAT = 'punchlist-project-file';
const FORMAT_VERSION = 1;
const EXT = '.punchlist';
const MANIFEST = 'punchlist.json';
const APP_URL = 'https://jdwilly2005.github.io/punch-list/';
const EMAIL_LIMIT = 20 * 1024 * 1024; // most email gives up around 20–25 MB
const LAST_BACKUP_KEY = 'punchlist:lastBackup';

const loadZip = () => loadVendorScript('jszip.min.js', 'JSZip');

// ---------- Making the file ----------

// One project, to send to someone (from the project's ⋯ menu).
export async function shareProject(project) {
  const file = await buildFile([project.id], `${safeName(project.name)} ${today()}${EXT}`);
  if (file) await deliver(file, { title: 'Project file ready' });
}

// Every project on this device, as one backup file.
export async function backUpEverything() {
  const projects = await data.listProjects();
  if (!projects.length) return toast('No projects to back up yet.');
  const file = await buildFile(projects.map((p) => p.id), `Scope Optimized backup ${today()}${EXT}`);
  if (file && await deliver(file, { title: 'Backup ready', backup: true })) {
    try { localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString()); } catch { /* private mode */ }
  }
}

// "Oct 4, 2026, 2:32 PM" for the Projects screen ('' if never).
export function lastBackupDate() {
  let iso = null;
  try { iso = localStorage.getItem(LAST_BACKUP_KEY); } catch { /* private mode */ }
  return iso ? when(iso) : '';
}

async function buildFile(projectIds, fileName) {
  const hide = busy('Packing up…');
  try {
    await loadZip();
    const zip = new window.JSZip();
    const projects = [];
    for (const id of projectIds) {
      const bundle = await data.readProjectBundle(id);
      if (!bundle) continue;
      const out = { project: pack(zip, bundle.project) };
      for (const key of ['files', 'drawings', 'items', 'photos']) out[key] = bundle[key].map((r) => pack(zip, r));
      projects.push(out);
    }
    zip.file(MANIFEST, JSON.stringify({
      format: FORMAT, formatVersion: FORMAT_VERSION, appVersion: APP_VERSION, exportedAt: new Date().toISOString(), projects,
    }));
    const blob = await zip.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
      (meta) => hide.update(`Packing up… ${Math.floor(meta.percent)}%`),
    );
    return new File([blob], fileName, { type: 'application/octet-stream' });
  } catch (err) {
    console.error(err);
    toast(`Couldn't make the file: ${err.message}`, 6000);
    return null;
  } finally {
    hide();
  }
}

// Copies a record, moving any Blob fields into the zip. Photos and PDFs are already
// compressed, so they're stored as-is (squeezing them again only wastes time).
function pack(zip, record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (value instanceof Blob) {
      const path = `blobs/${record.id}-${key}`;
      zip.file(path, value, { binary: true, compression: 'STORE' });
      out[key] = { $blob: path, type: value.type };
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Offers Share… (AirDrop, Messages, Mail, Drive…) where the device supports it, or a download.
// Resolves true if the file was shared or saved.
async function deliver(file, { title, backup = false }) {
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  const how = file.size > EMAIL_LIMIT
    ? 'That\'s too big for most email. AirDrop it, or save it to Google Drive / Dropbox / iCloud and share the link.'
    : 'Send it by AirDrop, text, email, or a Google Drive / Dropbox link.';
  const message = backup
    ? `${file.name} · ${formatSize(file.size)}. Keep it somewhere other than this device, like Files › iCloud Drive or Google Drive. `
      + 'To restore, open Scope Optimized and tap "Import project file".'
    : `${file.name} · ${formatSize(file.size)}. ${how} The other person opens Scope Optimized and taps "Import project file".`;
  const choice = await choose({
    title,
    message,
    choices: [
      canShare ? { label: 'Share…', value: 'share', kind: 'primary', note: 'AirDrop, Messages, Mail, Files, Drive…' } : null,
      { label: canShare ? 'Download instead' : 'Download', value: 'save', kind: canShare ? undefined : 'primary' },
    ].filter(Boolean),
  });
  if (choice === 'share') {
    try {
      await navigator.share({
        files: [file],
        title: file.name,
        text: backup ? undefined : `Scope Optimized project file. Open ${APP_URL} and tap "Import project file".`,
      });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false; // closed the share sheet
      downloadBlob(file, file.name);
      toast('Sharing didn\'t work here, so the file was downloaded instead.', 5000);
      return true;
    }
  }
  if (choice === 'save') {
    downloadBlob(file, file.name);
    return true;
  }
  return false;
}

// ---------- Importing ----------

// Asks for a file, then imports it. Resolves with the imported projects ([] if none).
export function pickAndImport() {
  return new Promise((resolve) => {
    // No `accept` filter: iPhones grey out file types they don't recognize, like .punchlist.
    const input = el('input', { type: 'file', hidden: true });
    input.addEventListener('change', () => {
      const file = input.files[0];
      input.remove();
      resolve(file ? importFile(file) : []);
    });
    document.body.append(input);
    input.click();
  });
}

async function importFile(file) {
  let manifest;
  let zip;
  const hide = busy('Opening file…');
  try {
    await loadZip();
    zip = await window.JSZip.loadAsync(file);
    const entry = zip.file(MANIFEST);
    if (!entry) throw new Error('not ours');
    manifest = JSON.parse(await entry.async('string'));
    if (manifest.format !== FORMAT || !Array.isArray(manifest.projects)) throw new Error('not ours');
  } catch (err) {
    console.error(err);
    hide();
    toast(`"${file.name}" isn't a Scope Optimized project file.`, 6000);
    return [];
  }
  hide();
  if (manifest.formatVersion > FORMAT_VERSION) {
    toast('This file was made by a newer version of Scope Optimized. Update the app (close and reopen it), then try again.', 8000);
    return [];
  }
  if (!manifest.projects.length) {
    toast('That file has no projects in it.');
    return [];
  }

  // Which projects are already on this device?
  const plan = [];
  for (const p of manifest.projects) {
    const mine = await data.getProject(p.project.id);
    plan.push({ p, mine, action: mine ? null : 'new' });
  }
  const clashes = plan.filter((x) => x.mine);
  if (clashes.length === 1) {
    const action = await askOne(clashes[0]);
    if (!action) return [];
    clashes[0].action = action;
  } else if (clashes.length > 1) {
    const action = await askMany(clashes, plan.length);
    if (!action) return [];
    for (const x of clashes) x.action = action;
  }

  const todo = plan.filter((x) => x.action !== 'skip');
  const done = [];
  const working = busy('Importing…');
  try {
    for (const [i, x] of todo.entries()) {
      working.update(todo.length > 1 ? `Importing ${i + 1} of ${todo.length}: ${x.p.project.name}…` : `Importing ${x.p.project.name}…`);
      const bundle = { project: await unpack(zip, x.p.project) };
      for (const key of ['files', 'drawings', 'items', 'photos']) {
        bundle[key] = await Promise.all((x.p[key] || []).map((r) => unpack(zip, r)));
      }
      const asCopy = x.action === 'copy';
      done.push(await data.writeProjectBundle(bundle, {
        asCopy, name: asCopy ? await copyName(x.p.project.name) : undefined,
      }));
    }
  } catch (err) {
    console.error(err);
    const full = err.name === 'QuotaExceededError' || /quota/i.test(err.message);
    toast(full
      ? 'This device ran out of storage space while importing. Free up some space and try again.'
      : `Import stopped: ${err.message}`, 8000);
  } finally {
    working();
  }
  const skipped = plan.length - todo.length;
  if (done.length) {
    toast(`Imported ${done.length === 1 ? `"${done[0].name}"` : `${done.length} projects`}`
      + (skipped ? ` · skipped ${skipped} already here` : ''), 4000);
  } else if (skipped === plan.length) {
    toast('Nothing imported. Those projects are already on this device.', 4000);
  }
  return done;
}

// Puts the zip's photos / drawing files back into a record.
async function unpack(zip, record) {
  const out = { ...record };
  for (const [key, value] of Object.entries(record)) {
    if (value && typeof value === 'object' && typeof value.$blob === 'string') {
      const entry = zip.file(value.$blob);
      out[key] = entry ? new Blob([await entry.async('blob')], { type: value.type || '' }) : null;
    }
  }
  return out;
}

async function describe(x) {
  const [summary, changed] = await Promise.all([data.projectSummary(x.mine.id), data.projectLastChanged(x.mine.id)]);
  const fileItems = (x.p.items || []).length;
  const fileChanged = [x.p.project, ...(x.p.items || []), ...(x.p.drawings || []), ...(x.p.photos || [])]
    .reduce((last, r) => (r.updatedAt > last ? r.updatedAt : last), '');
  return `On this device: ${plural(summary.items, 'item')}, last changed ${when(changed)}.\n`
    + `In the file: ${plural(fileItems, 'item')}, last changed ${when(fileChanged)}.`;
}

async function askOne(x) {
  return choose({
    title: `"${x.mine.name}" is already on this device`,
    message: await describe(x),
    choices: [
      { label: 'Replace mine with the file\'s version', value: 'replace', kind: 'danger', note: 'Changes made only on this device are lost' },
      { label: 'Keep both', value: 'copy', kind: 'primary', note: `Imports it as "${x.p.project.name} (copy)"` },
    ],
  });
}

async function askMany(clashes, total) {
  const names = clashes.map((x) => x.mine.name);
  const list = names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', ');
  return choose({
    title: clashes.length === total
      ? `All ${total} projects in this file are already on this device`
      : `${clashes.length} of the ${total} projects in this file are already on this device`,
    message: `${list}. What should happen to those? Projects that aren't here yet are imported either way.`,
    choices: [
      { label: 'Replace mine with the file\'s versions', value: 'replace', kind: 'danger', note: 'Changes made only on this device are lost' },
      { label: 'Keep both', value: 'copy', note: 'Imports them as "(copy)"' },
      { label: 'Skip them', value: 'skip', kind: 'primary', note: 'Keep this device\'s versions' },
    ],
  });
}

// "Riverside (copy)", or "Riverside (copy 2)" if that's taken.
async function copyName(name) {
  const taken = new Set((await data.listProjects()).map((p) => p.name));
  let n = 1;
  let candidate = `${name} (copy)`;
  while (taken.has(candidate)) candidate = `${name} (copy ${++n})`;
  return candidate;
}

// ---------- Small helpers ----------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// For file names: "2026-10-04 at 2.32 PM" (no ":" — it isn't allowed in file names).
const today = () => {
  const d = new Date();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':', '.');
  return `${d.toLocaleDateString('en-CA')} at ${time}`;
};
const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Project';
const when = (iso) => (iso
  ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  : 'unknown');

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
