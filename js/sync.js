// sync.js — keeps this device's projects and the cloud (Supabase) in step.
//
// The device stays the working copy: every screen reads and writes IndexedDB (db.js) exactly as
// before, so the app works the same with no signal. This file runs in the background:
//   1. UPLOAD: records marked `dirty` (changed here) are sent up — projects first, then their
//      files, sheets, items and photos. Drawing files and photos go to Storage first.
//   2. DOWNLOAD: anything that changed in the cloud since this device last looked (per project,
//      by the server's `synced_at`) is merged in, then missing files/photos are downloaded.
// Conflicts: the newer `updatedAt` (device time of the edit) wins, on both sides.
// Files mode (per device): 'all' downloads every drawing file and photo ahead of time (phones and
// tablets, for working without signal); 'open' downloads each one only when a screen needs it
// (computers, to save space) — see setBlobFetcher in db.js.
// Runs: when the app opens, a few seconds after an edit, when signal returns, and every minute.

import * as data from './db.js';
import * as cloud from './cloud.js';

const BUCKET = 'project-files';
const TABLES = ['files', 'drawings', 'items', 'photos'];       // a project's records, in upload order
const OVERLAP_MS = 10_000;  // re-read a little behind the cursor, so nothing committed late is missed
const PAGE = 500;

// ---------- Field mapping: device (camelCase) <-> cloud (snake_case) ----------

const iso = (v) => (v ? new Date(v).toISOString() : null);
const COMMON_UP = (r) => ({
  id: r.id, created_at: iso(r.createdAt) || iso(Date.now()), updated_at: iso(r.updatedAt) || iso(Date.now()), deleted_at: iso(r.deletedAt),
});
const COMMON_DOWN = (row) => ({
  id: row.id, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), deletedAt: iso(row.deleted_at),
});

const MAP = {
  projects: {
    up: (r) => ({ ...COMMON_UP(r), name: r.name || 'Untitled project', address: r.address || '', trades: r.trades || [], archived_at: iso(r.archivedAt) }),
    down: (row) => ({ ...COMMON_DOWN(row), name: row.name, address: row.address, trades: row.trades || [], archivedAt: iso(row.archived_at) }),
  },
  files: {
    up: (r) => ({ ...COMMON_UP(r), project_id: r.projectId, name: r.name || '', type: r.type || '', size: r.blob ? r.blob.size : (r.size ?? null), storage_path: r.storagePath || null }),
    down: (row) => ({ ...COMMON_DOWN(row), projectId: row.project_id, name: row.name, type: row.type, size: row.size, storagePath: row.storage_path }),
  },
  drawings: {
    up: (r) => ({ ...COMMON_UP(r), project_id: r.projectId, file_id: r.fileId, file_type: r.fileType || 'pdf', page_number: r.pageNumber || 1,
      width_px: r.widthPx ?? null, height_px: r.heightPx ?? null, name: r.name || '', sort_order: r.sortOrder || 0 }),
    down: (row) => ({ ...COMMON_DOWN(row), projectId: row.project_id, fileId: row.file_id, fileType: row.file_type, pageNumber: row.page_number,
      widthPx: row.width_px, heightPx: row.height_px, name: row.name, sortOrder: row.sort_order }),
  },
  items: {
    up: (r) => ({ ...COMMON_UP(r), project_id: r.projectId, drawing_id: r.drawingId || null, x: r.x ?? null, y: r.y ?? null,
      number: r.number ?? null, tag: r.tag || '', title: r.title || '', description: r.description || '', status: r.status || 'Open',
      trades: r.trades || [], location: r.location || '' }),
    down: (row) => ({ ...COMMON_DOWN(row), projectId: row.project_id, drawingId: row.drawing_id, x: row.x, y: row.y, number: row.number,
      tag: row.tag, title: row.title, description: row.description, status: row.status, trades: row.trades || [], location: row.location }),
  },
  photos: {
    up: (r) => ({ ...COMMON_UP(r), project_id: r.projectId, item_id: r.itemId, original_path: r.originalPath || null,
      annotated_path: r.annotatedPath || null, markup: r.markup || [] }),
    down: (row) => ({ ...COMMON_DOWN(row), projectId: row.project_id, itemId: row.item_id, originalPath: row.original_path,
      annotatedPath: row.annotated_path, markup: row.markup || [] }),
  },
};

