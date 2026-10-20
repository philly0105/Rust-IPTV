import { ArrowLeft, ChevronRight } from 'lucide-react';
import type { ComponentPropsWithRef, MouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { buttonClass } from './Button';
import { cn } from './cn';
import { GLASS_FOCUS } from './focus';

/**
 * Page widths (DS-PAGE-FRAME), in rem against the 15 px root so they follow the UI scale:
 *   narrow   56rem  (840 px)  settings, forms, a single column of rows
 *   default  80rem (1200 px)  lists, stats, archive, scheduled
 *   wide    120rem (1800 px)  poster grids and rails
 *   full     no cap           the guide, the player, anything that scrolls sideways
 */
export type PageWidth = 'narrow' | 'default' | 'wide' | 'full';

const PAGE_WIDTHS: Record<PageWidth, string> = {
  narrow: 'max-w-[56rem]',
  default: 'max-w-[80rem]',
  wide: 'max-w-[120rem]',
  full: 'max-w-none',
};

export interface PageProps extends ComponentPropsWithRef<'div'> {
  width?: PageWidth;
  /** Element to render; `main` is the shell's, so a page is a div or a section. */
  as?: 'div' | 'section';
}

/**
 * The page container: side padding from --page-gutter (1rem on phones, 1.5rem from sm, 2rem
 * from lg; tokens.css), which the shell header uses too, so page content starts on the same
 * line as the header title. Content starts at the gutter and stops at the width's cap; it is
 * not centred, or it would leave that line on wide windows. Vertical padding is py-6; pass
 * classes to change it or to lay out children (`flex flex-col gap-8`).
 */
export function Page({ width = 'default', as: Tag = 'div', className, ...rest }: PageProps) {
  return <Tag data-page={width} className={cn('w-full px-(--page-gutter) py-6', PAGE_WIDTHS[width], className)} {...rest} />;
}

export interface PageHeaderProps {
  title: ReactNode;
  /** One line under the title. */
  subtitle?: ReactNode;
  /** A number after the title, in the muted tone ("Movies 1,204"). Format it first. */
  count?: ReactNode;
  /** Buttons on the inline end; they wrap under the title on narrow screens. */
  actions?: ReactNode;
  /** Heading level. Default h1: a page has one. */
  as?: 'h1' | 'h2';
  id?: string;
  className?: string;
}

/**
 * An in-page title row: heading (text-title), optional count and subtitle, and an actions slot.
 * Most pages put their title in the shell header with usePageHeader and keep a visually hidden
 * h1; PageHeader is for pages whose title belongs in the content (a detail page body, a page
 * the header leaves untitled).
 */
export function PageHeader({ title, subtitle, count, actions, as: Heading = 'h1', id, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-3', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <Heading id={id} dir="auto" className="flex min-w-0 items-baseline gap-2 text-title text-fg">
          <span className="min-w-0 break-words">{title}</span>
          {count !== undefined && count !== null && <span className="shrink-0 text-body font-normal text-fg-subtle tabular">{count}</span>}
        </Heading>
        {subtitle ? <p className="text-body-sm text-fg-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export interface SectionHeaderProps {
  title: ReactNode;
  /** A number after the title, muted. */
  count?: ReactNode;
  /** Where "See all" goes; the link text defaults to "See all". */
  seeAll?: { to: string; label?: ReactNode };
  /** Controls on the inline end, before See all (rail arrows, a sort menu). */
  action?: ReactNode;
  /** Heading level. Default h2. */
  as?: 'h2' | 'h3';
  id?: string;
  className?: string;
}

/**
 * The heading row of a section or rail: an h2 in text-title-sm with an optional count, and on
 * the inline end any controls and a "See all" link with a chevron.
 */
export function SectionHeader({ title, count, seeAll, action, as: Heading = 'h2', id, className }: SectionHeaderProps) {
  const { t } = useTranslation('common');
  return (
    <div className={cn('flex min-h-8 items-center justify-between gap-4', className)}>
      <Heading id={id} dir="auto" className="flex min-w-0 items-baseline gap-2 text-title-sm text-fg">
        <span className="truncate">{title}</span>
        {count !== undefined && count !== null && <span className="shrink-0 text-body-sm font-normal text-fg-subtle tabular">{count}</span>}
      </Heading>
      {(action || seeAll) && (
        <div className="flex shrink-0 items-center gap-2">
          {action}
          {seeAll && (
            <Link
              to={seeAll.to}
              className="inline-flex items-center gap-0.5 rounded-sm text-sm font-medium text-fg-muted hover:text-fg active:text-accent-pressed motion-safe:transition-colors"
            >
              {seeAll.label ?? t('seeAll')}
              <ChevronRight aria-hidden size={16} className="rtl:rotate-180" />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

export interface BackButtonProps {
  /** Link target. Without it the button only calls `onClick`. */
  to?: string;
  /**
   * Runs on activation. With `to` as well, the link's own navigation is cancelled, so the page
   * can go back in history while the link still shows where back is (and opens in a new tab).
   */
  onClick?: () => void;
  /** Defaults to "Back". Name the destination when it helps ("Movies", "My Videos"). */
  label?: ReactNode;
  /** `glass` over artwork or video (a detail hero); the shape stays the same. */
  tone?: 'default' | 'glass';
  className?: string;
  'data-testid'?: string;
}

/** The back control: a small ghost button with a leading arrow (mirrored in RTL). */
export function BackButton({ to, onClick, label, tone = 'default', className, ...rest }: BackButtonProps) {
  const { t } = useTranslation('common');
  const cls = buttonClass(
    'ghost',
    'sm',
    cn(
      'gap-1.5 ps-2',
      tone === 'glass' && cn('border border-glass-border bg-glass text-on-glass shadow-1 glass-blur hover:bg-glass-strong hover:text-on-glass active:bg-glass-strong', GLASS_FOCUS),
      className,
    ),
  );
  const content = (
    <>
      <ArrowLeft aria-hidden size={16} className="rtl:rotate-180" />
      {label ?? t('back')}
    </>
  );
  if (to) {
    const click = onClick
      ? (e: MouseEvent<HTMLAnchorElement>) => {
          // Modified clicks (new tab, new window) keep the link's own behaviour.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          onClick();
        }
      : undefined;
    return (
      <Link to={to} className={cls} onClick={click} {...rest}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" className={cls} onClick={onClick} {...rest}>
      {content}
    </button>
  );
}
