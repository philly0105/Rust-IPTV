import { DatabaseBackup } from 'lucide-react';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { holdImportToasts } from '@/shell/effects';
import { sourceHomePath } from '@/shell/railLinks';
import { Button, EmptyState, buttonClass, cn } from '@/ui';

// The add flow (forms, import progress) loads on the press, not with the page's chunk.
const AddSourceDialog = lazy(() => import('./AddSourceDialog').then((m) => ({ default: m.AddSourceDialog })));

export interface NoSourcesActionsProps {
  /** Test id of the Add button; pages keep the ids their tests already use. */
  testId?: string;
  /**
   * Stay on this page once the first source is added (the guide, Multi-view and Sports fill in
   * with it). Otherwise the new source opens on its channels, as it does from Home's welcome: a
   * list page such as Favorites would only trade one empty state for another.
   */
  stay?: boolean;
}

/**
 * The actions every page offers while there is no source: Add a source, which opens the add
 * dialog right here (so cancelling leaves the user where they were, and the success toast still
 * offers Open), and Import a backup for someone moving from another install. They used to be a
 * different link on each page: "Open sources" on the guide, "Add a source" to the Sources page
 * elsewhere, a jump straight into the Xtream form from Sports and "Go to Home" on Watch stats.
 */
export function NoSourcesActions({ testId = 'no-sources-add', stay = false }: NoSourcesActionsProps) {
  const { t } = useTranslation('sources');
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // Mounted on the first press and kept, so the dialog's exit animation can run.
  const [requested, setRequested] = useState(false);
  // The dialog shows the import's progress and toasts its success itself, as on Home and Sources.
  useEffect(() => (open ? holdImportToasts() : undefined), [open]);
  return (
    <>
      <Button
        variant="primary"
        onClick={() => {
          setRequested(true);
          setOpen(true);
        }}
        data-testid={testId}
      >
        {t('noSourcesAdd')}
      </Button>
      <Link to="/settings/backup" className={buttonClass('ghost', 'md')} data-testid="no-sources-backup">
        <DatabaseBackup aria-hidden size={16} />
        {t('onboardBackupLink')}
      </Link>
      {requested && (
        <Suspense fallback={null}>
          <AddSourceDialog
            open={open}
            onClose={() => setOpen(false)}
            onAdded={(source, first) => {
              if (first && !stay) navigate(sourceHomePath(source));
            }}
          />
        </Suspense>
      )}
    </>
  );
}

export interface NoSourcesStateProps extends NoSourcesActionsProps {
  icon: ReactNode;
  /** The page's own empty title ("No favorites yet"), or "No sources yet" where the page has none. */
  title: string;
  /** One line on what this page shows once a source exists. */
  description: string;
  /**
   * `page`: the kit's centred empty state. `banner`: one short row in a dashed frame, for a page
   * that still shows something without a source (Sports lists the day's games under it).
   */
  layout?: 'page' | 'banner';
  className?: string;
  /** Test id of the whole state. */
  stateTestId?: string;
}

/**
 * The one "no source yet" state: the page's icon, title and line, then {@link NoSourcesActions}.
 * The guide, Favorites, Recently watched, My List, Multi-view, Watch stats and Sports all draw it,
 * so a new user clicking around meets the same message and the same two ways forward everywhere.
 */
export function NoSourcesState({ icon, title, description, layout = 'page', className, stateTestId, ...actions }: NoSourcesStateProps) {
  if (layout === 'page') {
    return (
      <div className={className} data-testid={stateTestId}>
        <EmptyState icon={icon} title={title} description={description} action={<NoSourcesActions {...actions} />} />
      </div>
    );
  }
  return (
    <div
      className={cn('flex flex-col gap-3 rounded-lg border border-dashed border-edge px-4 py-3 sm:flex-row sm:items-center sm:gap-4', className)}
      data-testid={stateTestId}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full border border-divider bg-surface-2 text-fg-muted [&>svg]:size-5">
          {icon}
        </span>
        <div className="flex min-w-0 flex-col">
          <h2 className="text-body font-medium text-fg">{title}</h2>
          <p className="text-body-sm text-fg-muted">{description}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <NoSourcesActions {...actions} />
      </div>
    </div>
  );
}