// Big files that live in Storage instead of the table: [local blob field, local path field, name in path]
const BLOB_FIELDS = {
  files: [['blob', 'storagePath', 'file']],
  photos: [['originalBlob', 'originalPath', 'original'], ['annotatedBlob', 'annotatedPath', 'annotated']],
};
const GONE = { files: { blob: null }, photos: { originalBlob: null, annotatedBlob: null } };

// ---------- Files mode + freeing space ----------

const MODE_KEY = 'punchlist:fileMode';
export function fileMode() {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === 'all' || saved === 'open') return saved;
  } catch { /* not remembered */ }
  return window.matchMedia('(pointer: coarse)').matches ? 'all' : 'open'; // touch screen = in the field
}
export function setFileMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* not remembered */ }
  if (mode === 'all') syncNow();
}

// Removes this device's copies of drawing files and photos that are safely in the cloud (they
// download again when needed). In "download everything" mode only archived projects are cleared.
// Never touches anything that hasn't finished uploading. Returns the number of files cleared.
export async function freeUpSpace() {
  const db = data.syncDb;
  const mode = fileMode();
  const archived = new Set((await db.projects.toArray()).filter((p) => p.archivedAt).map((p) => p.id));
  const clearable = (r) => mode === 'open' || archived.has(r.projectId);
  let cleared = 0;
  await data.syncTransaction(['files', 'photos'], async (tx) => {
    await tx.table('files').toCollection().modify((f) => {
      if (f.blob && f.storagePath && !f.dirty && clearable(f)) { f.blob = null; cleared++; }
    });
    await tx.table('photos').toCollection().modify((p) => {
      if (!clearable(p) || p.dirty) return;
      if (p.originalBlob && p.originalPath) { p.originalBlob = null; cleared++; }
      if (p.annotatedBlob && p.annotatedPath) { p.annotatedBlob = null; cleared++; }
    });
  });
  return cleared;
}

// How much the app is storing on this device, e.g. "340 MB" (null if the browser won't say).
export async function storageUsed() {
  try {
    const { usage } = await navigator.storage.estimate();
    if (usage == null) return null;
    return usage < 1024 * 1024 ? `${Math.round(usage / 1024)} KB` : `${(usage / 1024 / 1024).toFixed(usage < 100 * 1024 * 1024 ? 1 : 0)} MB`;
  } catch { return null; }
}

// ---------- Safari-safe saving of files ----------
// Safari sometimes refuses to save a downloaded file, or to re-save a record that already holds
// one ("Error preparing Blob/File data to be stored in object store"). Copying the bytes into a
// brand-new Blob first fixes it; writes that hit the error are retried that way once.

const isBlobError = (err) => /blob|object store|preparing/i.test(err?.message || '');

async function freshBlob(blob, type) {
  return new Blob([await blob.arrayBuffer()], { type: type || blob.type || 'application/octet-stream' });
}

// Re-copies every file held by these records (a file that can't be read any more is dropped,
// and downloads again later if it's in the cloud).
async function freshenRecords(table, ids) {
  const fields = (BLOB_FIELDS[table] || []).map(([f]) => f);
  if (!fields.length) return;
  for (const id of ids) {
    const r = await data.syncDb.table(table).get(id);
    if (!r) continue;
    const patch = {};
    for (const f of fields) {
      if (!r[f]) continue;
      try { patch[f] = await freshBlob(r[f]); } catch { patch[f] = null; }
    }
    if (Object.keys(patch).length) await data.syncTransaction([table], (tx) => tx.table(table).update(id, patch));
  }
}

async function safeWrite(table, ids, op) {
  try {
    return await op();
  } catch (err) {
    if (!isBlobError(err) || !BLOB_FIELDS[table]) throw err;
    console.warn('Safari file-saving hiccup; retrying', table, err);
    await freshenRecords(table, ids);
    return op();
  }
}

