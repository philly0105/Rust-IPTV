import {
  cloneElement,
  isValidElement,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { cn } from './cn';

export interface TooltipProps {
  content: ReactNode;
  /** A single focusable element (button, link). */
  children: ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Hover delay in ms. Keyboard focus shows immediately. */
  delay?: number;
  className?: string;
}

/**
 * Tooltip shown on hover (after `delay`) and on keyboard focus; Escape hides.
 * Wires aria-describedby on the child.
 */
export function Tooltip({ content, children, side = 'top', delay = 400, className }: TooltipProps) {
  const id = useId();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);

  const show = (immediate: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    const run = () => {
      const el = anchor.current?.firstElementChild ?? anchor.current;
      if (el) setRect(el.getBoundingClientRect());
    };
    if (immediate) run();
    else timer.current = setTimeout(run, delay);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setRect(null);
  };

  const child = isValidElement<{ 'aria-describedby'?: string }>(children)
    ? cloneElement(children, { 'aria-describedby': rect ? id : children.props['aria-describedby'] })
    : children;

  let style: CSSProperties = {};
  if (rect) {
    const gap = 8;
    if (side === 'top') style = { left: rect.left + rect.width / 2, top: rect.top - gap, transform: 'translate(-50%, -100%)' };
    if (side === 'bottom') style = { left: rect.left + rect.width / 2, top: rect.bottom + gap, transform: 'translateX(-50%)' };
    if (side === 'left') style = { left: rect.left - gap, top: rect.top + rect.height / 2, transform: 'translate(-100%, -50%)' };
    if (side === 'right') style = { left: rect.right + gap, top: rect.top + rect.height / 2, transform: 'translateY(-50%)' };
  }

  return (
    <span
      ref={anchor}
      className="inline-flex"
      onMouseEnter={() => show(false)}
      onMouseLeave={hide}
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
            id={id}
            role="tooltip"
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
