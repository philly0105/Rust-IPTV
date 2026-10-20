import { ChevronDown, ListFilter } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';

import { Badge, Button } from '@/ui';

/**
 * The Sources toolbar's sort and filters behind one small button on wider windows (a phone opens
 * the same selects in a bottom sheet). Three bordered selects, each as wide as its longest option,
 * were the heaviest chrome on the page, above a list of a few cards.
 *
 * The button names the current sort and counts the choices that differ from the default; it opens
 * a panel under it with the labelled selects. The panel is not modal and sits right after the
 * button in the DOM, so Tab goes on through it to the toolbar's other buttons. Escape closes it and
 * gives focus back to the button; a press outside it, or focus moving elsewhere, closes it too.
 */
export function ViewPopover({
  label,
  summary,
  count,
  countLabel,
  children,
}: {
  /** The panel's name, and the start of the button's (the button shows `summary`). */
  label: string;
  /** What the button shows: the current sort. */
  summary: string;
  /** Choices that differ from the default; a badge from 1. */
  count: number;
  /** `count`, formatted. */
  countLabel: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    // Straight to the first choice, as a menu does.
    panelRef.current?.querySelector<HTMLElement>('select, input, button')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !open) return;
    // Ours alone: the page's shortcuts and any dialog behind do not see it.
    e.preventDefault();
    e.stopPropagation();
    close(true);
  };

  // Focus that moves past the panel (Tab off its last select) closes it. A press on the panel's own
  // padding focuses the panel (tabIndex -1), so it stays open.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (open && next instanceof Node && !rootRef.current?.contains(next)) setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown} onBlur={onBlur} data-testid="sources-view">
      <Button
        ref={triggerRef}
        variant="secondary"
        size="sm"
        icon={<ListFilter aria-hidden className="size-4" />}
        iconRight={<ChevronDown aria-hidden className="size-3.5 text-fg-muted" />}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
        data-testid="sources-view-trigger"
      >
        <span className="sr-only">{label}, </span>
        {summary}
        {count > 0 ? <Badge data-testid="sources-view-count">{countLabel}</Badge> : null}
      </Button>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          className="absolute top-full start-0 z-30 mt-1.5 flex w-72 flex-col gap-4 rounded-lg border border-edge bg-surface p-4 shadow-2 outline-none motion-safe:animate-pop-in"
          data-testid="sources-view-panel"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