// Downloads one file from the cloud and keeps it on the device. Used by screens (via db.js) in
// "only what I open" mode, and by the background download in "download everything" mode.
async function fetchBlob(table, record, field) {
  const pathField = BLOB_FIELDS[table].find(([f]) => f === field)[1];
  const path = record[pathField];
  if (!path) return null;
  const client = await cloud.getClient();
  const { data: blob, error } = await client.storage.from(BUCKET).download(path);
  if (error) throw new Error(error.message || 'Download failed');
  const type = table === 'files' ? (record.type || blob.type) : 'image/jpeg';
  const fresh = await freshBlob(blob, type);
  await safeWrite(table, [record.id], () => data.syncTransaction([table], (tx) => tx.table(table).update(record.id, {
    [field]: fresh, ...(field === 'annotatedBlob' ? { annotatedStale: 0 } : {}),
  })));
  return fresh;
}

// ---------- Status (shown on the Projects screen) ----------

let status = { state: 'idle', message: '', lastSyncedAt: null, pending: 0 };
const listeners = new Set();
export function onSyncStatus(fn) {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}
function setStatus(patch) {
  status = { ...status, ...patch };
  for (const fn of listeners) fn(status);
}
export function syncStatus() { return status; }

// Screens listen for this to redraw when downloads change their project.
function announce(projectIds) {
  if (projectIds.size) window.dispatchEvent(new CustomEvent('punchlist:remote-change', { detail: { projectIds: [...projectIds] } }));
}

// ---------- Scheduling ----------

let running = null;
let again = false;
let soonTimer = null;
let started = false;

// Call once at startup.
export function startSync() {
  if (started) return;
  started = true;
  data.setBlobFetcher(fetchBlob);
  data.onLocalChange(() => {
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => syncNow(), 3000);
    countPending();
  });
  window.addEventListener('online', () => syncNow());
  window.addEventListener('offline', () => setStatus({ state: 'offline' }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60_000);
  if (cloud.hasSavedSession()) {
    cloud.onAccountChange(() => syncNow()).catch(() => {});
    syncNow();
  } else {
    countPending().then(() => setStatus({ state: 'signed-out' }));
  }
}

// Runs a sync now (or right after the one in progress). Never throws; problems go to the status.
export function syncNow() {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await runOnce();
    } while (again);
  })().finally(() => { running = null; });
  return running;
}

async function countPending() {
  let pending = 0;
  for (const t of ['projects', ...TABLES]) pending += await data.syncDb.table(t).where('dirty').equals(1).count();
  setStatus({ pending });
  return pending;
}

async function runOnce() {
  if (!navigator.onLine) {
    await countPending();
    setStatus({ state: 'offline' });
    return;
  }
  let user;
  try {
    user = await cloud.currentUser();
  } catch {
    setStatus({ state: 'offline' });
    return;
  }
  if (!user) {
    await countPending();
    setStatus({ state: 'signed-out' });
    return;
  }
  setStatus({ state: 'syncing', message: '' });
  try {
    const client = await cloud.getClient();
    const ctx = { client, user, changed: new Set(), problems: [] };
    await upload(ctx);
    await download(ctx);
    announce(ctx.changed);
    const pending = await countPending();
    if (ctx.problems.length) {
      setStatus({ state: 'error', message: `Couldn't upload ${ctx.problems.map((n) => `"${n}"`).join(', ')}. It's still saved on this device.`, pending });
      return;
    }
    setStatus({ state: 'idle', message: '', lastSyncedAt: new Date().toISOString(), pending });
    await downloadFiles(); // can take a while; the lists are already up to date
  } catch (err) {
    console.error('Sync failed', err);
    const offline = /fetch|network|load failed/i.test(err.message || '');
    setStatus({ state: offline ? 'offline' : 'error', message: offline ? '' : (err.message || String(err)) });
  }
}

// ---------- Upload ----------

