/**
 * Parental controls UI (contract C2). The shell mounts `ParentalGateHost`
 * and calls `useParentalEvents` once; players, multi-view and detail pages
 * call `ensureUnlocked` before locked content plays or opens; context menus
 * add `useLockMenuItems`; settings registers `ParentalSection` as `parental`.
 */

export { ensureUnlocked, removalMayNeedPin, requestPin, unlockToRemoveSources } from './gate';
export type { ParentalGateItem } from './gate';
export { ParentalGateHost } from './GateHost';
export { useLockMenuItems } from './lockMenu';
export { ParentalSection } from './ParentalSection';
export { PinDialog } from './PinDialog';
export type { PinDialogProps } from './PinDialog';
export { SetPinDialog } from './SetPinDialog';
export type { SetPinDialogProps } from './SetPinDialog';
export { lockNow, useParentalEvents, useParentalStatus } from './status';
