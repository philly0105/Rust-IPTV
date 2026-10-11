/** Returns a new array with the element at `from` moved to `to` (clamped). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  if (target === from) return next;
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item as T);
  return next;
}

/** Applies an id order to sources, rewriting `position` to match. */
export function applyOrder<T extends { id: string; position: number }>(items: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(items.map((s) => [s.id, s]));
  const ordered: T[] = [];
  for (const id of ids) {
    const s = byId.get(id);
    if (s) {
      ordered.push(s);
      byId.delete(id);
    }
  }
  ordered.push(...byId.values());
  return ordered.map((s, i) => ({ ...s, position: i }));
}
