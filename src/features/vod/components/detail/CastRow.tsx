import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { Person } from '@/api/types';

import { handleGridKeyDown } from '../../lib/gridNav';
import { cn, useImageChain } from '@/ui';

const MAX_CAST = 16;

/** Cast chips; people with a TMDB id link to their actor page. */
export function CastRow({ cast, sourceId }: { cast: Person[]; sourceId: string }) {
  const { t } = useTranslation('vod');
  const people = cast.slice(0, MAX_CAST);
  const headingId = useId();
  // With no linked chip the scrolling row has nothing to focus, so the row
  // itself takes focus (named by the heading) and scrolls with the arrow keys.
  const focusableRow = !people.some((p) => p.id !== undefined);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h2 id={headingId} className="text-sm font-medium text-fg-subtle">{t('cast')}</h2>
      <ul
        aria-labelledby={headingId}
        tabIndex={focusableRow ? 0 : undefined}
        data-testid="vod-cast-row"
        className="-mx-1 flex gap-2 overflow-x-auto rounded-md px-1 pb-2 outline-none focus-visible:ring-2 focus-visible:ring-focus"
        onKeyDown={(e) => handleGridKeyDown(e, { orientation: 'horizontal', count: people.length })}
      >
        {people.map((p, i) => {
          const body = (
            <>
              <Avatar person={p} />
              <span className="flex min-w-0 flex-col leading-tight">
                <span dir="auto" className="truncate text-[calc(13rem/15)] font-medium text-fg text-match-parent">{p.name}</span>
                {p.role && <span className="truncate text-xs text-fg-subtle">{p.role}</span>}
              </span>
            </>
          );
          const cls = 'flex max-w-56 shrink-0 items-center gap-2 rounded-full border border-edge bg-surface/70 py-1 pe-4 ps-1';
          return (
            <li key={`${p.id ?? 'n'}-${p.name}-${i}`}>
              {p.id !== undefined ? (
                <Link
                  to={`/s/${encodeURIComponent(sourceId)}/actor/${p.id}`}
                  data-grid-index={i}
                  className={cn(cls, 'hover:border-fg-subtle hover:bg-surface-2')}
                >
                  {body}
                </Link>
              ) : (
                <span className={cls}>
                  {body}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * A cast member's TMDB profile picture through the image cache (then directly
 * once), with their initials when there is none or it fails to load.
 */
function Avatar({ person }: { person: Person }) {
  const image = useImageChain([person.profileUrl]);
  const initials = person.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return image.url ? (
    <img
      key={image.url}
      src={image.url}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      referrerPolicy="no-referrer"
      onError={image.onError}
      className="h-8 w-8 shrink-0 rounded-full bg-surface-3 object-cover"
    />
  ) : (
    <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[calc(11rem/15)] font-semibold text-fg-muted">
      {initials}
    </span>
  );
}
