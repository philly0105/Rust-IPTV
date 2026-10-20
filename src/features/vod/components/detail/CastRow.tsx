import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { Person } from '@/api/types';

import { useEdgeFades } from '../../hooks/useEdgeFades';
import { handleGridKeyDown } from '../../lib/gridNav';
import { cn, useImageChain } from '@/ui';
import { formatList } from '@/lib/intl';

const MAX_CAST = 16;

/**
 * Cast chips; people with a TMDB id link to their actor page. With `links` off (TMDB off: the
 * actor page would only say so) every chip is plain text, so a name is never a dead end. With no
 * picture and no link anywhere (a provider's cast list, TMDB off) the names are one line of text,
 * like the director's: a row of initials circles read as missing photos (critique: movie detail).
 */
export function CastRow({ cast, sourceId, links = true }: { cast: Person[]; sourceId: string; links?: boolean }) {
  const { t, i18n } = useTranslation('vod');
  const people = cast.slice(0, MAX_CAST);
  const headingId = useId();
  const linked = (p: Person) => links && p.id !== undefined;
  if (!people.some((p) => p.profileUrl || linked(p))) {
    return (
      <p className="text-sm text-fg-muted" data-testid="vod-cast-line">
        <span className="text-fg-subtle">{t('cast')} </span>
        <span dir="auto">{formatList(people.map((p) => p.name), i18n.language)}</span>
      </p>
    );
  }
  return <CastChips people={people} sourceId={sourceId} linked={linked} headingId={headingId} />;
}

function CastChips({ people, sourceId, linked, headingId }: { people: Person[]; sourceId: string; linked: (p: Person) => boolean; headingId: string }) {
  const { t } = useTranslation('vod');
  // With no linked chip the scrolling row has nothing to focus, so the row
  // itself takes focus (named by the heading) and scrolls with the arrow keys.
  const focusableRow = !people.some(linked);
  // The row runs on through the page gutter to the window's edge, as the poster rails do, and the
  // hidden end fades out there instead of clipping a name mid-word at the column's edge.
  const fades = useEdgeFades(String(people.length));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h2 id={headingId} className="text-sm font-medium text-fg-subtle">{t('cast')}</h2>
      <ul
        ref={fades.ref}
        style={fades.style}
        aria-labelledby={headingId}
        tabIndex={focusableRow ? 0 : undefined}
        data-testid="vod-cast-row"
        className="-ms-1 -me-(--page-gutter) flex gap-2 overflow-x-auto rounded-md ps-1 pe-(--page-gutter) pb-2 scrollbar-none outline-none focus-visible:ring-2 focus-visible:ring-focus"
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
              {linked(p) ? (
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