async function upload(ctx) {
  const { client, user } = ctx;
  const db = data.syncDb;

  // Projects first (their files, sheets and items need them in the cloud).
  const dirtyProjects = await db.projects.where('dirty').equals(1).toArray();
  const problems = ctx.problems;
  let account = null;
  for (const p of dirtyProjects) {
    if (p.syncUser && p.syncUser !== user.id) continue; // belongs to another account that used this device
    if (!p.cloud && p.deletedAt) { await markClean('projects', p); continue; } // never uploaded: nothing to delete
    const row = MAP.projects.up(p);
    let res;
    if (p.cloud) {
      res = await client.from('projects').update(row).eq('id', p.id).select('id');
    } else {
      if (!account) account = await cloud.myAccount();
      res = await client.from('projects').insert({ ...row, owner_id: user.id, company_id: account?.company?.id || null }).select('id');
      // Already in the cloud (e.g. uploaded from another device): update instead.
      if (res.error && res.error.code === '23505') res = await client.from('projects').update(row).eq('id', p.id).select('id');
    }
    if (res.error) {
      if (isNetwork(res.error)) throw new Error(res.error.message);
      if (!p.cloud) {
        // A brand-new project the cloud won't take: keep it waiting (dirty) and say so.
        console.warn('Project upload refused', p.id, res.error);
        setStatus({ state: 'error', message: `"${p.name}" couldn't upload: ${res.error.message}` });
        problems.push(p.name);
        continue;
      }
      await rejected('projects', p, res.error);
      continue;
    }
    if (!res.data.length) await needsRefresh(p.id); // ignored: the cloud has a newer change, or no permission
    await markClean('projects', p, { cloud: 1, syncUser: user.id });
  }

  // Projects this device may upload into: in the cloud and synced by this account.
  const mine = new Set((await db.projects.toArray()).filter((p) => p.cloud && p.syncUser === user.id).map((p) => p.id));

  for (const table of TABLES) {
    const dirty = (await db.table(table).where('dirty').equals(1).toArray()).filter((r) => mine.has(r.projectId));
    let done = 0;
    for (const r of dirty) {
      if (!r.cloud && r.deletedAt) { await markClean(table, r); continue; }
      if (BLOB_FIELDS[table]) {
        setStatus({ message: `Uploading ${table === 'photos' ? 'photos' : 'drawing files'} (${++done} of ${dirty.length})…` });
        const ok = await uploadBlobs(ctx, table, r);
        if (!ok) continue;
      }
    }
    // Rows go up in batches (blob records were updated with their storage paths above).
    const rows = (await db.table(table).where('dirty').equals(1).toArray()).filter((r) => mine.has(r.projectId) && !(!r.cloud && r.deletedAt));
    for (let i = 0; i < rows.length; i += PAGE) await upsertBatch(ctx, table, rows.slice(i, i + PAGE));
  }
  setStatus({ message: '' });
}

// Sends one batch; if the batch is refused, retries one at a time so one bad record can't block the rest.
async function upsertBatch(ctx, table, records) {
  const { client } = ctx;
  const res = await client.from(table).upsert(records.map(MAP[table].up), { onConflict: 'id' }).select('id');
  if (!res.error) {
    const applied = new Set(res.data.map((r) => r.id));
    for (const r of records) {
      if (!applied.has(r.id)) await needsRefresh(r.projectId);
      await markClean(table, r, { cloud: 1 });
    }
    return;
  }
  if (isNetwork(res.error)) throw new Error(res.error.message);
  if (records.length === 1) {
    await rejected(table, records[0], res.error);
    return;
  }
  for (const r of records) await upsertBatch(ctx, table, [r]);
}

// Uploads a record's drawing file / photos to Storage and records where they went.
async function uploadBlobs(ctx, table, r) {
  const store = ctx.client.storage.from(BUCKET);
  const paths = {};
  for (const [blobField, pathField, label] of BLOB_FIELDS[table]) {
    const blob = r[blobField];
    if (!blob || r.deletedAt) continue;
    // The original photo / drawing file never changes, so it goes up once. A marked-up photo is
    // re-sent whenever the record changed (the markup may have been edited).
    if (r[pathField] && blobField !== 'annotatedBlob') continue;
    const path = `${r.projectId}/${r.id}/${label}`;
    const { error } = await store.upload(path, blob, { upsert: true, contentType: blob.type || 'application/octet-stream' });
    if (error) {
      if (isNetwork(error)) throw new Error(error.message);
      const tooBig = /exceeded|too large|maximum/i.test(error.message || '');
      setStatus({ state: 'error', message: tooBig
        ? `"${r.name || 'A file'}" is over the 50 MB upload limit, so it can't sync yet.`
        : `Couldn't upload a file: ${error.message}` });
      console.warn('Upload refused', table, r.id, error);
      return false;
    }
    paths[pathField] = path;
  }
  if (Object.keys(paths).length) {
    // Save the paths without counting as a new edit (it's still dirty: the row itself goes up next).
    await safeWrite(table, [r.id], () => data.syncTransaction([table], (tx) => tx.table(table).update(r.id, paths)));
    Object.assign(r, paths);
  }
  return true;
}

