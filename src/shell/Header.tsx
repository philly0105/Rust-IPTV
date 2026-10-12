import { Moon, PanelRight, Search, SquareChevronRight, Sun } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { IconButton, Kbd, SearchInput, cn } from '@/ui';

import { useShellStore } from './store';
import { useTheme } from './theme';

export function Header({ panelInline }: { panelInline: boolean }) {
  const { t } = useTranslation('shell');
  const header = useShellStore((s) => s.header);
  const hasPanel = useShellStore((s) => s.contextPanel !== null);
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
      className="flex h-(--header-height) shrink-0 items-center gap-4 border-b border-divider bg-bg/90 px-5 backdrop-blur"
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        {header?.title ? (
          <>
            {/*
              Not a heading: each page owns its single <h1> (C16), so the
              header title stays a styled paragraph to avoid two h1s.
            */}
            <p dir="auto" className="truncate font-display text-xl font-semibold" data-testid="page-title">
              {header.title}
            </p>
            {header.subtitle && <p dir="auto" className="hidden truncate text-sm text-fg-muted md:block">{header.subtitle}</p>}
          </>
        ) : (
          <span aria-hidden />
        )}
      </div>

      {header?.search ? (
        <SearchInput
          className="w-[clamp(180px,28vw,380px)]"
          size="sm"
          value={header.search.value}
          onChange={header.search.onChange}
          onSubmit={header.search.onSubmit}
          placeholder={header.search.placeholder}
          data-shell-search=""
        />
      ) : (
        <button
          type="button"
          onClick={() => navigate('/search')}
          className={cn(
            'hidden h-8 w-[clamp(160px,22vw,300px)] items-center gap-2 rounded-md border border-border bg-surface px-3 text-sm text-fg-subtle lg:flex',
            'hover:border-fg-subtle hover:text-fg-muted active:bg-surface-2',
          )}
        >
          <Search aria-hidden size={15} />
          <span className="flex-1 truncate text-start">{t('searchEverything')}</span>
          <Kbd combo="mod+f" />
        </button>
      )}

      {header?.actions && <div className="flex shrink-0 items-center gap-2">{header.actions}</div>}

      <div className="flex shrink-0 items-center gap-1">
        {hasPanel && !panelInline && (
          <IconButton
            label={panelOpen ? t('hideDetails') : t('showDetails')}
            icon={<PanelRight size={18} className="rtl:-scale-x-100" />}
            aria-expanded={panelOpen}
            aria-haspopup="dialog"
            onClick={() => setPanelOpen(!panelOpen)}
            data-testid="panel-toggle"
          />
        )}
        <IconButton
          label={t('openPalette')}
          title={`${t('openPalette')} (Ctrl+K)`}
          // A command-prompt glyph, not the Mac ⌘ key: this is a Windows app and the shortcut is Ctrl+K.
          icon={<SquareChevronRight size={18} className="rtl:-scale-x-100" />}
          onClick={() => setPaletteOpen(true)}
          data-testid="open-palette"
        />
        <IconButton
          label={resolved === 'dark' ? t('switchToLight') : t('switchToDark')}
          title={`${resolved === 'dark' ? t('switchToLight') : t('switchToDark')} (Ctrl+Shift+L)`}
          icon={resolved === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          onClick={toggle}
          data-testid="theme-toggle"
        />
      </div>
    </header>
  );
}
