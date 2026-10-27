import { splitCountryTag } from '@/lib/channelName';

import { cn } from './cn';

export interface ChannelNameProps {
  /** The provider's name as it is ("US| ESPN HD"). */
  name: string | null | undefined;
  /** `settings.stripCountryPrefix`: the tag is left out altogether. */
  strip?: boolean | undefined;
  /** The name's span: size, weight, colour and `truncate`, as the plain text had them. */
  className?: string | undefined;
  /** The tag's tone where the theme's quiet text does not apply (glass on the dark stage). */
  tagClassName?: string | undefined;
  title?: string | undefined;
  testId?: string | undefined;
}

/**
 * A channel's or group's name with the provider's tag after it, quiet: "ESPN HD US" for
 * "US| ESPN HD". The tag led every name in the same weight as the name, so the most repeated
 * string on screen was "US|", and a narrow column cut "US| ESPN..." four rows running before it
 * reached what tells ESPN2 from ESPNU. After the name, in the caption size and the subtle tone, it
 * is the first thing a narrow column cuts.
 *
 * Only the look changes. Assistive tech reads the provider's name as it is (the drawn parts are
 * hidden, the raw name is there for screen readers), so it matches the row's accessible name,
 * search and menus. With the strip setting on, the tag is gone as before. A name without a tag
 * renders as plain text.
 */
export function ChannelName({ name, strip, className, tagClassName, title, testId }: ChannelNameProps) {
  const raw = name ?? '';
  const split = splitCountryTag(raw);
  if (!split.tag || strip) {
    return (
      <span dir="auto" className={className} title={title} data-testid={testId}>
        {strip ? split.name : raw}
      </span>
    );
  }
  return (
    <span dir="auto" className={className} title={title} data-testid={testId}>
      <span aria-hidden>
        {split.name}
        <span className={cn('ms-1.5 text-caption font-medium tracking-wide text-fg-subtle', tagClassName)} data-testid="channel-name-tag">
          {split.tag}
        </span>
      </span>
      <span className="sr-only">{raw}</span>
    </span>
  );
}
