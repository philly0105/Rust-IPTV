/**
 * Adds a movie or series to My List, or takes it off (contract C3).
 *
 * `button` (default) is the labelled detail-page button; `icon` is the round
 * frosted overlay for a poster corner. Both are toggle buttons: the
 * accessible name stays the same and `aria-pressed` carries the state, while
 * the bookmark glyph fills in with the accent once the title is saved. The
 * work (optimistic patch, toasts, Undo) lives in `useMyListToggle`. Live and
 * radio refs render nothing.
 *
 * The state comes from the shared list, so until that list has loaded the
 * button cannot know it: it shows a plain bookmark, busy and disabled, with no
 * `aria-pressed` (a toggle from an unknown state would take a saved title off
 * the list). When the list could not be read it offers to read it again
 * instead of toggling.
 *
 * The icon variant must sit beside a poster link, not inside it: a button
 * inside a link or a listbox option is a nested interactive control.
 */

import { Bookmark, BookmarkCheck, BookmarkPlus, RefreshCw } from 'lucide-react';
import { useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { itemKey, type ItemRef, type ItemSnapshot } from '@/api/types';

import { Button, cn } from '../deps';
import { useMyListState } from '../hooks/useMyList';
import { useMyListToggle } from '../hooks/useMyListToggle';
import { canSave } from '../lib/list';

export interface MyListButtonProps {
  itemRef: ItemRef;
  snapshot: ItemSnapshot;
  variant?: 'icon' | 'button';
  /** Height of the `button` variant, matching the detail page's other actions. Default `lg`. */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  /** For a host with roving focus (a dashboard rail is one Tab stop): -1 keeps the toggle out of the Tab order. */
  tabIndex?: number;
}

export function MyListButton({ itemRef, snapshot, variant = 'button', size = 'lg', className, tabIndex }: MyListButtonProps) {
  const { t } = useTranslation('mylist');
  const { keys, status, retry } = useMyListState();
  const toggle = useMyListToggle();
  const [pending, setPending] = useState(false);
  if (!canSave(itemRef)) return null;

  const ready = status === 'ready';
  const loading = status === 'loading';
  const inList = ready && keys.has(itemKey(itemRef));
  const title = snapshot.title;

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    // The icon variant sits over a poster link: the click is ours alone.
    e.preventDefault();
    e.stopPropagation();
    if (pending || loading) return;
    setPending(true);
    const work = ready ? toggle(itemRef, snapshot) : retry();
    void work.finally(() => setPending(false));
  };

  const hint = loading ? t('checkingHint') : !ready ? t('retryHint') : inList ? t('removeHint') : t('addHint');
  const Icon = loading ? Bookmark : !ready ? RefreshCw : inList ? BookmarkCheck : BookmarkPlus;
  // Pressed or not only once the state is known.
  const pressed = ready ? inList : undefined;
  const busy = pending || loading || undefined;

  if (variant === 'icon') {
    return (
      <button
        type="button"
        aria-label={t('toggleLabel', { title })}
        aria-pressed={pressed}
        aria-busy={busy}
        // aria-disabled, not disabled: focus stays put while the list loads.
        aria-disabled={loading || undefined}
        title={hint}
        tabIndex={tabIndex}
        onClick={onClick}
        data-testid="mylist-button"
        data-variant="icon"
        data-state={status}
        data-in-list={inList || undefined}
        className={cn(
          'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border shadow-1',
          'focus-visible:outline-2 focus-visible:outline-offset-2',
          'motion-safe:transition-[background-color,color,transform] motion-safe:duration-150 motion-safe:active:scale-95',
          // C5: blur only while the corner is up on one card (its `group/poster` hovered, or the
          // button focused). Without hover it shows on every card at once, so it is opaque there.
          inList
            ? 'border-transparent bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-pressed'
            : cn(
                'border-glass-border bg-glass text-on-glass hover:bg-glass-strong',
                'group-hover/poster:glass-blur focus-visible:glass-blur [@media(hover:none)]:bg-glass-strong',
              ),
          (pending || loading) && 'cursor-progress',
          loading && 'opacity-70',
          className,
        )}
      >
        <Icon aria-hidden size={17} strokeWidth={2.25} className={cn(loading && 'motion-safe:animate-pulse')} />
      </button>
    );
  }

  return (
    <Button
      size={size}
      variant="secondary"
      icon={<Icon aria-hidden size={size === 'sm' ? 16 : 18} className={cn(inList && 'text-accent')} />}
      // Spinner in place of the glyph, aria-disabled and aria-busy while the list loads.
      loading={loading}
      aria-pressed={pressed}
      aria-busy={busy}
      title={hint}
      tabIndex={tabIndex}
      onClick={onClick}
      data-testid="mylist-button"
      data-variant="button"
      data-state={status}
      data-in-list={inList || undefined}
      className={cn(inList && 'border-accent/70', (pending || loading) && 'cursor-progress', className)}
    >
      {t('buttonLabel')}
    </Button>
  );
}
