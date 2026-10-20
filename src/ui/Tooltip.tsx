import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefCallback,
} from 'react';
import { createPortal } from 'react-dom';

import { cn } from './cn';
import { Kbd } from './Misc';
import { portalContainer } from './portal';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';
/** A physical side, or a logical one that follows the anchor's direction (`inline-end` is the right in LTR). */
export type TooltipPlacement = TooltipSide | 'inline-start' | 'inline-end';
/** `default`: the raised surface of the app. `glass`: dark glass for chrome over video (the player, multi-view). */
export type TooltipTone = 'default' | 'glass';

export interface TooltipOptions {
  /** What the tooltip says. `null`, `false` or `''` turns the tooltip off and leaves the trigger alone. */
  content: ReactNode;
  /** A key combo (`mod+k`, `space`, `shift+b`) drawn as translated key caps after the content. */
  shortcut?: string;
  side?: TooltipPlacement;
  /** Hover delay in ms. Keyboard focus shows at once. */
  delay?: number;
  tone?: TooltipTone;
  className?: string;
  /**
   * Point the trigger's aria-describedby at the tooltip while it shows. Default true. IconButton
   * turns it off when the tooltip only repeats the button's accessible name, so a screen reader
   * does not read the name twice.
   */
  describe?: boolean;
}

export interface TooltipProps extends TooltipOptions {
  /** A single focusable element (button, link). It gets the handlers; no wrapper is added. */
  children: ReactElement;
}

/** Gap between anchor and tooltip, and the minimum distance kept from the viewport edge. */
const GAP = 8;
const MARGIN = 8;
/** After a tooltip hides, the next one within this window shows without the hover delay. */
const WARM_MS = 500;
let lastHiddenAt = 0;
/**
 * The pointer type of the last pointerenter. A tap fires compatibility mouse events after the
 * touch, and a tooltip popping up under the finger only hides what was tapped, so a mouseenter
 * that follows a touch is ignored.
 */
let lastPointerType = '';

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

/** Resolves a logical placement against the anchor's writing direction. */
function physicalSide(side: TooltipPlacement, el: Element | null): TooltipSide {
  if (side !== 'inline-start' && side !== 'inline-end') return side;
  const rtl = el ? getComputedStyle(el).direction === 'rtl' : false;
  return (side === 'inline-end') !== rtl ? 'right' : 'left';
}

/** Joins refs (objects or callbacks) into one callback ref. */
export function mergeRefs<T>(...refs: (Ref<T> | undefined)[]): RefCallback<T> {
  return (value) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(value);
      else if (ref) (ref as { current: T | null }).current = value;
    }
  };
}

/**
 * mergeRefs kept stable while the refs are: a new callback ref on every render would detach
 * and reattach each time, and a child whose ref is a state setter would re-render without end.
 */
export function useMergedRef<T>(a: Ref<T> | undefined, b: Ref<T> | undefined): RefCallback<T> {
  return useMemo(() => mergeRefs(a, b), [a, b]);
}

const hasContent = (content: ReactNode) => content !== null && content !== undefined && content !== false && content !== '';

/** The handlers a trigger spreads; IconButton chains them after its caller's own. */
export interface TooltipTriggerProps {
  ref: RefCallback<HTMLElement>;
  'aria-describedby'?: string;
  onPointerEnter(e: PointerEvent<HTMLElement>): void;
  onMouseEnter(e: MouseEvent<HTMLElement>): void;
  onMouseLeave(e: MouseEvent<HTMLElement>): void;
  onPointerDown(e: PointerEvent<HTMLElement>): void;
  onFocus(e: FocusEvent<HTMLElement>): void;
  onBlur(e: FocusEvent<HTMLElement>): void;
  onKeyDown(e: KeyboardEvent<HTMLElement>): void;
}

/**
 * Tooltip behaviour for any trigger: shown on hover (after `delay`) and on keyboard focus;
 * Escape, a pointer press, blur, or scrolling hides it. Returns the props for the trigger and
 * the tooltip node (portaled, so it can sit anywhere in the tree). Moving between tooltipped
 * controls skips the delay so a toolbar reads quickly. With no content it returns inert props
 * and no node.
 */
