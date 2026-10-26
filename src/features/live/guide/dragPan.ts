/** Mouse and pen panning for the guide's native two-axis scroll container. */
const DRAG_THRESHOLD_PX = 3;
/** A quick first move can arrive as one large event before the browser paints. */
const FAST_START_PX = 96;
const FIRST_STEP_PX = 48;
const CATCH_UP_STEP_PX = 140;

interface Gesture {
  id: number;
  x: number;
  y: number;
  left: number;
  top: number;
  firstFrameSeen: boolean;
  dragging: boolean;
}

interface CatchUp {
  left: number;
  top: number;
  firstFrame: boolean;
}

export function attachGuideDragPan(root: HTMLElement): () => void {
  let gesture: Gesture | null = null;
  let suppressClick = false;
  let clickTimer = 0;
  let firstFrame = 0;
  let catchUpFrame = 0;
  let catchUp: CatchUp | null = null;

  const stopCatchUp = () => {
    window.cancelAnimationFrame(catchUpFrame);
    catchUpFrame = 0;
    catchUp = null;
  };
  const approach = (target: CatchUp, fraction: number, maxStep: number, checkDone = true): boolean => {
    const left = root.scrollLeft;
    const top = root.scrollTop;
    const dx = target.left - left;
    const dy = target.top - top;
    const distance = Math.hypot(dx, dy);
    if (distance <= 0.5) return true;
    const scale = Math.min(fraction, maxStep / distance);
    const nextLeft = left + dx * scale;
    const nextTop = top + dy * scale;
    root.scrollTo({ left: nextLeft, top: nextTop, behavior: 'instant' });
    if (!checkDone) return false;
    const actualLeft = root.scrollLeft;
    const actualTop = root.scrollTop;
    // Native scrolling clamps at either edge. Stop chasing a blocked axis so a diagonal
    // drag can still catch up quickly along the other one, without reading scroll bounds.
    if (Math.abs(nextLeft - left) > 1 && actualLeft === left) target.left = left;
    if (Math.abs(nextTop - top) > 1 && actualTop === top) target.top = top;
    return Math.hypot(target.left - actualLeft, target.top - actualTop) <= 0.5 ||
      (actualLeft === left && actualTop === top);
  };
  const animateCatchUp = () => {
    catchUpFrame = 0;
    const target = catchUp;
    if (!target) return;
    const done = approach(target, target.firstFrame ? 0.5 : 1, CATCH_UP_STEP_PX);
    target.firstFrame = false;
    if (done) catchUp = null;
    else catchUpFrame = window.requestAnimationFrame(animateCatchUp);
  };

  const finish = (cancelled = false) => {
    window.cancelAnimationFrame(firstFrame);
    firstFrame = 0;
    if (cancelled) stopCatchUp();
    if (gesture?.dragging) {
      if (!cancelled) {
        // Pointerup precedes click. Consume only that click, even if no click is dispatched.
        suppressClick = true;
        window.clearTimeout(clickTimer);
        clickTimer = window.setTimeout(() => { suppressClick = false; }, 0);
      }
    }
    gesture = null;
  };
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary || event.pointerType === 'touch') return;
    // A scrollbar drag starts on the root itself and belongs to the browser.
    if (event.target === root) return;
    stopCatchUp();
    window.clearTimeout(clickTimer);
    suppressClick = false;
    gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: root.scrollLeft,
      top: root.scrollTop,
      firstFrameSeen: false,
      dragging: false,
    };
  };
  const onMove = (event: PointerEvent) => {
    const active = gesture;
    if (!active || event.pointerId !== active.id) return;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    if (!active.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      active.dragging = true;
    }
    event.preventDefault();
    const left = active.left - dx;
    const top = active.top - dy;
    if (catchUp) {
      Object.assign(catchUp, { left, top });
      return;
    }
    if (!active.firstFrameSeen && Math.hypot(dx, dy) >= FAST_START_PX) {
      window.cancelAnimationFrame(firstFrame);
      firstFrame = 0;
      active.firstFrameSeen = true;
      catchUp = { left, top, firstFrame: true };
      // Show a response immediately, but leave enough distance for a visible next frame.
      approach(catchUp, 1, FIRST_STEP_PX, false);
      // A rAF callback runs before paint. Wait one full frame before catching up or the
      // small initial movement and the next step collapse into one visible jump.
      catchUpFrame = window.requestAnimationFrame(() => {
        catchUpFrame = window.requestAnimationFrame(animateCatchUp);
      });
      return;
    }
    // scrollLeft is signed in RTL; physical pointer movement works for either direction.
    root.scrollLeft = left;
    root.scrollTop = top;
    if (!firstFrame && !active.firstFrameSeen) firstFrame = window.requestAnimationFrame(() => {
      firstFrame = 0;
      active.firstFrameSeen = true;
    });
  };
  const onUp = (event: PointerEvent) => {
    if (gesture?.id === event.pointerId) finish();
  };
  const onCancel = (event: PointerEvent) => {
    if (gesture?.id === event.pointerId) finish(true);
  };
  const onClick = (event: MouseEvent) => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClick = false;
    window.clearTimeout(clickTimer);
  };
  const onSelectOrDrag = (event: Event) => {
    if (gesture) event.preventDefault();
  };
  const onBlur = () => finish(true);
  const onWheel = () => stopCatchUp();

  root.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerdown', stopCatchUp, true);
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('blur', onBlur);
  window.addEventListener('keydown', stopCatchUp, true);
  root.addEventListener('wheel', onWheel, { passive: true });
  root.addEventListener('click', onClick, true);
  root.addEventListener('selectstart', onSelectOrDrag);
  root.addEventListener('dragstart', onSelectOrDrag);
  return () => {
    finish(true);
    window.clearTimeout(clickTimer);
    root.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointerdown', stopCatchUp, true);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('keydown', stopCatchUp, true);
    root.removeEventListener('wheel', onWheel);
    root.removeEventListener('click', onClick, true);
    root.removeEventListener('selectstart', onSelectOrDrag);
    root.removeEventListener('dragstart', onSelectOrDrag);
  };
}
