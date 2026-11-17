import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { buttonClass, cn } from '@/ui';

/** The Search page for `query` across every source. */
export function searchEverythingHref(query: string): string {
  return `/search?q=${encodeURIComponent(query.trim())}`;
}

/**
 * The way out of a search scoped to one page that found nothing: "Search everything for “q”", a
 * secondary button that opens the Search page on the same text. Every scoped search's empty state
 * (a source's search, Live TV's channel search, a category, the guide, Sports) can offer it, so no
 * empty result is a dead end.
 */
export function SearchEverythingLink({ query, size = 'md', className }: { query: string; size?: 'sm' | 'md'; className?: string }) {
  const { t } = useTranslation('shell');
  return (
    <Link to={searchEverythingHref(query)} className={buttonClass('secondary', size, cn('max-w-full', className))} data-testid="search-everything-for">
      <Search aria-hidden size={size === 'sm' ? 14 : 16} className="shrink-0" />
      <span dir="auto" className="min-w-0 truncate">
        {t('searchEverythingFor', { query: query.trim() })}
      </span>
    </Link>
  );
}
