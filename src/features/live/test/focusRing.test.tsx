/** Focus stays visible: nothing in the live feature removes the outline without a ring in its place. */
import { cleanup, render, screen } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ContextMenu } from '../components/ContextMenu';

afterEach(cleanup);

const COMPONENTS = join(__dirname, '..', 'components');

describe('focus rings', () => {
  it('context menu items show a focus-visible ring in the focus color', () => {
    render(
      <ContextMenu
        pos={{ x: 10, y: 10 }}
        label="Channel 1"
        items={[
          { id: 'play', label: 'Play', onSelect: () => undefined },
          { id: 'fav', label: 'Favorite', onSelect: () => undefined },
        ]}
        onClose={() => undefined}
      />,
    );
    for (const item of screen.getAllByRole('menuitem')) {
      expect(item.className).toContain('focus-visible:ring-2');
      expect(item.className).toContain('focus-visible:ring-focus');
    }
    // the first item takes focus when the menu opens
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Play' }));
  });

  it('every outline-none in live components comes with a ring (inputs get theirs from a focus-within label)', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(COMPONENTS).filter((f) => f.endsWith('.tsx'))) {
      const src = readFileSync(join(COMPONENTS, file), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (!line.includes('outline-none')) return;
        if (/(focus-visible|focus):ring-2/.test(line)) return;
        // The channel menu's phone sheet takes focus as a whole, so that no item looks chosen. Like
        // the kit Dialog's panel it draws no ring around itself; its items carry theirs.
        if (file === 'ContextMenu.tsx' && line.includes('inset-x-0 bottom-0') && line.includes('focus-visible:shadow-3')) return;
        // A bare input inside a <label className="... focus-within:ring-2 ...">: the label draws the ring.
        const above = src.split('\n').slice(0, i).join('\n');
        const label = above.lastIndexOf('<label');
        const inside = label >= 0 && !above.slice(label).includes('</label>');
        if (inside && /^<label[^>]*focus-within:ring-2/.test(above.slice(label))) return;
        offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
