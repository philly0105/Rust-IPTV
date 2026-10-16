/**
 * The source the guide opens on when its URL names none (the rail's TV guide link): the one last
 * browsed on the Live page or picked in the guide, so the guide follows the user (L4-live-2).
 */
let lastGuideSource: string | undefined;

export function rememberGuideSource(sourceId: string): void {
  if (sourceId) lastGuideSource = sourceId;
}

/** The remembered source while it still exists, else the first one. */
export function defaultGuideSource(sources: readonly { id: string }[] | undefined): string | undefined {
  if (lastGuideSource && sources?.some((s) => s.id === lastGuideSource)) return lastGuideSource;
  return sources?.[0]?.id;
}

/** Testing only. */
export function __resetGuideSourceForTests(): void {
  lastGuideSource = undefined;
}
