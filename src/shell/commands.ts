/**
 * Command registry (SPEC C16) feeding the command palette. Features register
 * commands for as long as they are relevant:
 *
 *   useEffect(() => registerCommands([{ id: 'live.refresh', title, group: 'Live', run }]), [deps]);
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';

export interface Command {
  id: string;
  title: string;
  group: string;
  /** Combo shown as a hint (display only; bind it with useShortcut). */
  shortcut?: string;
  keywords?: string[];
  run(): void;
}

interface Registration {
  token: number;
  cmds: Command[];
}

let token = 0;
const registrations: Registration[] = [];
const listeners = new Set<() => void>();
let snapshot: Command[] = [];

function emit(): void {
  // Later registrations win on id collisions.
  const byId = new Map<string, Command>();
  for (const r of registrations) for (const c of r.cmds) byId.set(c.id, c);
  snapshot = [...byId.values()];
  for (const l of listeners) l();
}

/** Adds commands; returns a function that removes exactly these. */
export function registerCommands(cmds: Command[]): () => void {
  const reg: Registration = { token: ++token, cmds };
  registrations.push(reg);
  emit();
  return () => {
    const i = registrations.findIndex((r) => r.token === reg.token);
    if (i >= 0) {
      registrations.splice(i, 1);
      emit();
    }
  };
}

export const commandRegistry = {
  list(): Command[] {
    return snapshot;
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  reset(): void {
    registrations.splice(0, registrations.length);
    emit();
  },
};

export function useCommandList(): Command[] {
  return useSyncExternalStore(commandRegistry.subscribe, commandRegistry.list, commandRegistry.list);
}

/**
 * Registers commands for the component's lifetime. `run` callbacks always see
 * the latest closure; re-registers when ids/titles change.
 */
export function useCommands(cmds: Command[]): void {
  const ref = useRef(cmds);
  ref.current = cmds;
  const signature = cmds.map((c) => `${c.id}\u0000${c.title}\u0000${c.group}\u0000${c.shortcut ?? ''}`).join('\u0001');
  useEffect(
    () =>
      registerCommands(
        ref.current.map((c) => ({
          ...c,
          run: () => ref.current.find((x) => x.id === c.id)?.run(),
        })),
      ),
    [signature],
  );
}
