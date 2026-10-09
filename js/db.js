// db.js — the ONLY file that talks to storage.
//
// Everything else in the app calls the functions exported here. When we move
// to Supabase/Firebase for multi-user sync, this is the file that gets
// rewritten; the screens shouldn't need to change.
//
// Conventions that keep a future migration painless:
//   - Every record has a random UUID `id` (never 1, 2, 3...), so records made
//     on different phones can never collide.
//   - Every record has createdAt / updatedAt (ISO strings) so a sync can tell
//     which copy is newer.
//   - Nothing is ever hard-deleted: we set `deletedAt`, so a sync can tell
//     other devices "this was removed".

/* global Dexie */
const db = new Dexie('punchlist');
db.version(1).stores({
  // Only indexed fields are listed here; records can hold any other fields.
  projects: 'id, updatedAt',
  files: 'id, projectId',            // uploaded PDFs/images (one PDF can hold many sheets)
  drawings: 'id, projectId, updatedAt',
  items: 'id, projectId, drawingId, updatedAt',
  photos: 'id, itemId, projectId, updatedAt',
});
// v2: an item can have several trades. `trade: 'ABC'` becomes `trades: ['ABC']`.
// (Dexie runs this once on each device the first time the new app version opens.)
db.version(2).stores({}).upgrade((tx) => tx.table('items').toCollection().modify((item) => {
  item.trades = Array.isArray(item.trades) ? item.trades : (item.trade ? [item.trade] : []);
  delete item.trade;
}));

// v3 (cloud sync): every record carries `dirty` (1 = changed on this device, not uploaded yet).
// Existing records are all marked dirty, so they upload the first time someone signs in.
// `syncState` keeps, per project, how far this device has downloaded ("cursor").
const SYNCED_TABLES = ['projects', 'files', 'drawings', 'items', 'photos'];
db.version(3).stores({
  projects: 'id, updatedAt, dirty',
  files: 'id, projectId, dirty',
  drawings: 'id, projectId, updatedAt, dirty',
  items: 'id, projectId, drawingId, updatedAt, dirty',
  photos: 'id, itemId, projectId, updatedAt, dirty',
  syncState: 'projectId',
}).upgrade(async (tx) => {
  for (const name of SYNCED_TABLES) await tx.table(name).toCollection().modify({ dirty: 1 });
});

// Any change made in the app marks the record dirty and tells sync.js (after a short pause).
// Changes written BY sync (downloads, "uploaded" marks) run in a transaction flagged `fromSync`,
// so they don't count as new local changes.
let localChangeListener = () => {};
export function onLocalChange(fn) { localChangeListener = fn; }

// Projects someone else shared with this account as Viewer or Trade are read-only here (the cloud
// would refuse the changes anyway). `myRole` on a project is set by sync.js.
const READ_ONLY_ROLES = ['viewer', 'trade'];
const readOnlyProjects = new Set();
const cloudProjects = new Set(); // projects that are in the cloud (see isNumberPending)
export async function refreshReadOnly() {
  readOnlyProjects.clear();
  cloudProjects.clear();
  for (const p of await db.projects.toArray()) {
    if (READ_ONLY_ROLES.includes(p.myRole)) readOnlyProjects.add(p.id);
    if (p.cloud) cloudProjects.add(p.id);
  }
}
export const isReadOnlyRole = (role) => READ_ONLY_ROLES.includes(role);
refreshReadOnly().catch(() => {});
function guardReadOnly(table, obj) {
  const projectId = table === 'projects' ? obj.id : obj.projectId;
  if (readOnlyProjects.has(projectId)) {
    throw new Error('This project is view-only for you. Ask one of its managers if you need to make changes.');
  }
}

for (const name of SYNCED_TABLES) {
  db.table(name).hook('creating', (_key, obj, tx) => {
    if (tx.fromSync) return;
    guardReadOnly(name, obj);
    obj.dirty = 1;
    tx.on('complete', () => localChangeListener());
  });
  db.table(name).hook('updating', (mods, _key, obj, tx) => {
    if (tx.fromSync) return undefined;
    guardReadOnly(name, obj);
    tx.on('complete', () => localChangeListener());
    return { dirty: 1 };
  });
}

// Runs fn inside a write transaction whose changes are NOT treated as local edits (for sync.js).
export function syncTransaction(tables, fn) {
  return db.transaction('rw', tables.map((t) => db.table(t)), async (tx) => {
    tx.fromSync = true;
    return fn(tx);
  });
}
export const syncDb = db; // sync.js reads tables directly

export const STATUSES = ['Open', 'In Progress', 'Ready for Review', 'Closed'];