// Marks a record uploaded — unless it changed again while uploading (then it stays dirty).
async function markClean(table, r, extra = {}) {
  await safeWrite(table, [r.id], () => data.syncTransaction([table], async (tx) => {
    const now = await tx.table(table).get(r.id);
    if (!now) return;
    const changed = now.updatedAt !== r.updatedAt;
    await tx.table(table).update(r.id, changed ? extra : { ...extra, dirty: 0 });
  }));
}

// The cloud refused this change (no permission, e.g. a viewer edited, or an editor tried to delete
// a project). Drop the local change and re-download that project's cloud version.
async function rejected(table, r, error) {
  console.warn('Change not accepted by the cloud', table, r.id, error);
  await markClean(table, r);
  await needsRefresh(table === 'projects' ? r.id : r.projectId);
}

// Next download re-reads the whole project and lets the cloud version win.
async function needsRefresh(projectId) {
  await data.syncTransaction(['syncState'], (tx) => tx.table('syncState').put({ projectId, cursors: {}, cloudWins: true }));
}

const isNetwork = (error) => /fetch|network|load failed|timeout/i.test(error?.message || '');

// ---------- Download ----------

async function download(ctx) {
  const { client, user, changed } = ctx;
  const db = data.syncDb;

  // Every project this account can see (the cloud's security rules decide which), and my role on each.
  const { data: projects, error } = await client.from('projects').select('*');
  if (error) throw new Error(error.message);
  const access = new Map((await cloud.myProjectRoles()).map((r) => [r.project_id, { role: r.role, trades: r.trades || [] }]));
  const accessKey = (a) => (a ? `${a.role}|${[...a.trades].sort().join(',')}` : '');

  // Projects this account synced before but can't see any more (removed from the project or the
  // company): take them off this device.
  const visible = new Set(projects.map((p) => p.id));
  for (const local of await db.projects.toArray()) {
    if (local.cloud && local.syncUser === user.id && !visible.has(local.id)) {
      await removeProjectFromDevice(local.id);
      changed.add(local.id);
    }
  }

  // First, the projects themselves and my role on each — before anything else, so a view-only
  // project is read-only on this device even if the rest of this sync gets interrupted.
  // What I'm allowed to see changed (e.g. Editor -> Trade)? Then re-read the whole project and drop
  // anything that's no longer visible (prune).
  const prune = new Set();
  for (const row of projects) {
    const local = await db.projects.get(row.id);
    const state = (await db.syncState.get(row.id)) || { projectId: row.id, cursors: {} };
    if (local && local.accessKey !== undefined && local.accessKey !== accessKey(access.get(row.id))) prune.add(row.id);
    if (await merge('projects', [row], state.cloudWins, { syncUser: user.id })) changed.add(row.id);
  }
  await data.syncTransaction(['projects'], async (tx) => {
    for (const row of projects) {
      const a = access.get(row.id);
      const role = a ? a.role : null;
      const local = await tx.table('projects').get(row.id);
      if (local && (local.myRole !== role || local.accessKey !== accessKey(a))) {
        await tx.table('projects').update(row.id, { myRole: role, accessKey: accessKey(a) });
        changed.add(row.id);
      }
    }
  });
  await data.refreshReadOnly();

  // In a view-only project, anything made on this device that never reached the cloud can't ever
  // upload (e.g. pins added before this device knew the project was view-only): remove it.
  const readOnlyIds = projects.filter((p) => data.isReadOnlyRole(access.get(p.id)?.role)).map((p) => p.id);
  if (readOnlyIds.length) {
    await data.syncTransaction(TABLES, async (tx) => {
      for (const t of TABLES) {
        const stray = (await tx.table(t).where('projectId').anyOf(readOnlyIds).toArray()).filter((r) => !r.cloud);
        if (stray.length) {
          await tx.table(t).bulkDelete(stray.map((r) => r.id));
          for (const r of stray) changed.add(r.projectId);
        }
      }
    });
  }

  for (const row of projects) {
    const state = (await db.syncState.get(row.id)) || { projectId: row.id, cursors: {} };
    if (prune.has(row.id)) state.cursors = {};

    for (const table of TABLES) {
      const since = state.cursors[table];
      const seen = new Set();
      let from = 0;
      let newest = since || null;
      for (;;) {
        let q = client.from(table).select('*').eq('project_id', row.id).order('synced_at').range(from, from + PAGE - 1);
        if (since) q = q.gt('synced_at', new Date(Date.parse(since) - OVERLAP_MS).toISOString());
        const res = await q;
        if (res.error) throw new Error(res.error.message);
        for (const r of res.data) seen.add(r.id);
        if (res.data.length) {
          if (await merge(table, res.data, state.cloudWins)) changed.add(row.id);
          newest = res.data[res.data.length - 1].synced_at;
        }
        if (res.data.length < PAGE) break;
        from += PAGE;
      }
      if (newest) state.cursors[table] = newest;
      if (prune.has(row.id)) {
        const gone = (await db.table(table).where('projectId').equals(row.id).toArray()).filter((r) => r.cloud && !seen.has(r.id));
        if (gone.length) {
          await data.syncTransaction([table], (tx) => tx.table(table).bulkDelete(gone.map((r) => r.id)));
          changed.add(row.id);
        }
      }
    }
    state.cloudWins = false;
    await data.syncTransaction(['syncState'], (tx) => tx.table('syncState').put(state));
  }
}

