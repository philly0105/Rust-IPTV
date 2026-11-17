import { useLayoutEffect, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';

/** The kit's SearchInput: 2.25rem before the text and 4rem after it while the key caps show. */
const START_REM = 2.25;
const CAPS_END_REM = 4;
/** The canvas measures a few px short of the field's own text (its caret, rounding). */
const SLACK_PX = 4;

export interface SearchFit {
  /** Whether the field draws its key caps: a placeholder cut beside them gets their room instead. */
  caps: boolean;
  /** The placeholder's width in px (0 until measured), for a field that must keep it whole. */
  textWidth: number;
}

/**
 * How the search field in `ref` fits its placeholder ("Αναζήτηση καναλιών" was cut beside Ctrl F
 * at 1024 px, "Αναζήτηση" to "Αν…" on a 360 px phone). Measured after layout, from the
 * ResizeObserver and rendered before that frame paints, as useFitsWidth; caps and no width until then and in jsdom.
 */
export function useSearchFit(ref: RefObject<HTMLInputElement | null>, placeholder: string): SearchFit {
  const [fit, setFit] = useState<SearchFit>({ caps: true, textWidth: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let ctx: CanvasRenderingContext2D | null | undefined;
    const ro = new ResizeObserver((entries) => {
      const width = entries.at(-1)?.borderBoxSize?.[0]?.inlineSize ?? el.offsetWidth;
      if (!width) return;
      ctx ??= document.createElement('canvas').getContext('2d');
      if (!ctx) return;
      const style = getComputedStyle(el);
      ctx.font = style.font;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const borders = (parseFloat(style.borderInlineStartWidth) || 0) + (parseFloat(style.borderInlineEndWidth) || 0);
      const textWidth = Math.ceil(ctx.measureText(placeholder).width) + SLACK_PX;
      const caps = textWidth <= width - borders - (START_REM + CAPS_END_REM) * rem;
      flushSync(() => setFit((f) => (f.caps === caps && f.textWidth === textWidth ? f : { caps, textWidth })));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, placeholder]);
  return fit;
}
