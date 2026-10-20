import { ListTree, Moon, PanelLeftOpen, Search, SquareChevronRight, Sun } from 'lucide-react';
import { memo, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { IconButton, Kbd, SearchInput, cn, comboKeys } from '@/ui';

import { openSearch } from './focusSearch';
import { useShellStore } from './store';
import { useTheme } from './theme';

/**
 * `narrow`: below lg, where the rail is auto-collapsed. The tour's search anchor (Run 3 C7) then
 * moves to the rail's Search link, since the "Search everything" button folds away there.
 * `railHidden`: the user hid the rail there; the header leads with the button that shows it.
 * Memoized (performance audit SH-1): the shell's own re-renders pass it by.
 */
export const Header = memo(function Header({ panelInline, narrow = false, railHidden = false }: { panelInline: boolean; narrow?: boolean; railHidden?: boolean }) {
  const { t } = useTranslation('shell');
  const toggleRailHidden = useShellStore((s) => s.toggleRailHidden);
  const header = useShellStore((s) => s.header);
  const hasPanel = useShellStore((s) => s.contextPanel !== null && s.panelDrawer);
  const panelOpen = useShellStore((s) => s.panelOpen);
  const setPanelOpen = useShellStore((s) => s.setPanelOpen);
  const setPaletteOpen = useShellStore((s) => s.setPaletteOpen);
  const { resolved, toggle } = useTheme();
  const navigate = useNavigate();
  const title = header?.title;
  const appName = t('appName');

  // The window/tab title follows the page title.
  useEffect(() => {
    document.title = title ? `${title} · ${appName}` : appName;
  }, [title, appName]);

  return (
    <header
      data-testid="shell-header"
      className="group/header flex h-(--header-height) shrink-0 items-center gap-3 border-b border-divider bg-bg/95 px-4 sm:gap-4 sm:px-5"
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
      {/* Below sm the title gives way to the page search while it is in use (focused or holding a query). */}
      <div
        className={cn(
          'flex min-w-0 flex-1 items-baseline gap-3',
          // The title keeps a few letters' room however wide the page's header actions are.
          header?.title && 'min-w-[min(8ch,30%)]',
          'max-sm:group-has-[[data-shell-search]:focus]/header:hidden max-sm:group-has-[[data-shell-search]:not(:placeholder-shown)]/header:hidden',
        )}
      >
        {header?.title ? (
          <>
            {/*
              Not a heading: each page owns its single <h1> (C16), so the
              header title stays a styled paragraph to avoid two h1s. A long
              title truncates; hovering it shows the whole name.
            */}
            <p dir="auto" title={header.title} className="truncate text-title" data-testid="page-title">
              {header.title}
            </p>
            {/*
              The subtitle only takes the room the title leaves (flex-basis 0), so it truncates
              first and the title keeps its whole name for as long as it fits.
            */}
            {header.subtitle && (
              <p dir="auto" title={header.subtitle} className="hidden min-w-0 flex-1 basis-0 truncate text-sm text-fg-muted md:block" data-testid="page-subtitle">
                {header.subtitle}
              </p>
            )}
          </>
        ) : (
          <span aria-hidden />
        )}
      </div>

      {header?.search ? (
        <SearchInput
          className={cn(
            'sm:w-[clamp(12rem,28vw,25rem)]',
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
          value={header.search.value}
          onChange={header.search.onChange}
          onSubmit={header.search.onSubmit}
          onKeyDown={header.search.onKeyDown}
          placeholder={header.search.placeholder}
          data-shell-search=""
          data-tour={narrow ? undefined : 'search'}
        />
      ) : (
        <button
          type="button"
          // Lands in the search field, as Ctrl+F does, so the user can type at once.
          onClick={() => openSearch(navigate)}
          data-tour={narrow ? undefined : 'search'}
          className={cn(
            // Looks like a field but opens the palette: a quiet edge that firms up to the field border on hover.
            'hidden h-8 w-[clamp(10rem,22vw,20rem)] items-center gap-2 rounded-md border border-edge bg-surface-2 px-3 text-sm text-fg-subtle lg:flex',
            'hover:border-border hover:text-fg-muted active:bg-surface-3 motion-safe:transition-colors',
          )}
        >
          <Search aria-hidden size={15} />
          <span className="flex-1 truncate text-start">{t('searchEverything')}</span>
          <Kbd combo="mod+f" />
        </button>
      )}

      {/*
        Page actions give way before the shell's own buttons: on a phone (worst in Arabic) a
        labelled action used to push the palette and theme buttons off the screen. The wrapper
        shrinks and clips sideways only; the clip margin keeps the actions' focus rings.
      */}
      {header?.actions && (
        <div data-testid="header-actions" className="flex min-w-0 items-center gap-2 overflow-x-clip [overflow-clip-margin:0.25rem]">
          {header.actions}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-1">
        {hasPanel && !panelInline && (
          <IconButton
            label={panelOpen ? t('hideDetails') : t('showDetails')}
            // A list glyph, so it never reads as the palette's square-and-chevron next to it.
            icon={<ListTree size={18} className="rtl:-scale-x-100" />}
            aria-expanded={panelOpen}
            aria-haspopup="dialog"
            onClick={() => setPanelOpen(!panelOpen)}
            data-testid="panel-toggle"
          />
        )}
        <IconButton
          label={t('openPalette')}
          title={`${t('openPalette')} (${comboKeys('mod+k').join('+')})`}
          // A command-prompt glyph, not the Mac ⌘ key: the shortcut is Ctrl+K outside macOS.
          icon={<SquareChevronRight size={18} className="rtl:-scale-x-100" />}
          onClick={() => setPaletteOpen(true)}
          data-testid="open-palette"
        />
        <IconButton
          label={resolved === 'dark' ? t('switchToLight') : t('switchToDark')}
          title={`${resolved === 'dark' ? t('switchToLight') : t('switchToDark')} (${comboKeys('mod+shift+l').join('+')})`}
          icon={resolved === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          onClick={toggle}
          data-testid="theme-toggle"
        />
      </div>
    </header>
  );
});