// Removes a project and everything in it from this device only (the cloud is untouched).
async function removeProjectFromDevice(projectId) {
  await data.syncTransaction(['projects', ...TABLES, 'syncState'], async (tx) => {
    for (const t of TABLES) await tx.table(t).where('projectId').equals(projectId).delete();
    await tx.table('projects').delete(projectId);
    await tx.table('syncState').delete(projectId);
  });
}

// Merges cloud rows into the device. A device record with newer, not-yet-uploaded changes is
// kept (unless cloudWins). Returns true if anything on the device changed.
async function merge(table, rows, cloudWins, extra = {}) {
  let changedAny = false;
  await safeWrite(table, rows.map((r) => r.id), () => data.syncTransaction([table], async (tx) => {
    const store = tx.table(table);
    for (const row of rows) {
      const incoming = MAP[table].down(row);
      const local = await store.get(row.id);
      if (local && !cloudWins) {
        if (Date.parse(local.updatedAt) > Date.parse(incoming.updatedAt) && local.dirty) continue; // ours is newer
        if (local.updatedAt === incoming.updatedAt && !local.dirty && local.cloud) continue;        // already have it
      }
      const merged = { ...(local || {}), ...incoming, ...extra, cloud: 1, dirty: 0 };
      if (table === 'photos' && local && local.annotatedPath && incoming.updatedAt !== local.updatedAt) {
        merged.annotatedStale = 1; // the markup changed elsewhere: fetch the new marked-up photo
        if (fileMode() === 'open') merged.annotatedBlob = null; // fetched again when opened
      }
      if (merged.deletedAt && GONE[table]) Object.assign(merged, GONE[table]);
      await store.put(merged);
      changedAny = true;
    }
  }));
  return changedAny;
}

// "Download everything" mode: fetches drawing files and photos the device doesn't have yet
// (sheets first, they're needed to show the drawing; archived projects are skipped). Each one
// lands as soon as it's done, so screens can fill in. "Only what I open" mode skips this.
async function downloadFiles() {
  if (fileMode() !== 'all') return;
  const db = data.syncDb;
  const archived = new Set((await db.projects.toArray()).filter((p) => p.archivedAt || p.deletedAt).map((p) => p.id));
  const jobs = [];
  for (const f of await db.files.toArray()) {
    if (!f.deletedAt && !archived.has(f.projectId) && f.storagePath && !f.blob) jobs.push(['files', f, 'blob']);
  }
  for (const p of await db.photos.toArray()) {
    if (p.deletedAt || archived.has(p.projectId)) continue;
    if (p.originalPath && !p.originalBlob) jobs.push(['photos', p, 'originalBlob']);
    if (p.annotatedPath && (!p.annotatedBlob || p.annotatedStale)) jobs.push(['photos', p, 'annotatedBlob']);
  }
  let done = 0;
  for (const [table, r, field] of jobs) {
    setStatus({ message: `Downloading drawings and photos (${++done} of ${jobs.length})…` });
    try {
      await fetchBlob(table, { ...r, [field]: null }, field);
    } catch (err) {
      if (isNetwork(err)) break;
      console.warn('Download failed', table, r.id, err);
      continue;
    }
    announce(new Set([r.projectId]));
  }
  setStatus({ message: '' });
}
