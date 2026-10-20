/**
 * Parental gate seam (contract C2). Multi-view asks `ensureUnlocked` before a channel goes on
 * the wall and before a locked tile plays (Ask mode); a tile hidden in Hide mode unlocks the
 * session through `requestPin`. Tests replace this one module.
 *
 * From the gate module, not the `@/features/parental` barrel: the barrel also holds the parental
 * settings section, and through it the settings components, which then became part of Home's
 * and the guide's first load (they add channels to the wall).
 */

export { ensureUnlocked, requestPin } from '@/features/parental/gate';
