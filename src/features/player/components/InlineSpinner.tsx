/** Small sweeping dial for inline status text (the loading spinner's style, bar sized). */
export function InlineSpinner() {
  return (
    <svg viewBox="0 0 48 48" className="inline size-3.5 shrink-0 text-accent motion-safe:animate-spin" style={{ animationDuration: '1.4s' }} aria-hidden>
      <circle cx="24" cy="24" r="20" fill="none" stroke="rgb(255 255 255 / 0.15)" strokeWidth="5" />
      <path d="M24 4 a20 20 0 0 1 20 20" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}
