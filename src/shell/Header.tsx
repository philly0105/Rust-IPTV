import { ListTree, Moon, PanelLeftOpen, Search, Sun, TextSearch } from 'lucide-react';
import { memo, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { BackButton, IconButton, Kbd, SearchInput, cn } from '@/ui';

import { useShellStore, type HeaderState } from './store';
import { useTheme } from './theme';

/**
 * The header's search slot (SH-header-search): one box on every page, so the field neither
 * moves nor resizes between Home, a source's Movies and the search page. A page that searches
 * its own content puts its field here; otherwise the slot is the trigger that opens the command
 * palette. Both wear the same fill, control border and trailing key hint (Ctrl K for the palette,
 * Ctrl F for the page's field), so the slot reads as one object. In rem, so it follows the UI
 * scale. 15rem at the least: "Search everything" and its Ctrl K hint fit whole in it, which at
 * 14rem they did not on a 900 px window.
 */
export const HEADER_SEARCH_WIDTH = 'w-[clamp(15rem,24vw,22rem)]';
/** The same width for a page's own field, from sm up (below sm it folds into an icon). Literal, for Tailwind's scanner. */
export const HEADER_FIELD_WIDTH = 'sm:w-[clamp(15rem,24vw,22rem)]';

/**
 * `phone`: below sm, where the tab bar
 * carries navigation and Search, so the header keeps only the page's title and actions.
 * `railHidden`: the user hid the rail on a narrow window; the header leads with the button
 * that shows it. Memoized (performance audit SH-1): the shell's own re-renders pass it by.
 */
export const Header = memo(function Header({
  panelInline,
  railHidden = false,
  phone = false,
}: {
  panelInline: boolean;
  railHidden?: boolean;
  phone?: boolean;
}) {
  const { t } = useTranslation('shell');
  const toggleRailHidden = useShellStore((s) => s.toggleRailHidden);
  const header = useShellStore((s) => s.header);
  const hasPanel = useShellStore((s) => s.contextPanel !== null);
  const panelOpen = useShellStore((s) => s.panelOpen);
  const setPanelOpen = useShellStore((s) => s.setPanelOpen);
  const setPaletteOpen = useShellStore((s) => s.setPaletteOpen);
  const titleScrolledAway = useShellStore((s) => s.titleScrolledAway);
  const { resolved, toggle } = useTheme();
  const windowTitle = header?.documentTitle || header?.title;
  // A detail page names its section until its own large title scrolls away, then the title.
  const showSection = !!header?.section && !titleScrolledAway;
  // On a phone a detail page's header is Back alone while its h1 is on screen: a title-sized
  // section line beside it outranked the page's own title. (Back does not take the section's name
  // either: it goes back in history, which is often Home, Search or another title.) The title
  // still comes in once the h1 has scrolled away.
  const shownTitle = showSection ? (phone && header?.back ? undefined : header?.section) : header?.title;
  const appName = t('appName');

  const searchField = header?.search ? <HeaderField search={header.search} phone={phone} /> : null;

  // The window/tab title follows the page title, or the window title the page set (documentTitle).
  useEffect(() => {
    document.title = windowTitle ? `${windowTitle} · ${appName}` : appName;
  }, [windowTitle, appName]);

  return (
    <header
      data-testid="shell-header"
      // The page gutter (tokens.css), shared with ui Page, so the title and page content start on one line.
      className="group/header flex h-(--header-height) shrink-0 items-center gap-3 border-b border-divider bg-bg/95 px-(--page-gutter) sm:gap-4"
    >
      {railHidden && (
        <IconButton
          label={t('showRail')}
          icon={<PanelLeftOpen size={18} className="rtl:-scale-x-100" />}
          onClick={() => {
            // This button goes as the rail comes back: focus moves on to the rail's Hide button.
            flushSync(toggleRailHidden);
            document.querySelector<HTMLElement>('[data-rail-hide]')?.focus();
          }}
          className="-ms-2 shrink-0"
          data-testid="rail-show"
        />
      )}
      {header?.back && (
        // -ms-2: the arrow, not the button's padding, sits on the page gutter, as the content's edge does.
        <BackButton onClick={header.back.onClick} label={header.back.label} className="-ms-2 shrink-0" data-testid="header-back" />
      )}
      {/* Below sm the title gives way to the page search while it is in use (focused or holding a query). */}
      <div
        className={cn(
          'flex min-w-0 flex-1 items-baseline gap-3',
          // The title keeps a few letters' room however wide the page's header actions are.
          header?.title && 'min-w-[min(8ch,30%)]',
          'max-sm:group-has-[[data-shell-search]:focus]/header:hidden max-sm:group-has-[[data-shell-search]:not(:placeholder-shown)]/header:hidden',
        )}
      >
        {shownTitle ? (
          <>
            {/*
              Not a heading: each page owns its single <h1> (C16), so the
              header title stays a styled paragraph to avoid two h1s. A long
              title truncates; hovering it shows the whole name. Keyed by what
              it shows, so a detail page's title fades in as its h1 scrolls away
              (and the section fades back as it returns).
            */}
            <p
              key={header?.section ? (showSection ? 'section' : 'title') : 'title'}
              dir="auto"
              title={shownTitle}
              className={cn('truncate text-title', header?.section && 'motion-safe:animate-fade-in')}
              data-testid="page-title"
            >
              {shownTitle}
            </p>
            {/*
              The subtitle only takes the room the title leaves (flex-basis 0), so it truncates
              first and the title keeps its whole name for as long as it fits.
            */}
            {header?.subtitle && (
              <p dir="auto" title={header.subtitle} className="hidden min-w-0 flex-1 basis-0 truncate text-sm text-fg-muted md:block" data-testid="page-subtitle">
                {header.subtitle}
              </p>
            )}
          </>
        ) : (
          <span aria-hidden />
        )}
      </div>

      {/*
        Page actions and the context-panel toggle come before the search slot, so the slot and
        the theme button keep one place at the inline end on every page. Page actions give way
        before the shell's own controls: on a phone (worst in Arabic) a labelled action used to
        push them off the screen. The wrapper shrinks and clips sideways only; the clip margin
        keeps the actions' focus rings.
      */}
      {header?.actions && (
        <div data-testid="header-actions" className="flex min-w-0 items-center gap-2 overflow-x-clip [overflow-clip-margin:0.25rem]">
          {header.actions}
        </div>
      )}
      {hasPanel && !panelInline && (
        <IconButton
          label={panelOpen ? t('hideDetails') : t('showDetails')}
          icon={<ListTree size={18} className="rtl:-scale-x-100" />}
          aria-expanded={panelOpen}
          aria-haspopup="dialog"
          onClick={() => setPanelOpen(!panelOpen)}
          className="shrink-0"
          data-testid="panel-toggle"
        />
      )}

      {phone && searchField}

      {!phone && (
        <div className="flex shrink-0 items-center gap-1">
          {searchField && (
            // The page's field takes the trigger's place; the palette keeps a small button before
            // it, so the slot itself stays put (the same box and edges as on every other page).
            // It stands in for "Search everything", which the rail no longer repeats, so it carries
            // that name and a search glyph unlike the field's magnifier; Ctrl+F focuses the field.
            <IconButton
              label={t('searchEverything')}
              shortcut="mod+k"
              icon={<TextSearch size={18} />}
              aria-haspopup="dialog"
              onClick={() => setPaletteOpen(true)}
              data-testid="header-palette"
            />
          )}
          {searchField ? (
            <div className="group/search relative me-1 flex">
              {searchField}
              <Kbd
                combo="mod+f"
                size="sm"
                className="pointer-events-none absolute end-1.5 top-1/2 -translate-y-1/2 pointer-coarse:hidden group-has-[input:focus]/search:hidden group-has-[input:not(:placeholder-shown)]/search:hidden"
              />
            </div>
          ) : (
            <button
              type="button"
              // One way in: the palette searches favourites, history, the guide and commands, and
              // hands anything else to the search page. Ctrl+F still opens the search page.
              onClick={() => setPaletteOpen(true)}
              aria-haspopup="dialog"
              data-tour="search"
              data-testid="open-palette"
              className={cn(
                HEADER_SEARCH_WIDTH,
                // Looks like the page's field (its fill and control border) but opens the palette.
                'me-1 flex h-8 items-center gap-2 rounded-md border border-border bg-surface-2 ps-3 pe-1.5 text-sm text-fg-subtle',
                'hover:border-fg-subtle hover:text-fg-muted active:bg-surface-3 motion-safe:transition-colors',
              )}
            >
              <Search aria-hidden size={16} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-start">{t('searchEverything')}</span>
              <Kbd combo="mod+k" size="sm" className="pointer-coarse:hidden" />
            </button>
          )}
          <IconButton
            label={resolved === 'dark' ? t('switchToLight') : t('switchToDark')}
            shortcut="mod+shift+l"
            icon={resolved === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            onClick={toggle}
            data-testid="theme-toggle"
          />
        </div>
      )}
    </header>
  );
});

/** The page's own search field in the header slot (header.search). */
function HeaderField({ search, phone }: { search: NonNullable<HeaderState['search']>; phone: boolean }) {
  return (
    <SearchInput
      className={cn(
        HEADER_FIELD_WIDTH,
        // The palette trigger's fill, under the field's own control border.
        '[&>input]:bg-surface-2',
        // Room for the Ctrl F hint while the field rests empty; a long placeholder ("Search
        // Northwind Premium") ends in an ellipsis before the hint instead of a cut letter.
        !phone && '[&>input:placeholder-shown:not(:focus)]:pe-16 [&>input]:text-ellipsis',
        /*
          Below sm a fixed-width field would squeeze the page title to its first
          letter, so the search folds into a search-icon button: the same input,
          only narrow and borderless, so a click, Tab or Ctrl+F still lands in it.
          Focused or holding a query, it unfolds over the title's space.
        */
        'max-sm:w-8 max-sm:min-w-0 max-sm:shrink-0',
        'max-sm:focus-within:flex-1 max-sm:has-[input:not(:placeholder-shown)]:flex-1',
        'max-sm:[&:not(:focus-within):has(input:placeholder-shown)>svg]:start-[calc(50%-8px)]',
        'max-sm:[&:not(:focus-within)>input:placeholder-shown]:cursor-pointer max-sm:[&:not(:focus-within)>input:placeholder-shown]:border-transparent max-sm:[&:not(:focus-within)>input:placeholder-shown]:bg-transparent',
        'max-sm:[&:not(:focus-within)>input:placeholder-shown:hover]:bg-surface-2 max-sm:[&:not(:focus-within)>input::placeholder]:text-transparent',
      )}
      size="sm"
      value={search.value}
      onChange={search.onChange}
      onSubmit={search.onSubmit}
      onKeyDown={search.onKeyDown}
      placeholder={search.placeholder}
      data-shell-search=""
      // On a phone the tab bar's Search tab is the tour's search step.
      data-tour={phone ? undefined : 'search'}
    />
  );
}
