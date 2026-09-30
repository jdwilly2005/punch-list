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
      .filter((i) => i.trade === oldName)
      .modify({ trade: newName, updatedAt: t });
  });
}

// Removes the trade from the project; items that used it become "no trade".
export async function deleteTrade(projectId, name) {
  await db.transaction('rw', db.projects, db.items, async () => {
    const t = now();
    const p = await db.projects.get(projectId);
    await db.projects.update(projectId, { trades: p.trades.filter((x) => x !== name), updatedAt: t });
    await db.items.where('projectId').equals(projectId)
      .filter((i) => i.trade === name)
      .modify({ trade: '', updatedAt: t });
  });
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

export async function getFileBlob(fileId) {
  const f = await db.files.get(fileId);
  return f ? f.blob : null;
}

// ---------- Item numbers and tags ----------
//
// Items are numbered automatically (#1, #2, ...). Numbers are project-wide across
// all sheets. A new item takes the LOWEST number not in use, so deleting #4 frees
// #4 for the next new item.
//
// An item can instead carry a custom tag (e.g. "CB-12", to match Procore). A tagged
// item gives its number back (number = null). Clearing the tag gives it a number again.

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

function lowestFreeNumber(items) {
  const used = new Set(items.map((i) => i.number).filter((n) => n != null));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

// The number the next new item in this project would get.
export async function nextItemNumber(projectId) {
  return lowestFreeNumber(await listItems(projectId));
}

// Works out number/tag for an item from what was typed in its "Number / tag" box:
//   ''         -> automatic number (keeps its current one, or gets the lowest free)
//   '12'       -> number 12, if no other item has it
//   'CB-12'    -> tag CB-12, if no other item has it; the number is given back
// Throws an Error with a plain-English message if the number/tag is taken.
function resolveNumber(item, others) {
  const typed = String(item.tag || '').trim();
  if (!typed) {
    const keep = item.number != null && !others.some((o) => o.number === item.number);
    return { tag: '', number: keep ? item.number : lowestFreeNumber(others) };
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
      item = newRecord({ drawingId: null, x: null, y: null, ...itemData, createdBy: CURRENT_USER });
    }
    Object.assign(item, resolveNumber(item, others));
    await db.items.put(item);

    for (const ph of photos) {
      if (ph.removed) {
        if (!ph.isNew) await db.photos.update(ph.id, { deletedAt: t, updatedAt: t });
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
  return db.transaction('rw', db.items, async () => {
    const item = { ...(await db.items.get(id)), ...changes, updatedAt: now() };
    if ('tag' in changes) {
      const others = (await listItems(item.projectId)).filter((i) => i.id !== id);
      Object.assign(item, resolveNumber(item, others));
    }
    await db.items.put(item);
    return item;
  });
}

export async function deleteItem(id) {
  const t = now();
  await db.transaction('rw', db.items, db.photos, async () => {
    await db.items.update(id, { deletedAt: t, updatedAt: t });
    await db.photos.where('itemId').equals(id).modify({ deletedAt: t, updatedAt: t });
  });
}

// ---------- Photos ----------

export async function listPhotos(itemId) {
  const all = (await db.photos.where('itemId').equals(itemId).toArray()).filter(alive);
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listProjectPhotos(projectId) {
  const all = (await db.photos.where('projectId').equals(projectId).toArray()).filter(alive);
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
