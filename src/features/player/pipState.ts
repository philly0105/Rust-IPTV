import { create } from 'zustand';

/**
 * Whether window picture-in-picture is on (`./pip` drives it). On its own so the desktop shell's
 * window-geometry saver can read it without loading pip, which pulls in the player store.
 */
export const usePipStore = create<{ active: boolean }>(() => ({ active: false }));
