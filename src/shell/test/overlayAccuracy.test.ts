import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SEEK_STEP } from '@/features/player/usePlaybackShortcuts';

import { DOCUMENTED_SHORTCUTS, SHORTCUT_AREA_KEYS, groupShortcuts, shortcutHaystack, shortcutReference } from '../ShortcutOverlay';
import { normalizeCombo } from '../shortcuts';

const ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const combosIn = (src: string) => [...src.matchAll(/useShortcut\(\s*'([^']+)'/g)].map((m) => normalizeCombo(m[1]!));

describe('shortcut overlay accuracy', () => {
  const documented = new Set(DOCUMENTED_SHORTCUTS.map((d) => normalizeCombo(d.combo)));

  it('documents every playback shortcut the player binds', () => {
    const bound = combosIn(read('src/features/player/usePlaybackShortcuts.ts'));
    expect(bound.length).toBeGreaterThan(8);
    for (const c of bound) expect(documented, `overlay documents ${c}`).toContain(c);
  });

  it('documents every global shell shortcut and the Live TV ones', () => {
    const bound = [...combosIn(read('src/shell/ShellLayout.tsx')), 'mod+b', 'digit', '/'];
    for (const c of bound) expect(documented, `overlay documents ${c}`).toContain(c);
  });

  it('documents every combo any source file binds through the registry', () => {
    // Walks all of src, so a shortcut added anywhere fails here until the overlay lists it.
    const files: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name !== 'test' && e.name !== 'node_modules') walk(child);
        } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(child);
      }
    };
    walk('src');
    const bound = new Map<string, string>();
    for (const f of files) {
      const src = read(f);
      for (const m of src.matchAll(/(?:useShortcut|shortcutRegistry\.register)\(\s*'([^']+)'/g)) bound.set(normalizeCombo(m[1]!), f);
    }
    expect(bound.size).toBeGreaterThan(20);
    for (const [c, f] of bound) expect(documented, `${f}: ${c}`).toContain(c);
  });

  it('documents the keys the channel list, seek bar and library rows handle themselves', () => {
    const has = (combo: string, area: string) => DOCUMENTED_SHORTCUTS.some((d) => d.combo === combo && d.area === area);
    for (const c of ['s', 'shift+f10', 'contextmenu']) expect(has(c, 'Live'), c).toBe(true);
    for (const c of ['pageup', 'pagedown', 'home', 'end']) expect(has(c, 'Seek bar'), c).toBe(true);
    for (const c of ['home', 'end', 'pageup', 'pagedown', 'delete', 'arrowleft']) expect(has(c, 'Dialogs and lists'), c).toBe(true);
    expect(has('n', 'Playback')).toBe(true);
  });

  it('every documented description key exists in English', () => {
    for (const d of DOCUMENTED_SHORTCUTS) {
      const [ns, key] = d.descKey.includes(':') ? d.descKey.split(':') : ['shell', d.descKey];
      const en = JSON.parse(read(`src/i18n/en/${ns}.json`)) as Record<string, string>;
      expect(en[key!], d.descKey).toBeTruthy();
    }
  });

  it('documents every useShortcut combo registered by a feature page', () => {
    for (const file of [
      'src/features/sources/SourcesPage.tsx',
      'src/features/library/pages/DownloadsPage.tsx',
      'src/features/library/pages/FavoritesPage.tsx',
      'src/features/library/pages/MyVideoDetailPage.tsx',
      'src/features/live/components/LivePage.tsx',
    ]) {
      const bound = combosIn(read(file));
      expect(bound.length, file).toBeGreaterThan(0);
      for (const c of bound) expect(documented, `${file}: ${c}`).toContain(c);
    }
    for (const c of ['shift+arrowleft', 'shift+arrowright']) expect(documented, c).toContain(c);
  });

  it('every area has a namespaced label key that exists in English', () => {
    for (const d of DOCUMENTED_SHORTCUTS) {
      const key = SHORTCUT_AREA_KEYS[d.area];
      expect(key, d.area).toMatch(/^\w+:\w+$/);
      const [ns, k] = key!.split(':');
      const en = JSON.parse(read(`src/i18n/en/${ns}.json`)) as Record<string, string>;
      expect(en[k!], key).toBeTruthy();
    }
  });

  it('shows every documented area under its translated label, never the raw id', () => {
    // An area missing from SHORTCUT_AREA_KEYS would come back as its English id, without the marker.
    const groups = shortcutReference([], (k) => `<${k}>`);
    expect(groups.length).toBeGreaterThan(0);
    for (const [area] of groups) expect(area, area).toMatch(/^</);
  });

  it('states the seek bar large step (30 s) in every locale', () => {
    const dir = join(ROOT, 'src', 'i18n');
    for (const l of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const json = JSON.parse(readFileSync(join(dir, l.name, 'shell.json'), 'utf8')) as Record<string, string>;
      for (const key of ['scSeekBackLarge', 'scSeekForwardLarge']) expect(json[key], `${l.name}.${key}`).toContain('30');
    }
  });

  it('documents Escape for going back in movie and series views', () => {
    expect(DOCUMENTED_SHORTCUTS.some((d) => d.combo === 'escape' && d.area === 'Vod' && d.descKey === 'scVodBack')).toBe(true);
  });

  it('documents Escape for leaving picture-in-picture', () => {
    expect(DOCUMENTED_SHORTCUTS.some((d) => d.combo === 'escape' && d.area === 'Playback' && d.descKey === 'player:exitPip')).toBe(true);
  });

  it('states the real seek step in every locale', () => {
    const dir = join(ROOT, 'src', 'i18n');
    const locales = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(locales.length).toBe(19);
    for (const l of locales) {
      const json = JSON.parse(readFileSync(join(dir, l.name, 'shell.json'), 'utf8')) as Record<string, string>;
      for (const key of ['scSeekBack', 'scSeekForward']) {
        expect(json[key], `${l.name}.${key}`).toContain(String(SEEK_STEP));
        expect(json[key], `${l.name}.${key}`).not.toMatch(/(^|\D)5(\D|$)/);
      }
    }
  });

  it('merges a feature area registered under its translated name with the documented area', () => {
    const label = (a: string) => (a === 'Live' ? 'Live TV' : a);
    const groups = groupShortcuts(
      [{ combo: 'mod+b', description: 'Toggle sidebar (live)', area: 'Live TV' }],
      [
        { combo: 'mod+b', description: 'Sidebar (doc)', area: 'Live' },
        { combo: 'digit', description: 'Digits (doc)', area: 'Live' },
        { combo: 'mod+k', description: 'Palette', area: 'Global' },
      ],
      label,
    );
    expect(groups.map(([a]) => a)).toEqual(['Global', 'Live TV']);
    const live = groups.find(([a]) => a === 'Live TV')![1];
    expect(live.map((s) => s.description)).toEqual(['Toggle sidebar (live)', 'Digits (doc)']);
  });

  it('the filter matches printed key names, not only the combo syntax', () => {
    expect(shortcutHaystack({ combo: 'mod+k', description: 'Palette', area: 'Global' })).toContain('ctrl');
    expect(shortcutHaystack({ combo: 'pageup', description: 'Previous channel', area: 'Playback' })).toContain('pgup');
  });
});
