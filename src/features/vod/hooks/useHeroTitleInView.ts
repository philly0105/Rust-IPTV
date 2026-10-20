import { useEffect, useState, type RefObject } from 'react';

/**
 * True while the detail hero's h1 (`#vod-detail-title`) is on screen in the page scroller
 * (VL-hero-chrome). The detail pages put the section name in the shell header while it shows, so
 * the title appears once, and the title itself once it has scrolled away, the way Apple TV keeps
 * a large title in the page and a small one in the bar.
 *
 * `key` names what is rendered (browse or watch state, the title), so the observer finds the new
 * h1. Without IntersectionObserver it stays false and the header keeps the title.
 */
export function useHeroTitleInView(scrollRef: RefObject<HTMLElement | null>, enabled: boolean, key: unknown): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const root = scrollRef.current;
    const title = enabled ? root?.querySelector<HTMLElement>('#vod-detail-title') : null;
    if (!root || !title || typeof IntersectionObserver === 'undefined') {
      setInView(false);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setInView(last.isIntersecting);
    }, { root });
    io.observe(title);
    return () => io.disconnect();
  }, [scrollRef, enabled, key]);
  return inView;
}
