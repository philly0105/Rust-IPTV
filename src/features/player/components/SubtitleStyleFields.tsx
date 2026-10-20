/**
 * Subtitle look controls (C6), shared by the Playback settings group (`tone="page"`) and the
 * player menu's "Subtitle style..." view (`tone="glass"`): size, colour, background and
 * position, plus the settings page's live preview. Values map through subtitles/style.ts, so
 * the swatches and samples show exactly what the players draw.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  SUBTITLE_BACKGROUNDS,
  SUBTITLE_COLORS,
  SUBTITLE_POSITION_MAX,
  SUBTITLE_POSITION_MIN,
  SUBTITLE_SIZES,
  type SubtitleBackground,
  type SubtitleColor,
  type SubtitleSize,
} from '@/api/types';

import { SegmentedControl } from '@/ui/Segmented';

import { cn } from '../cn';
import { clampSubtitlePosition, cueCssVars, SUBTITLE_HEX, SUBTITLE_SCALE, type SubtitleStyle } from '../subtitles/style';

export type FieldTone = 'page' | 'glass';

/** i18n key suffixes per value (`subtitleStyle.size<Suffix>` and so on). */
const SIZE_KEY: Record<SubtitleSize, string> = { small: 'sizeSmall', medium: 'sizeMedium', large: 'sizeLarge', xlarge: 'sizeXlarge' };
const COLOR_KEY: Record<SubtitleColor, string> = { white: 'colorWhite', yellow: 'colorYellow', cyan: 'colorCyan', green: 'colorGreen' };
const BG_KEY: Record<SubtitleBackground, string> = { shadow: 'backgroundShadow', box: 'backgroundBox', solid: 'backgroundSolid' };

/** The CSS variables of a style as an inline style object. */
function varsOf(style: SubtitleStyle): CSSProperties {
  return cueCssVars(style) as CSSProperties;
}

/** Sample text drawn the way `video::cue` draws it (player.css), at `em`-relative size. */
const SAMPLE_CLASS = '[background:var(--sub-bg)] [color:var(--sub-color)] [text-shadow:var(--sub-shadow)]';

/**
 * The kit SegmentedControl in the field's tone: Left/Right (mirrored in right-to-left text),
 * Home and End pick; on the settings page Up/Down do too (in the player menu they move between
 * rows). Each segment shows a sample and names itself in a tooltip.
 */
function ChoiceGroup<T extends string>({
  id,
  label,
  describedBy,
  value,
  options,
  onChange,
  tone,
  testId,
  className,
}: {
  id?: string;
  label: string;
  describedBy?: string;
  value: T;
  options: { value: T; label: string; content: ReactNode; className?: string }[];
  onChange(v: T): void;
  tone: FieldTone;
  testId: string;
  className?: string;
}) {
  return (
    <SegmentedControl<T>
      id={id}
      label={label}
      describedBy={describedBy}
      value={value}
      options={options}
      onChange={onChange}
      tone={tone === 'page' ? 'default' : 'glass'}
      testId={testId}
      className={cn('flex-wrap', className)}
    />
  );
}

export function SizeChoice(props: { id?: string; describedBy?: string; value: SubtitleSize; onChange(v: SubtitleSize): void; tone: FieldTone }) {
  const { t } = useTranslation('player');
  return (
    <ChoiceGroup
      {...props}
      label={t('subtitleStyle.size')}
      testId="subtitle-size"
      options={SUBTITLE_SIZES.map((v) => {
        const label = t(`subtitleStyle.${SIZE_KEY[v]}`);
        return {
          value: v,
          label,
          // The glyph grows with the setting; the page also spells the size out.
          content: (
            <>
              <span aria-hidden className="font-display leading-none" style={{ fontSize: `${0.8 * SUBTITLE_SCALE[v]}rem` }}>
                A
              </span>
              {props.tone === 'page' && <span>{label}</span>}
            </>
          ),
          className: props.tone === 'page' ? 'px-3' : 'w-11 px-0',
        };
      })}
    />
  );
}

export function ColorChoice(props: { id?: string; describedBy?: string; value: SubtitleColor; onChange(v: SubtitleColor): void; tone: FieldTone }) {
  const { t } = useTranslation('player');
  return (
    <ChoiceGroup
      {...props}
      label={t('subtitleStyle.color')}
      testId="subtitle-color"
      options={SUBTITLE_COLORS.map((v) => {
        const label = t(`subtitleStyle.${COLOR_KEY[v]}`);
        return {
          value: v,
          label,
          content: (
            <>
              {/* The swatch is the subtitle colour itself (data, not chrome). */}
              <span aria-hidden className="size-4 rounded-full ring-1 ring-black/40" style={{ backgroundColor: SUBTITLE_HEX[v] }} />
              {props.tone === 'page' && <span>{label}</span>}
            </>
          ),
          className: props.tone === 'page' ? 'px-3' : 'w-11 px-0',
        };
      })}
    />
  );
}

