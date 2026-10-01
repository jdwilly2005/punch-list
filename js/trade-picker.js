// trade-picker.js — choose one or more trades / subs for an item, as tap-to-toggle chips.
// Used inside the item form, and as a pop-up from the List tab's Trade column.

import * as data from './db.js';
import { el } from './ui.js';
import { openTradeManager, resolveTrade } from './trades.js';

// project: the project record; its `trades` list is refreshed here when trades are added or managed.
// selected: the item's current trades.
// onChange(trades): the chosen trades changed.
// onTradesChanged(): the project's trade list itself changed (so the filter bar etc. can refresh).
// Returns { node, selected }.
export function createTradeChips({ project, selected, onChange = () => {}, onTradesChanged = () => {} }) {
  let chosen = [...selected];
  const node = el('div', { class: 'trade-chips', role: 'group', 'aria-label': 'Trades / subs' });

  // Keep the chosen trades in the project's (alphabetical) order.
  const inOrder = (list) => {
    const at = (t) => { const i = project.trades.indexOf(t); return i < 0 ? Infinity : i; };
    return [...new Set(list)].sort((a, b) => at(a) - at(b));
  };

  function render() {
    const names = [...project.trades];
    for (const t of chosen) if (!names.includes(t)) names.push(t);
    node.replaceChildren(...[ // (filter: replaceChildren would print an empty slot as the text "null")
      ...names.map((t) => el('button', {
        type: 'button', class: 'trade-chip', 'aria-pressed': String(chosen.includes(t)), onclick: () => toggle(t),
      }, t)),
      el('button', { type: 'button', class: 'trade-chip trade-chip-tool', onclick: add }, '＋ Add trade'),
      project.trades.length
        ? el('button', { type: 'button', class: 'trade-chip trade-chip-tool', onclick: manage }, '⚙︎ Manage')
        : null,
    ].filter(Boolean));
  }

  function changed() {
    render();
    onChange([...chosen]);
  }

  function toggle(t) {
    chosen = chosen.includes(t) ? chosen.filter((x) => x !== t) : inOrder([...chosen, t]);
    changed();
  }

  async function add() {
    const name = (window.prompt('New trade / subcontractor name') || '').trim();
    if (!name) return;
    await data.addTrade(project.id, name);
    project.trades = (await data.getProject(project.id)).trades;
    // If it already existed with different capitals, use the existing spelling.
    const real = project.trades.find((t) => t.toLowerCase() === name.toLowerCase()) || name;
    chosen = inOrder([...chosen, real]);
    changed();
    onTradesChanged();
  }

  function manage() {
    openTradeManager({
      projectId: project.id,
      onClose: async (result) => {
        if (!result.changed) return;
        project.trades = (await data.getProject(project.id)).trades;
        chosen = inOrder(chosen.map((t) => resolveTrade(t, result)).filter(Boolean));
        changed();
        onTradesChanged();
      },
    });
  }

  render();
  return { node, get selected() { return [...chosen]; } };
}

// Pop-up for editing one item's trades (List tab). onDone(trades) runs only if they changed.
export function openTradePicker({ project, item, onDone, onTradesChanged }) {
  const before = (item.trades || []).join('\n');
  const chips = createTradeChips({ project, selected: item.trades || [], onTradesChanged });
  const layer = el('div', { class: 'pl-layer' },
    el('div', { class: 'pl-sheet' },
      el('div', { class: 'pl-sheet-head' },
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close(false) }, 'Cancel'),
        el('h2', {}, `Trades · Item ${data.itemName(item)}`),
        el('button', { type: 'button', class: 'btn btn-primary', onclick: () => close(true) }, 'Done')),
      el('div', { class: 'pl-sheet-body' },
        el('p', { class: 'meta' }, 'Tap every trade / sub responsible for this item.'),
        chips.node)));
  document.body.append(layer);

  function close(save) {
    layer.remove();
    if (save && chips.selected.join('\n') !== before) onDone(chips.selected);
  }
}
