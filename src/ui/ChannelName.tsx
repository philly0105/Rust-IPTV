import { splitPlaceTag, stripCountryPrefix } from '@/lib/channelName';

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
 * A channel's name with the provider's place tag after it, quiet: "ESPN HD US" for "US| ESPN HD".
 * The tag led every name in the same weight, so "US|" was the most repeated string on screen and a
 * narrow column cut "US| ESPN..." before it reached what tells ESPN2 from ESPNU. After the name, in
 * the caption size and the subtle tone, the tag is what a narrow column drops first, whole and
 * without an ellipsis, so an ellipsis always means the name itself is cut.
 *
 * Only a place's code moves (`splitPlaceTag`): "NBA: Lakers vs Celtics" and "Sky Sports | Main
 * Event" are drawn as the provider wrote them. Screen readers get the provider's name as it is (the
 * drawn parts are hidden), which matches the row's accessible name, search and menus. With the
 * strip setting on, the tag is gone as before. Callers truncate through `className`: this span has
 * `dir="auto"`, which puts an RTL name's ellipsis at its own end.
 */
export function ChannelName({ name, strip, className, tagClassName, title, testId }: ChannelNameProps) {
  const raw = name ?? '';
  const split = strip ? undefined : splitPlaceTag(raw);
  if (!split?.tag) {
    return (
      <span dir="auto" className={className} title={title} data-testid={testId}>
        {strip ? stripCountryPrefix(raw) : raw}
      </span>
    );
  }
  return (
    <span dir="auto" className={className} title={title} data-testid={testId}>
      {/* One line tall: a tag that does not fit beside the name wraps to a second line, out of
          sight, so it goes whole (a clipped "U" read as part of the name). The name never shrinks
          below its own width (up to the whole line), so its ellipsis means it is cut; shrinking
          the tag first by flex-shrink weights also took a fraction of a pixel from the name, and
          that was enough to draw an ellipsis on a complete one. */}
      <span aria-hidden className="flex h-[1lh] min-w-0 flex-wrap items-baseline overflow-hidden">
        <span className="max-w-full shrink-0 truncate">{split.name}</span>
        <span
          className={cn('ms-1.5 whitespace-nowrap text-caption font-medium tracking-wide text-fg-subtle', tagClassName)}
          data-testid="channel-name-tag"
        >
          {split.tag}
        </span>
      </span>
      <span className="sr-only">{raw}</span>
    </span>
  );
}
