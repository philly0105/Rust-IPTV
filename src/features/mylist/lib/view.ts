/**
 * How /my-list shows the titles: a poster grid (the default, as streaming apps show a watchlist)
 * or the list with ranks, progress and drag handles. A UI preference of this browser, so it lives
 * in localStorage rather than the core's settings.
 */

export type MyListView = 'grid' | 'list';

export const VIEW_KEY = 'mylist.view';

export function readView(): MyListView {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export function writeView(view: MyListView): void {
  try {
    if (view === 'list') localStorage.setItem(VIEW_KEY, 'list');
    else localStorage.removeItem(VIEW_KEY);
  } catch {
    // Private mode or a full store: the choice lasts for this visit only.
  }
}