// Placeholder until there are real user accounts.
const CURRENT_USER = 'local';

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Fallback for plain-http testing on a phone, where randomUUID isn't available.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const now = () => new Date().toISOString();

// Deleted records stay as small "tombstones" (for syncing later), but their big
// files are cleared so deleting really frees up space on the phone.
const BLOBS_GONE = { originalBlob: null, annotatedBlob: null };
const alive = (r) => r && !r.deletedAt;

function newRecord(fields) {
  const t = now();
  return { ...fields, id: newId(), createdAt: t, updatedAt: t, deletedAt: null };
}

// ---------- Projects ----------

export async function listProjects() {
  const all = (await db.projects.toArray()).filter(alive);
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProject(id) {
  const p = await db.projects.get(id);
  return alive(p) ? p : null;
}

export async function createProject(name) {
  const project = newRecord({
    name,
    address: '',
    trades: [], // each project builds its own list of trades / subs
    createdBy: CURRENT_USER,
  });
  await db.projects.add(project);
  return project;
}

export async function updateProject(id, changes) {
  await db.projects.update(id, { ...changes, updatedAt: now() });
}

// Archived projects move to the "Archived" section of the Projects screen; nothing is removed.
export async function setProjectArchived(id, archived) {
  await updateProject(id, { archivedAt: archived ? now() : null });
}

// Removes a project and everything in it (sheets, items, photos) from this device.
export async function deleteProject(id) {
  const t = now();
  const gone = { deletedAt: t, updatedAt: t };
  await db.transaction('rw', [db.projects, db.files, db.drawings, db.items, db.photos], async () => {
    await db.projects.update(id, gone);
    await db.drawings.where('projectId').equals(id).modify(gone);
    await db.items.where('projectId').equals(id).modify(gone);
    await db.files.where('projectId').equals(id).modify({ ...gone, blob: null });
    await db.photos.where('projectId').equals(id).modify({ ...gone, ...BLOBS_GONE });
  });
}

// ---------- Trades (a list of names stored on the project) ----------

const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

export async function addTrade(projectId, name) {
  const p = await db.projects.get(projectId);
  if (p.trades.some((t) => t.toLowerCase() === name.toLowerCase())) return;
  await updateProject(projectId, { trades: [...p.trades, name].sort(byName) });
}

// Renames the trade on the project AND on every item assigned to it.
export async function renameTrade(projectId, oldName, newName) {
  await db.transaction('rw', db.projects, db.items, async () => {
    const t = now();
    const p = await db.projects.get(projectId);
    const trades = [...new Set(p.trades.map((x) => (x === oldName ? newName : x)))].sort(byName);
    await db.projects.update(projectId, { trades, updatedAt: t });
    await db.items.where('projectId').equals(projectId)
      .filter((i) => (i.trades || []).includes(oldName))
      .modify((i) => {
        i.trades = [...new Set(i.trades.map((x) => (x === oldName ? newName : x)))];
        i.updatedAt = t;
      });
  });
}

// Removes the trade from the project and from every item that had it.
export async function deleteTrade(projectId, name) {
  await db.transaction('rw', db.projects, db.items, async () => {
    const t = now();
    const p = await db.projects.get(projectId);
    await db.projects.update(projectId, { trades: p.trades.filter((x) => x !== name), updatedAt: t });
    await db.items.where('projectId').equals(projectId)
      .filter((i) => (i.trades || []).includes(name))
      .modify((i) => {
        i.trades = i.trades.filter((x) => x !== name);
        i.updatedAt = t;
      });
  });
}

// "ABC Drywall, Sparky Electric" (or '' for none).
export function tradesText(item) {
  return (item.trades || []).join(', ');
}

export async function projectSummary(projectId) {
  const [drawings, items] = await Promise.all([listDrawings(projectId), listItems(projectId)]);
  return {
    sheets: drawings.length,
    items: items.length,
    notClosed: items.filter((i) => i.status !== 'Closed').length,
  };
}

// ---------- Drawings (sheets) ----------

export async function listDrawings(projectId) {
  const all = (await db.drawings.where('projectId').equals(projectId).toArray()).filter(alive);
  return all.sort((a, b) => a.sortOrder - b.sortOrder);
}

// Saves one uploaded file and creates a drawing for each of its pages.
// `pages` is [{ pageNumber, width, height }] — width/height in the file's own units.
export async function addDrawings(projectId, file, kind, pages) {
  const fileRecord = newRecord({
    projectId,
    name: file.name,
    type: file.type || (kind === 'pdf' ? 'application/pdf' : ''),
    blob: new Blob([file], { type: file.type }),
  });
  const existing = await listDrawings(projectId);
  let order = existing.length ? Math.max(...existing.map((d) => d.sortOrder)) + 1 : 0;
  const baseName = file.name.replace(/\.[^.]+$/, '');
  const drawings = pages.map((p) => newRecord({
    projectId,
    fileId: fileRecord.id,
    fileType: kind, // 'pdf' | 'image'
    pageNumber: p.pageNumber,
    widthPx: p.width,
    heightPx: p.height,
    name: pages.length > 1 ? `${baseName} – p${p.pageNumber}` : baseName,
    sortOrder: order++,
  }));
  await db.transaction('rw', db.files, db.drawings, async () => {
    await db.files.add(fileRecord);
    await db.drawings.bulkAdd(drawings);
  });
  return drawings;
}

export async function updateDrawing(id, changes) {
  await db.drawings.update(id, { ...changes, updatedAt: now() });
}

// Deletes one sheet. Its pinned items are either kept as "list only" items
// (keepItems = true: they lose their pin) or deleted along with their photos.
// The uploaded file itself is cleared once none of its pages are left.
export async function deleteDrawing(id, { keepItems }) {
  const t = now();
  const gone = { deletedAt: t, updatedAt: t };
  await db.transaction('rw', [db.files, db.drawings, db.items, db.photos], async () => {
    const drawing = await db.drawings.get(id);
    await db.drawings.update(id, gone);
    const pinned = db.items.where('drawingId').equals(id).filter(alive);
    if (keepItems) {
      await pinned.modify({ drawingId: null, x: null, y: null, updatedAt: t });
    } else {
      const ids = (await pinned.toArray()).map((i) => i.id);
      await db.items.where('id').anyOf(ids).modify(gone);
      await db.photos.where('itemId').anyOf(ids).modify({ ...gone, ...BLOBS_GONE });
    }
    const pagesLeft = await db.drawings.where('projectId').equals(drawing.projectId)
      .filter((d) => alive(d) && d.fileId === drawing.fileId).count();
    if (!pagesLeft) await db.files.update(drawing.fileId, { ...gone, blob: null });
  });
}

// ---------- Files and photos that are only in the cloud ----------
// On a device set to "only what I open" (sync.js), synced drawing files and photos aren't
// downloaded ahead of time. sync.js registers a fetcher; these accessors use it to download a
// missing file the moment a screen needs it (it's then kept on the device until "Free up space").
let blobFetcher = null;
export function setBlobFetcher(fn) { blobFetcher = fn; }

async function fetchMissing(table, record, field) {
  if (!blobFetcher || record[field]) return record[field] || null;
  try {
    return (await blobFetcher(table, record, field)) || null;
  } catch (err) {
    console.warn('Could not download', table, record.id, field, err);
    return null;
  }
}

// Fills in photos' missing original / marked-up images from the cloud (a few at a time).
async function withPhotoBlobs(photos) {
  const jobs = [];
  for (const p of photos) {
    if (!p.originalBlob && p.originalPath) jobs.push([p, 'originalBlob']);
    if (!p.annotatedBlob && p.annotatedPath) jobs.push([p, 'annotatedBlob']);
  }
  for (let i = 0; i < jobs.length; i += 4) {
    await Promise.all(jobs.slice(i, i + 4).map(async ([p, field]) => { p[field] = await fetchMissing('photos', p, field); }));
  }
  return photos;
}

export async function getFileBlob(fileId) {
  const f = await db.files.get(fileId);
  if (!f) return null;
  return f.blob || (f.storagePath ? fetchMissing('files', f, 'blob') : null);
}

// ---------- Item numbers and tags ----------
//
// Items are numbered automatically (#1, #2, ...). Numbers are project-wide across
// all sheets. A new item takes the next number after the highest ever used in the
// project; numbers are never re-used (deleted #4 stays retired, so old tape, PDFs and
// notes never point at the wrong item).
//
// An item can instead carry a custom tag (e.g. "CB-12", to match Procore). A tagged
// item gives up its number (number = null). Clearing the tag gives it a new number.
//
// Offline, two people can still pick the same number. The cloud is the referee
// (supabase/010): the first to sync keeps it, the other gets the next free one, and
// sync.js tells that person. Until an item has synced its number isn't final
// (isNumberPending, shown as a dashed outline on pins and in the list).

// "5" or "CB-12" — what goes on the pin and in the # column.
export function itemRef(item) {
  return item.tag || String(item.number ?? '?');
}

// "#5" or "CB-12" — for sentences like "Item #5 saved".
export function itemName(item) {
  return item.tag || `#${item.number ?? '?'}`;
}

// Sort order: numbered items first (1, 2, 3...), then tagged items A–Z.
export function compareItems(a, b) {
  const an = a.number ?? Infinity;
  const bn = b.number ?? Infinity;
  if (an !== bn) return an - bn;
  return (a.tag || '').localeCompare(b.tag || '', undefined, { numeric: true, sensitivity: 'base' });
}

// The number the next new item in this project would get: one more than the highest ever used,
// counting deleted items and what the cloud has seen (project.highestNumber, set by sync.js).
export async function nextItemNumber(projectId) {
  const project = await db.projects.get(projectId);
  let top = project?.highestNumber || 0;
  await db.items.where('projectId').equals(projectId).each((i) => { if (i.number > top) top = i.number; });
  return top + 1;
}

// Not in the cloud yet, in a project that is: its number/tag could still change when it syncs.
export function isNumberPending(item) {
  return !item.cloud && cloudProjects.has(item.projectId);
}

// Works out number/tag for an item from what was typed in its "Number / tag" box:
//   ''         -> automatic number (keeps its current one, or gets the next number)
//   '12'       -> number 12, if no other item has it
//   'CB-12'    -> tag CB-12, if no other item has it; the number is given back
// Throws an Error with a plain-English message if the number/tag is taken.
function resolveNumber(item, others, next) {
  const typed = String(item.tag || '').trim();
  if (!typed) {
    const keep = item.number != null && !others.some((o) => o.number === item.number);
    return { tag: '', number: keep ? item.number : next };
  }
  const plain = typed.replace(/^#\s*/, '');
  if (/^\d+$/.test(plain)) {
    const n = Number(plain);
    if (n < 1) throw new Error('Item numbers start at 1.');
    if (others.some((o) => o.number === n)) throw new Error(`#${n} is already used by another item.`);
    return { tag: '', number: n };
  }
  const lower = typed.toLowerCase();
  if (others.some((o) => (o.tag || '').toLowerCase() === lower)) {
    throw new Error(`"${typed}" is already used by another item.`);
  }
  return { tag: typed, number: null };
}

// ---------- Punch items ----------

export async function listItems(projectId) {
  const all = (await db.items.where('projectId').equals(projectId).toArray()).filter(alive);
  return all.sort(compareItems);
}

// Creates or updates an item, plus any photo changes, in one transaction.
// Numbering follows resolveNumber() above. Items with no drawingId (x/y null) are
// "list only" items: they're in the list and exports but have no pin.
// `photos` is the form's photo list; each entry may be flagged isNew / dirty / removed.
export async function saveItem(itemData, photos = []) {
  return db.transaction('rw', db.projects, db.items, db.photos, async () => {
    const t = now();
    const others = (await listItems(itemData.projectId)).filter((i) => i.id !== itemData.id);
    let item;
    if (itemData.id) {
      const existing = await db.items.get(itemData.id);
      item = { ...existing, ...itemData, updatedAt: t };
    } else {
      item = newRecord({ drawingId: null, x: null, y: null, trades: [], ...itemData, createdBy: CURRENT_USER });
    }
    Object.assign(item, resolveNumber(item, others, await nextItemNumber(item.projectId)));
    await db.items.put(item);

    for (const ph of photos) {
      if (ph.removed) {
        if (!ph.isNew) await db.photos.update(ph.id, { deletedAt: t, updatedAt: t, ...BLOBS_GONE });
      } else if (ph.isNew) {
        await db.photos.add({
          id: ph.id,
          itemId: item.id,
          projectId: item.projectId,
          originalBlob: ph.originalBlob,
          annotatedBlob: ph.annotatedBlob || null,
          markup: ph.markup || [],
          createdAt: t,
          updatedAt: t,
          deletedAt: null,
        });
      } else if (ph.dirty) {
        await db.photos.update(ph.id, { annotatedBlob: ph.annotatedBlob, markup: ph.markup, updatedAt: t });
      }
    }
    return item;
  });
}

// Quick edit of a few fields (used by the list view's inline editing).
// Changing `tag` re-checks the numbering (see resolveNumber) and may throw.
export async function updateItem(id, changes) {
  return db.transaction('rw', db.projects, db.items, async () => {
    const item = { ...(await db.items.get(id)), ...changes, updatedAt: now() };
    if ('tag' in changes) {
      const others = (await listItems(item.projectId)).filter((i) => i.id !== id);
      Object.assign(item, resolveNumber(item, others, await nextItemNumber(item.projectId)));
    }
    await db.items.put(item);
    return item;
  });
}

export async function deleteItem(id) {
  const t = now();
  await db.transaction('rw', db.items, db.photos, async () => {
    await db.items.update(id, { deletedAt: t, updatedAt: t });
    await db.photos.where('itemId').equals(id).modify({ deletedAt: t, updatedAt: t, ...BLOBS_GONE });
  });
}

// ---------- Photos ----------

// Photo lists download any images that are only in the cloud (needs signal; without it those
// photos come back with no image, and screens show a placeholder).
export async function listPhotos(itemId) {
  const all = (await db.photos.where('itemId').equals(itemId).toArray()).filter(alive);
  return withPhotoBlobs(all.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
}

export async function listProjectPhotos(projectId) {
  const all = (await db.photos.where('projectId').equals(projectId).toArray()).filter(alive);
  return withPhotoBlobs(all.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
}

// ---------- Whole projects (for the backup / share file, see backup.js) ----------

// Everything that makes up one project, with drawing files and photos as Blobs.
// Deleted records are left out.
export async function readProjectBundle(projectId) {
  const of = (table) => table.where('projectId').equals(projectId).filter(alive).toArray();
  const [project, files, drawings, items, photos] = await Promise.all([
    getProject(projectId), of(db.files), of(db.drawings), of(db.items), of(db.photos),
  ]);
  if (!project) return null;
  for (const f of files) if (!f.blob && f.storagePath) f.blob = await fetchMissing('files', f, 'blob');
  await withPhotoBlobs(photos);
  return { project, files, drawings, items, photos };
}

// The last time anything in the project changed (an item, a sheet, a photo...).
export async function projectLastChanged(projectId) {
  let last = (await db.projects.get(projectId))?.updatedAt || '';
  for (const table of [db.files, db.drawings, db.items, db.photos]) {
    await table.where('projectId').equals(projectId).each((r) => { if (r.updatedAt > last) last = r.updatedAt; });
  }
  return last;
}

// Saves a project from a backup / share file.
//   asCopy: false -> keeps the file's ids. If the project is already on this device it is
//           REPLACED: anything here that the file doesn't have is removed.
//   asCopy: true  -> saves it as a separate project with fresh ids, named `name`.
export async function writeProjectBundle(bundle, { asCopy = false, name } = {}) {
  const b = asCopy ? copyBundle(bundle, name) : bundle;
  // Sync bookkeeping from the device the file came from doesn't apply here: these records upload
  // fresh from this device (and a copy has new ids, so its files/photos must upload again too).
  const SYNC_FIELDS = ['dirty', 'cloud', 'syncUser', 'annotatedStale', ...(asCopy ? ['storagePath', 'originalPath', 'annotatedPath'] : [])];
  const strip = (r) => { const c = { ...r }; for (const f of SYNC_FIELDS) delete c[f]; return c; };
  b.project = strip(b.project);
  for (const key of ['files', 'drawings', 'items', 'photos']) b[key] = b[key].map(strip);
  const projectId = b.project.id;
  const tables = { files: db.files, drawings: db.drawings, items: db.items, photos: db.photos };
  const blobsGone = { files: { blob: null }, photos: BLOBS_GONE };
  for (const key of Object.keys(tables)) {
    b[key] = b[key].map((r) => ({ ...r, projectId, deletedAt: null }));
  }
  b.items = b.items.map((i) => ({ ...i, trades: Array.isArray(i.trades) ? i.trades : (i.trade ? [i.trade] : []) }));

  await db.transaction('rw', [db.projects, ...Object.values(tables)], async () => {
    const t = now();
    for (const [key, table] of Object.entries(tables)) {
      const keep = new Set(b[key].map((r) => r.id));
      await table.where('projectId').equals(projectId).filter((r) => alive(r) && !keep.has(r.id))
        .modify({ deletedAt: t, updatedAt: t, ...blobsGone[key] });
      await table.bulkPut(b[key]);
    }
    await db.projects.put({ trades: [], ...b.project, deletedAt: null });
  });
  return b.project;
}

// Same project with brand-new ids (links between records kept), so it sits beside the original.
function copyBundle(b, name) {
  const ids = new Map();
  const map = (id) => {
    if (id == null) return id;
    if (!ids.has(id)) ids.set(id, newId());
    return ids.get(id);
  };
  const re = (r, ...links) => {
    const c = { ...r, id: map(r.id) };
    for (const f of links) c[f] = map(r[f]);
    return c;
  };
  return {
    project: { ...re(b.project), name, updatedAt: now() },
    files: b.files.map((r) => re(r)),
    drawings: b.drawings.map((r) => re(r, 'fileId')),
    items: b.items.map((r) => re(r, 'drawingId')),
    photos: b.photos.map((r) => re(r, 'itemId')),
  };
}
