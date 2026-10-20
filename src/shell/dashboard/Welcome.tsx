/**
 * Home on first run (SH-welcome-generic): the app's mark, a welcome, one line on what it does,
 * and the three ways in, which are the Sources page's own onboarding tiles (M3U, Xtream Codes,
 * Stalker portal, each saying what the user needs) with its "Import a backup" link. A tile
 * opens the Add source dialog right here, on the kind it names, so cancelling leaves the user
 * on Home (SH-cancel-returns). The first source, once added, opens on its own channels (or its
 * movies or series when it has none; SS-6), one click from playing, and the tour's coach mark
 * finds search there. It used to be a stock empty state centred in the void, whose one button
 * led to a dialog opened over the Sources page's better onboarding.
 */

import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { isDesktop } from '@/api/transport';
import type { SourceKind } from '@/api/types';
import { Onboarding } from '@/features/sources/components/Onboarding';
import { BrandMark, Page } from '@/ui';

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
  return (
    <div className="@container relative flex min-h-full flex-col" data-testid="dashboard-welcome">
      {/* A faint lift at the top of the page, so the welcome does not float on a flat field. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-gradient-to-b from-surface/70 to-transparent" />
      {/*
        The upper third, not the middle of the window: the tiles are the page's point. The space
        above shrinks with the window's height, so at 720 px the tiles are still in view.
      */}
      <Page width="wide" className="relative flex flex-col gap-8 pt-[max(1.5rem,calc(16vh-4rem))] pb-12">
        <div className="flex max-w-3xl flex-col gap-4">
          <BrandMark size={56} className="shrink-0" />
          <h2 className="text-display text-fg">{t('welcomeHeading')}</h2>
          <p className="max-w-2xl text-body text-pretty text-fg-muted @2xl:text-title-sm @2xl:font-normal @2xl:text-fg-muted">{t('welcomeLead')}</p>
        </div>
        {/*
          The Sources page's onboarding, as it is there. Its own heading becomes the step's
          heading under the welcome, and its column starts on the page gutter, not centred.
        */}
        <div className="max-w-5xl [&_#sources-onboarding-title]:text-title-sm [&>section]:py-0">
          <Onboarding onPick={pick} />
        </div>
        <p className="text-caption text-fg-subtle">{t(isDesktop ? 'welcomePrivacyDesktop' : 'welcomePrivacyServer')}</p>
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
