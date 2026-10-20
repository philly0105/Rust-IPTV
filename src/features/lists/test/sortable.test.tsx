// SortableList on a long list (LV-6): a drag-over re-renders the rows whose drop marker changes,
// not every row, and a drop still moves the dragged row.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SortableList } from '../components/SortableList';
import { i18n } from './harness';

afterEach(cleanup);

const ITEMS = Array.from({ length: 2000 }, (_, i) => ({ id: `c${i}`, name: `Channel ${i}` }));

function renderList(onMove = vi.fn()) {
  const rendered: number[] = [];
  render(
    <I18nextProvider i18n={i18n}>
      <SortableList<(typeof ITEMS)[number]>
        items={ITEMS}
        label="Sports"
        testId="sortable"
        getKey={(x) => x.id}
        getLabel={(x) => x.name}
        onMove={onMove}
        renderRow={(x, index) => {
          rendered.push(index);
          return <span>{x.name}</span>;
        }}
      />
    </I18nextProvider>,
  );
  return { rendered, onMove };
}

const rowOf = (index: number) => screen.getByTestId('sortable').children[index] as HTMLElement;
const dataTransfer = () => ({ effectAllowed: '', dropEffect: '', setData: () => undefined });

describe('SortableList drag and drop (LV-6)', () => {
  it('a drag-over re-renders only the rows whose marker changes, and the drop moves the row', () => {
    const { rendered, onMove } = renderList();
    expect(rendered).toHaveLength(ITEMS.length);
    rendered.length = 0;
    const grip = within(rowOf(0)).getAllByRole('button')[0]!;
    fireEvent.dragStart(grip, { dataTransfer: dataTransfer() });
    // The dragged row dims.
    expect(rendered).toEqual([0]);
    rendered.length = 0;
    fireEvent.dragOver(rowOf(5), { dataTransfer: dataTransfer() });
    expect(rendered).toEqual([5]);
    rendered.length = 0;
    fireEvent.dragOver(rowOf(6), { dataTransfer: dataTransfer() });
    expect(rendered.sort((a, b) => a - b)).toEqual([5, 6]);
    // The marker is a mark: the accent's mark tone, not the text tone (brown in light).
    const marker = within(rowOf(6)).getByTestId('drop-marker');
    expect(marker.className.split(/\s+/)).toContain('bg-accent-mark');
    expect(marker.className.split(/\s+/)).not.toContain('bg-accent');
    fireEvent.drop(rowOf(6), { dataTransfer: dataTransfer() });
    // jsdom rows have no height, so the pointer is past the middle: after row 6.
    expect(onMove).toHaveBeenCalledWith(0, 6);
  });
});
