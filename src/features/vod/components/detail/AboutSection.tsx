import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { SectionHeader } from '@/ui';

export interface DetailFact {
  label: string;
  value: ReactNode;
}

/**
 * The facts of a title under its hero (VL-detail-empty-no-tmdb): source, category, when it was
 * added, the file format, genres, the audio language. All of it comes from the provider, so a
 * detail page has something below the hero with TMDB off, the default. Empty facts drop out; the
 * section goes away when none is left.
 */
export function AboutSection({ facts, action }: { facts: DetailFact[]; /** At the end of the heading row (a link to the title's catalogue page). */ action?: ReactNode }) {
  const { t } = useTranslation('vod');
  const headingId = useId();
  const shown = facts.filter((f) => f.value !== undefined && f.value !== null && f.value !== '' && f.value !== false);
  if (shown.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3" data-testid="vod-about">
      <SectionHeader id={headingId} title={t('about')} action={action} />
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-x-8 gap-y-4 rounded-lg border border-edge bg-surface px-5 py-4">
        {shown.map((f) => (
          <div key={f.label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-caption text-fg-subtle">{f.label}</dt>
            <dd dir="auto" className="text-body-sm break-words text-fg text-match-parent">
              {f.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