export function useTooltip({
  content,
  shortcut,
  side = 'top',
  delay = 400,
  tone = 'default',
  className,
  describe = true,
}: TooltipOptions): { triggerProps: TooltipTriggerProps; tooltip: ReactNode } {
  const id = useId();
  const enabled = hasContent(content);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; side: TooltipSide } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const show = (immediate: boolean) => {
    if (!enabled) return;
    if (timer.current) clearTimeout(timer.current);
    const run = () => {
      if (anchor.current?.isConnected) setRect(anchor.current.getBoundingClientRect());
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

  // The content went away while shown (the control no longer has a tooltip): hide it too.
  useEffect(() => {
    if (!enabled) hide();
  }, [enabled]);

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
    setPos(
      placeTooltip(rect, { width: size.width, height: size.height }, physicalSide(side, anchor.current), {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [rect, side, content]);

  // Stable, so a trigger's merged ref (useMergedRef) stays the same between renders.
  const setAnchor = useCallback((el: HTMLElement | null) => {
    anchor.current = el;
  }, []);
  const shown = enabled && rect !== null;
  const triggerProps: TooltipTriggerProps = {
    ref: setAnchor,
    'aria-describedby': shown && describe ? id : undefined,
    onPointerEnter: (e) => {
      lastPointerType = e.pointerType;
    },
    onMouseEnter: () => {
      if (lastPointerType === 'touch') return;
      show(false);
    },
    onMouseLeave: hide,
    onPointerDown: hide,
    onFocus: (e) => {
      if ((e.target as HTMLElement).matches?.(':focus-visible')) show(true);
    },
    onBlur: hide,
    onKeyDown: (e) => {
      // WCAG 1.4.13: Escape dismisses the tooltip alone. Claiming the key keeps
      // the same press from also closing the dialog or leaving the page.
      if (e.key === 'Escape' && rect && !e.nativeEvent.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        hide();
      }
    },
  };

  const style: CSSProperties = pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' };
  const tooltip = shown
    ? createPortal(
        <div
          ref={tipRef}
          id={id}
          role="tooltip"
          data-side={pos?.side ?? side}
          data-tone={tone}
          style={style}
          className={cn(
            'pointer-events-none fixed z-[70] flex max-w-64 items-center gap-2 rounded-sm px-2 py-1 text-caption font-medium shadow-2 motion-safe:animate-fade-in',
            tone === 'glass'
              ? // Over video the tooltip is glass like the chrome it labels; its key caps go glass too.
                'border border-glass-border bg-glass-strong text-on-glass [&_kbd]:border-glass-border [&_kbd]:bg-white/10 [&_kbd]:text-on-glass-muted'
              : 'border border-edge bg-surface-3 text-fg',
            className,
          )}
        >
          <span className="min-w-0">{content}</span>
          {shortcut && <Kbd combo={shortcut} className="shrink-0 [&_kbd]:h-5 [&_kbd]:min-w-5 [&_kbd]:px-1 [&_kbd]:text-2xs" />}
        </div>,
        // In element fullscreen (player, multi-view wall) only the fullscreen element paints.
        portalContainer(),
      )
    : null;

  return { triggerProps, tooltip };
}

type Handler<E> = ((e: E) => void) | undefined;

/** Calls the trigger's own handler first, then the tooltip's. */
function chain<E>(own: Handler<E>, tip: (e: E) => void): (e: E) => void {
  return (e) => {
    own?.(e);
    tip(e);
  };
}

/**
 * Composes tooltip trigger props with a trigger's own props (handlers chained). `ref` is the
 * merged ref from useMergedRef(ownRef, tip.ref).
 */
export function withTooltipProps<P extends Record<string, unknown>>(own: P, tip: TooltipTriggerProps, ref?: RefCallback<HTMLElement>) {
  const describedBy = [own['aria-describedby'] as string | undefined, tip['aria-describedby']].filter(Boolean).join(' ') || undefined;
  return {
    ref: ref ?? tip.ref,
    'aria-describedby': describedBy,
    onPointerEnter: chain(own['onPointerEnter'] as Handler<PointerEvent<HTMLElement>>, tip.onPointerEnter),
    onMouseEnter: chain(own['onMouseEnter'] as Handler<MouseEvent<HTMLElement>>, tip.onMouseEnter),
    onMouseLeave: chain(own['onMouseLeave'] as Handler<MouseEvent<HTMLElement>>, tip.onMouseLeave),
    onPointerDown: chain(own['onPointerDown'] as Handler<PointerEvent<HTMLElement>>, tip.onPointerDown),
    onFocus: chain(own['onFocus'] as Handler<FocusEvent<HTMLElement>>, tip.onFocus),
    onBlur: chain(own['onBlur'] as Handler<FocusEvent<HTMLElement>>, tip.onBlur),
    onKeyDown: chain(own['onKeyDown'] as Handler<KeyboardEvent<HTMLElement>>, tip.onKeyDown),
  };
}

/**
 * Tooltip on a single focusable child: hover (after `delay`) and keyboard focus show it;
 * Escape, a pointer press, blur or scrolling hide it. The child keeps its place in the layout
 * (no wrapper element): the handlers, a ref and aria-describedby are added to it. Use it for
 * icon-only controls that are not an IconButton (links in the collapsed rail, player and hero
 * controls); IconButton has it built in. Keep native `title` only for truncated text.
 */
export function Tooltip({ children, ...options }: TooltipProps) {
  const { triggerProps, tooltip } = useTooltip(options);
  const valid = isValidElement<Record<string, unknown>>(children);
  const ref = useMergedRef(valid ? (children.props['ref'] as Ref<HTMLElement> | undefined) : undefined, triggerProps.ref);
  if (!valid) return children;
  const child = cloneElement(children, withTooltipProps(children.props, triggerProps, ref));
  return (
    <>
      {child}
      {tooltip}
    </>
  );
}
