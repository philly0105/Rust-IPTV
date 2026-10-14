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
 * The icon variant must sit beside a poster link, not inside it: a button
 * inside a link or a listbox option is a nested interactive control.
 */

import { BookmarkCheck, BookmarkPlus } from 'lucide-react';
import { useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { itemKey, type ItemRef, type ItemSnapshot } from '@/api/types';

import { Button, cn } from '../deps';
import { useMyListKeys } from '../hooks/useMyList';
import { useMyListToggle } from '../hooks/useMyListToggle';
import { canSave } from '../lib/list';

export interface MyListButtonProps {
  itemRef: ItemRef;
  snapshot: ItemSnapshot;
  variant?: 'icon' | 'button';
  /** Height of the `button` variant, matching the detail page's other actions. Default `lg`. */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function MyListButton({ itemRef, snapshot, variant = 'button', size = 'lg', className }: MyListButtonProps) {
  const { t } = useTranslation('mylist');
  const keys = useMyListKeys();
  const toggle = useMyListToggle();
  const [pending, setPending] = useState(false);
  if (!canSave(itemRef)) return null;

  const inList = keys.has(itemKey(itemRef));
  const title = snapshot.title;

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    // The icon variant sits over a poster link: the click is ours alone.
    e.preventDefault();
    e.stopPropagation();
    if (pending) return;
    setPending(true);
    void toggle(itemRef, snapshot).finally(() => setPending(false));
  };

  const hint = inList ? t('removeHint') : t('addHint');
  const Icon = inList ? BookmarkCheck : BookmarkPlus;

  if (variant === 'icon') {
    return (
      <button
        type="button"
        aria-label={t('toggleLabel', { title })}
        aria-pressed={inList}
        aria-busy={pending || undefined}
        title={hint}
        onClick={onClick}
        data-testid="mylist-button"
        data-variant="icon"
        data-in-list={inList || undefined}
        className={cn(
          'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border shadow-1',
          'focus-visible:outline-2 focus-visible:outline-offset-2',
          'motion-safe:transition-[background-color,color,transform] motion-safe:duration-150 motion-safe:active:scale-95',
          inList
            ? 'border-transparent bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-pressed'
            : 'border-glass-border bg-glass text-on-glass backdrop-blur-glass hover:bg-glass-strong',
          pending && 'cursor-progress',
          className,
        )}
      >
        <Icon aria-hidden size={17} strokeWidth={2.25} />
      </button>
    );
  }

  return (
    <Button
      size={size}
      variant="secondary"
      icon={<Icon aria-hidden size={size === 'sm' ? 16 : 18} className={cn(inList && 'text-accent')} />}
      aria-pressed={inList}
      aria-busy={pending || undefined}
      title={hint}
      onClick={onClick}
      data-testid="mylist-button"
      data-variant="button"
      data-in-list={inList || undefined}
      className={cn(inList && 'border-accent/70', pending && 'cursor-progress', className)}
    >
      {t('buttonLabel')}
    </Button>
  );
}
