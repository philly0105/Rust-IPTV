import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { Person } from '@/api/types';

import { handleGridKeyDown } from '../../lib/gridNav';
import { cn } from '../../_shim';

const MAX_CAST = 16;

/** Cast chips; people with a TMDB id link to their actor page. */
export function CastRow({ cast, sourceId }: { cast: Person[]; sourceId: string }) {
  const { t } = useTranslation('vod');
  const people = cast.slice(0, MAX_CAST);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h2 className="text-sm font-medium text-fg-subtle">{t('cast')}</h2>
      <ul
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2"
        onKeyDown={(e) => handleGridKeyDown(e, { orientation: 'horizontal', count: people.length })}
      >
        {people.map((p, i) => {
          const body = (
            <>
              <Avatar person={p} />
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-[13px] font-medium text-fg">{p.name}</span>
                {p.role && <span className="truncate text-xs text-fg-subtle">{p.role}</span>}
              </span>
            </>
          );
          const cls = 'flex max-w-56 shrink-0 items-center gap-2 rounded-full border border-border bg-surface/70 py-1 pr-4 pl-1';
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

function Avatar({ person }: { person: Person }) {
  const initials = person.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return person.profileUrl ? (
    <img src={person.profileUrl} alt="" loading="lazy" className="h-8 w-8 shrink-0 rounded-full object-cover" />
  ) : (
    <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-fg-muted">
      {initials}
    </span>
  );
}
