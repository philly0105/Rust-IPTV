/**
 * Home on first run (SH-welcome-generic): the app's mark, a welcome, one line on what it does,
 * and the three ways in, which are the Sources page's own onboarding tiles (M3U, Xtream Codes,
 * Stalker portal, each saying what the user needs) with its "Import a backup" link. A tile
 * opens the Add source dialog right here, on the kind it names, so cancelling leaves the user
 * on Home (SH-cancel-returns). The first source, once added, opens on its own channels (or its
 * movies or series when it has none; SS-6), one click from playing, and the tour's coach mark
 * finds search there. It used to be a stock empty state centred in the void, whose one button
 * led to a dialog opened over the Sources page's better onboarding. The onboarding's own lock line
 * says where the logins stay, so the welcome adds no second privacy sentence under it.
 *
 * While the dialog is open it reports the import itself (progress, then "Added"), so the shell's
 * import toasts are held back meanwhile, as they are on the Sources page.
 */

import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import type { SourceKind } from '@/api/types';
import { Onboarding } from '@/features/sources/components/Onboarding';
import { BrandMark, Page } from '@/ui';

import { holdImportToasts } from '../effects';
import { sourceHomePath } from '../railLinks';

// The add flow (forms, import progress) loads when a tile is picked, not with Home's chunk.
const AddSourceDialog = lazy(() => import('@/features/sources/components/AddSourceDialog').then((m) => ({ default: m.AddSourceDialog })));

/** `onAddingChange`: the add dialog opened or closed (Home keeps the welcome up while it is open). */
export function Welcome({ onAddingChange }: { onAddingChange?: (adding: boolean) => void }) {
  const { t } = useTranslation('shell');
  const navigate = useNavigate();
  // The kind the dialog opened on; kept while it closes, so its exit shows the same form.
  const [kind, setKind] = useState<SourceKind>('m3u');
  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useState(false);
  const pick = (k: SourceKind) => {
    setKind(k);
    setRequested(true);
    setOpen(true);
    onAddingChange?.(true);
  };
  const close = () => {
    setOpen(false);
    onAddingChange?.(false);
  };
  // The dialog shows its source's import progress and toasts its own success: without the hold the
  // shell added a progress toast over it and a second success toast ("This source is ready").
  useEffect(() => (open ? holdImportToasts() : undefined), [open]);
  return (
    <div className="@container relative flex min-h-full flex-col" data-testid="dashboard-welcome">
      {/* A faint lift at the top of the page, so the welcome does not float on a flat field. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-gradient-to-b from-surface/70 to-transparent" />
      {/*
        The upper third, not the middle of the window: the tiles are the page's point. The space
        above shrinks with the window's height, so at 720 px the tiles are still in view. On a
        phone the welcome is a short heading with no mark, so the tiles start on the first screen.
      */}
      <Page width="wide" className="relative flex flex-col gap-8 pt-[max(1.5rem,calc(16vh-4rem))] pb-12 max-sm:gap-6 max-sm:pt-6">
        <div className="flex max-w-3xl flex-col gap-4 max-sm:gap-2">
          <BrandMark size={56} className="shrink-0 max-sm:hidden" />
          <h2 className="text-display text-fg max-sm:text-headline">{t('welcomeHeading')}</h2>
          <p className="max-w-2xl text-body text-pretty text-fg-muted @2xl:text-title-sm @2xl:font-normal @2xl:text-fg-muted">{t('welcomeLead')}</p>
        </div>
        {/*
          The Sources page's onboarding, as it is there. Its own heading becomes the step's
          heading under the welcome, and its column starts on the page gutter, not centred. On a
          phone its lead line goes (the welcome's lead just said it) and its gaps tighten.
        */}
        <div className="max-w-5xl [&_#sources-onboarding-title]:text-title-sm [&>section]:py-0 max-sm:[&>section]:gap-4 max-sm:[&_#sources-onboarding-title+p]:hidden">
          <Onboarding onPick={pick} />
        </div>
      </Page>
      {requested && (
        <Suspense fallback={null}>
          <AddSourceDialog
            open={open}
            initial={{ kind }}
            onClose={close}
            onAdded={(source, first) => {
              if (first) navigate(sourceHomePath(source));
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
