import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { cn } from './cn';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  content: ReactNode;
  /** A single focusable element (button, link). */
  children: ReactElement;
  side?: TooltipSide;
  /** Hover delay in ms. Keyboard focus shows immediately. */
  delay?: number;
  className?: string;
}

/** Gap between anchor and tooltip, and the minimum distance kept from the viewport edge. */
const GAP = 8;
const MARGIN = 8;
/** After a tooltip hides, the next one within this window shows without the hover delay. */
const WARM_MS = 500;
let lastHiddenAt = 0;

interface Size {
  width: number;
  height: number;
}

const OPPOSITE: Record<TooltipSide, TooltipSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/**
 * Where a tooltip of `size` goes next to `anchor`. Flips to the opposite side
 * when the preferred one would leave the viewport and the opposite fits better,
 * then clamps along the other axis so the tooltip stays fully visible.
 */
export function placeTooltip(
  anchor: Pick<DOMRect, 'top' | 'left' | 'right' | 'bottom' | 'width' | 'height'>,
  size: Size,
  side: TooltipSide,
  viewport: Size,
): { left: number; top: number; side: TooltipSide } {
  const room: Record<TooltipSide, number> = {
    top: anchor.top - GAP - MARGIN,
    bottom: viewport.height - anchor.bottom - GAP - MARGIN,
    left: anchor.left - GAP - MARGIN,
    right: viewport.width - anchor.right - GAP - MARGIN,
  };
  const need = side === 'top' || side === 'bottom' ? size.height : size.width;
  let final = side;
  if (room[side] < need && room[OPPOSITE[side]] > room[side]) final = OPPOSITE[side];

  let left: number;
  let top: number;
  if (final === 'top' || final === 'bottom') {
    left = anchor.left + anchor.width / 2 - size.width / 2;
    top = final === 'top' ? anchor.top - GAP - size.height : anchor.bottom + GAP;
  } else {
    left = final === 'left' ? anchor.left - GAP - size.width : anchor.right + GAP;
    top = anchor.top + anchor.height / 2 - size.height / 2;
  }
  const clamp = (v: number, max: number) => Math.max(MARGIN, Math.min(v, max - MARGIN));
  left = clamp(left, viewport.width - size.width);
  top = clamp(top, viewport.height - size.height);
  return { left, top, side: final };
}

/**
 * Tooltip shown on hover (after `delay`) and on keyboard focus; Escape, a
 * pointer press, or scrolling hides it. Wires aria-describedby on the child
 * and stays inside the viewport. Moving between tooltipped controls skips the
 * delay so a toolbar reads quickly.
 */
export function Tooltip({ content, children, side = 'top', delay = 400, className }: TooltipProps) {
  const id = useId();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; side: TooltipSide } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const show = (immediate: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    const run = () => {
      const el = anchor.current?.firstElementChild ?? anchor.current;
      if (el) setRect(el.getBoundingClientRect());
    };
    if (immediate || Date.now() - lastHiddenAt < WARM_MS) run();
    else timer.current = setTimeout(run, delay);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setRect((r) => {
      if (r) lastHiddenAt = Date.now();
      return null;
    });
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // A fixed tooltip would stay behind when its anchor scrolls away.
  useEffect(() => {
    if (!rect) return;
    const onScroll = () => hide();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [rect]);

  // Measure after render (hidden), then place inside the viewport before paint.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!rect || !tip) {
      setPos(null);
      return;
    }
    const size = tip.getBoundingClientRect();
    setPos(placeTooltip(rect, { width: size.width, height: size.height }, side, { width: window.innerWidth, height: window.innerHeight }));
  }, [rect, side, content]);

  const child = isValidElement<{ 'aria-describedby'?: string }>(children)
    ? cloneElement(children, { 'aria-describedby': rect ? id : children.props['aria-describedby'] })
    : children;

  const style: CSSProperties = pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' };

  return (
    <span
      ref={anchor}
      className="inline-flex"
      onMouseEnter={() => show(false)}
      onMouseLeave={hide}
      onPointerDown={hide}
      onFocus={(e) => {
        if ((e.target as HTMLElement).matches?.(':focus-visible')) show(true);
      }}
      onBlur={hide}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && rect) hide();
      }}
    >
      {child}
      {rect &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            data-side={pos?.side ?? side}
            style={style}
            className={cn(
              'pointer-events-none fixed z-[70] max-w-64 rounded-sm border border-border bg-surface-3 px-2 py-1 text-xs text-fg shadow-1 motion-safe:animate-fade-in',
              className,
            )}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
