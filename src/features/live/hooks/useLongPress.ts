import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';

/** How long a finger rests before the press counts as a long press. */
export const LONG_PRESS_MS = 450;
/** Moving further than this (px) is a scroll or a drag, not a long press. */
export const LONG_PRESS_SLOP_PX = 8;

export interface LongPressHandlers {
  onPointerDown(e: PointerEvent<HTMLElement>): void;
  onPointerMove(e: PointerEvent<HTMLElement>): void;
  onPointerUp(): void;
  onPointerCancel(): void;
  /** Swallows the click that ends a long press, so the row does not also play. */
  onClickCapture(e: MouseEvent<HTMLElement>): void;
}

/**
 * Long press for touch and pen (LG-04): iOS Safari fires no `contextmenu` on a long press, so the
 * channel menu was out of reach on an iPhone or iPad. A mouse keeps its right click; the press
 * fires once the finger has rested {@link LONG_PRESS_MS} without moving more than
 * {@link LONG_PRESS_SLOP_PX}, at the point it went down. The click that follows is dropped.
 */
export function useLongPress(onLongPress: (x: number, y: number, target: HTMLElement) => void): LongPressHandlers {
  const timer = useRef<number | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cb = useRef(onLongPress);
  cb.current = onLongPress;
  const cancel = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    origin.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      fired.current = false;
      if (e.pointerType === 'mouse' || !e.isPrimary) return;
      cancel();
      const { clientX: x, clientY: y } = e;
      const target = e.currentTarget;
      origin.current = { x, y };
      timer.current = window.setTimeout(() => {
        origin.current = null;
        fired.current = true;
        cb.current(x, y, target);
      }, LONG_PRESS_MS);
    },
    [cancel],
  );
  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const o = origin.current;
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > LONG_PRESS_SLOP_PX) cancel();
    },
    [cancel],
  );
  const onClickCapture = useCallback((e: MouseEvent<HTMLElement>) => {
    if (!fired.current) return;
    fired.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);
  return { onPointerDown, onPointerMove, onPointerUp: cancel, onPointerCancel: cancel, onClickCapture };
}
