// trades.js — the "Trades & subs" screen: add, rename, and delete a project's trades.

import * as data from './db.js';
import { el, toast } from './ui.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// After the manager closes, work out what a previously-selected trade name is now:
// its new name if it was renamed, '' if it was deleted.
export function resolveTrade(name, result) {
  if (!name || !result) return name;
  const current = result.renamed[name] || name;
  return result.deleted.includes(current) ? '' : current;
}

// onClose({ changed, renamed: { oldName: newName }, deleted: [names] })
export function openTradeManager({ projectId, onClose }) {
  const renamed = {};
  const deleted = [];
  let changed = false;

  const nameInput = el('input', {
    type: 'text', placeholder: 'e.g. ABC Electric', maxlength: '60', autocomplete: 'off', 'aria-label': 'New trade name',
  });
  const addForm = el('form', { class: 'trade-add' },
    nameInput, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Add'));
  const listEl = el('div', { class: 'trade-list' });

  const isDuplicate = (trades, name, except) => trades.some(
    (t) => t !== except && t.toLowerCase() === name.toLowerCase());

  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    const project = await data.getProject(projectId);
    if (isDuplicate(project.trades, name)) {
      toast(`"${name}" is already on the list`);
      return;
    }
    await data.addTrade(projectId, name);
    changed = true;
    nameInput.value = '';
    nameInput.focus();
    await renderList();
  });

  async function renderList() {
    const [project, items] = await Promise.all([data.getProject(projectId), data.listItems(projectId)]);
    const count = (name) => items.filter((i) => (i.trades || []).includes(name)).length;
    listEl.replaceChildren(...(project.trades.length
      ? project.trades.map((t) => el('div', { class: 'trade-row' },
        el('div', { class: 'trade-name' }, t, el('small', {}, plural(count(t), 'item'))),
        el('button', { type: 'button', class: 'btn btn-small', onclick: () => rename(t, project.trades) }, 'Rename'),
        el('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: () => remove(t, count(t)) }, 'Delete')))
      : [el('p', { class: 'meta' }, 'No trades yet. Add the subs / trades on this job above.')]));
  }

  async function rename(oldName, trades) {
    const newName = (window.prompt('Rename trade', oldName) || '').trim();
    if (!newName || newName === oldName) return;
    if (isDuplicate(trades, newName, oldName)) {
      toast(`"${newName}" is already on the list`);
      return;
    }
    await data.renameTrade(projectId, oldName, newName);
    for (const k of Object.keys(renamed)) if (renamed[k] === oldName) renamed[k] = newName;
    renamed[oldName] = newName;
    changed = true;
    await renderList();
  }

  async function remove(name, inUse) {
    const msg = inUse
      ? `Delete "${name}"? It will be removed from the ${plural(inUse, 'item')} it's assigned to.`
      : `Delete "${name}"?`;
    if (!window.confirm(msg)) return;
    await data.deleteTrade(projectId, name);
    deleted.push(name);
    changed = true;
    await renderList();
  }

  const backdrop = el('div', { class: 'pl-layer' },
    el('div', { class: 'pl-sheet' },
      el('div', { class: 'pl-sheet-head' },
        el('span', { class: 'head-spacer' }),
        el('h2', {}, 'Trades & subs'),
        el('button', { type: 'button', class: 'btn btn-primary', onclick: close }, 'Done')),
      el('div', { class: 'pl-sheet-body' }, addForm, listEl)));
  document.body.append(backdrop);
  renderList();

  function close() {
    backdrop.remove();
    onClose({ changed, renamed, deleted });
  }
}