export function BackgroundChoice(props: {
  id?: string;
  describedBy?: string;
  value: SubtitleBackground;
  color: SubtitleColor;
  onChange(v: SubtitleBackground): void;
  tone: FieldTone;
}) {
  const { t } = useTranslation('player');
  return (
    <ChoiceGroup
      id={props.id}
      describedBy={props.describedBy}
      value={props.value}
      onChange={props.onChange}
      tone={props.tone}
      label={t('subtitleStyle.background')}
      testId="subtitle-background"
      options={SUBTITLE_BACKGROUNDS.map((v) => {
        const label = t(`subtitleStyle.${BG_KEY[v]}`);
        return {
          value: v,
          label,
          content: (
            <>
              {/* A tiny "Aa" on a dark tile, drawn with this background. */}
              <span aria-hidden className="inline-flex h-6 items-center rounded-xs bg-black/70 px-1" style={varsOf({ size: 'medium', color: props.color, background: v, position: 0 })}>
                <span className={cn('rounded-[2px] px-0.5 text-xs leading-tight font-semibold', SAMPLE_CLASS)}>Aa</span>
              </span>
              <span className={props.tone === 'glass' ? 'text-xs' : undefined}>{label}</span>
            </>
          ),
          className: props.tone === 'page' ? 'px-2.5' : 'px-1.5',
        };
      })}
    />
  );
}

/**
 * Position, 0..=40 steps above the usual place. `onPreview` follows the thumb while it moves;
 * `onCommit` saves once the drag or key press ends, so a drag is one settings write.
 */
export function PositionSlider({
  id,
  describedBy,
  value,
  onPreview,
  onCommit,
  tone,
}: {
  id?: string;
  describedBy?: string;
  value: number;
  onPreview?(v: number): void;
  onCommit(v: number): void;
  tone: FieldTone;
}) {
  const { t } = useTranslation('player');
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  const readout = (v: number): string => (v === 0 ? t('subtitleStyle.positionBottom') : t('subtitleStyle.positionValue', { value: v }));
  const commit = (): void => {
    if (!editing.current) return;
    editing.current = false;
    // Saved even when it equals `value`: a preview may already have put it there.
    onCommit(draft);
  };
  const fill = `${((draft - SUBTITLE_POSITION_MIN) / (SUBTITLE_POSITION_MAX - SUBTITLE_POSITION_MIN)) * 100}%`;

  return (
    <div className={cn('flex flex-col gap-1', tone === 'page' && 'w-full @2xl:w-72')}>
      <div className="flex items-baseline justify-between gap-3">
        <output
          htmlFor={id}
          aria-live="polite"
          data-testid="subtitle-position-value"
          className={cn('tabular-nums', tone === 'page' ? 'font-display text-lg font-semibold text-fg' : 'text-xs text-white/80')}
        >
          {readout(draft)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={SUBTITLE_POSITION_MIN}
        max={SUBTITLE_POSITION_MAX}
        step={1}
        value={draft}
        aria-label={t('subtitleStyle.position')}
        aria-describedby={describedBy}
        aria-valuetext={readout(draft)}
        data-testid="subtitle-position"
        onChange={(e) => {
          const v = clampSubtitlePosition(Number(e.currentTarget.value));
          editing.current = true;
          setDraft(v);
          onPreview?.(v);
        }}
        onPointerUp={commit}
        onKeyDown={(e) => {
          // In the player's menus Up/Down move between rows (the menu takes them, as it does for
          // the radio groups); the slider keeps Left/Right, Home/End and Page keys. On the page
          // it owns every arrow. Neither the menu nor the player's shortcuts take the keys it keeps.
          if (tone === 'glass' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;
          if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key.startsWith('Page')) e.stopPropagation();
        }}
        onKeyUp={(e) => {
          if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key.startsWith('Page')) commit();
        }}
        onBlur={commit}
        className={cn('w-full cursor-pointer', tone === 'page' ? 'h-6 accent-accent' : 'player-range')}
        style={tone === 'glass' ? ({ ['--fill' as string]: fill } as CSSProperties) : undefined}
      />
    </div>
  );
}

/**
 * The settings page's preview: a small screen with one subtitle line in the chosen style and
 * place. The text scales with the frame as it does with the video.
 */
export function SubtitlePreview({ style }: { style: SubtitleStyle }) {
  const { t } = useTranslation('player');
  return (
    <figure
      data-testid="subtitle-preview"
      aria-label={t('subtitleStyle.preview')}
      className="@container/preview relative aspect-video w-full overflow-hidden rounded-lg border border-edge bg-bg"
      style={varsOf(style)}
    >
      {/* A night scene from theme tokens: bright and dark areas, so legibility shows on both. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 90% at 78% 18%, color-mix(in oklab, var(--color-glow) 70%, transparent), transparent 60%), radial-gradient(90% 70% at 12% 100%, color-mix(in oklab, var(--color-accent) 45%, transparent), transparent 70%), linear-gradient(180deg, var(--color-surface-3), var(--color-bg))',
        }}
      />
      <figcaption
        className="absolute inset-x-0 flex justify-center px-[6%] text-center motion-safe:transition-[bottom] motion-safe:duration-200"
        // Same place as `cueLine`: the line's bottom edge 10 % up, plus the position.
        style={{ bottom: `${10 + clampSubtitlePosition(style.position)}%` }}
      >
        <span
          data-testid="subtitle-preview-line"
          className={cn('rounded-[3px] px-[0.35em] py-[0.05em] leading-[1.35] whitespace-pre-line', SAMPLE_CLASS)}
          style={{ fontSize: `calc(clamp(0.7rem, 4.2cqw, 1.6rem) * ${SUBTITLE_SCALE[style.size]})` }}
        >
          {t('subtitleStyle.previewText')}
        </span>
      </figcaption>
    </figure>
  );
}
