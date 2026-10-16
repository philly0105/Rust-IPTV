/**
 * Parental gate seam (contract C2). Multi-view asks `ensureUnlocked` before a channel goes on
 * the wall and before a locked tile plays (Ask mode); a tile hidden in Hide mode unlocks the
 * session through `requestPin`. Tests replace this one module.
 */

export { ensureUnlocked, requestPin } from '@/features/parental';
