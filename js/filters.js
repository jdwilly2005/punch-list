// filters.js — which punch items to show. Shared by the drawing and (later) the list view.
//
// A filter looks like: { statuses: ['Open', 'In Progress', ...], trade: '' }
//   statuses: the statuses to show (all four = no status filter)
//   trade:    '' = all trades, NO_TRADE = items with no trade picked, else a trade name

import { STATUSES } from './db.js';

export const NO_TRADE = '__none__';

export function defaultFilter() {
  return { statuses: [...STATUSES], trade: '' };
}

export function matchesStatus(item, filter) {
  return filter.statuses.includes(item.status);
}

export function matchesTrade(item, filter) {
  if (!filter.trade) return true;
  if (filter.trade === NO_TRADE) return !item.trade;
  return item.trade === filter.trade;
}

export function matches(item, filter) {
  return matchesStatus(item, filter) && matchesTrade(item, filter);
}

export function isFiltering(filter) {
  return filter.statuses.length < STATUSES.length || !!filter.trade;
}

// Plain-English summary, e.g. "Statuses: Open, In Progress · Trade: ABC Drywall" (or '' if none).
export function describeFilter(filter) {
  const parts = [];
  if (filter.statuses.length < STATUSES.length) parts.push(`Statuses: ${filter.statuses.join(', ') || 'none'}`);
  if (filter.trade) parts.push(`Trade: ${filter.trade === NO_TRADE ? 'No trade set' : filter.trade}`);
  return parts.join(' · ');
}

// Filters are remembered per project on this device (a convenience, not project data).
const key = (projectId) => `punchlist:filter:${projectId}`;

export function loadFilter(projectId) {
  try {
    const saved = JSON.parse(localStorage.getItem(key(projectId)));
    if (saved && Array.isArray(saved.statuses)) {
      return { statuses: saved.statuses.filter((s) => STATUSES.includes(s)), trade: saved.trade || '' };
    }
  } catch {
    // no saved filter, or storage unavailable
  }
  return defaultFilter();
}

export function saveFilter(projectId, filter) {
  try {
    localStorage.setItem(key(projectId), JSON.stringify(filter));
  } catch {
    // storage unavailable — filter just won't be remembered
  }
}
