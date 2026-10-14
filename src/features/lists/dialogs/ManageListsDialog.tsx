/**
 * "Manage lists": every list in order, with rename (inline), Show on Home,
 * Edit channels and Delete (with Undo in the toast). Rows reorder by drag or
 * with Alt+ArrowUp / Alt+ArrowDown on a focused row.
 */

import { LayoutDashboard, ListOrdered, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';

import type { CustomList } from '@/api/types';

import { Button, Dialog, EmptyState, ErrorState, IconButton, Skeleton, cn } from '../deps';
import { NewListForm } from '../components/NewListForm';
import { SortableList } from '../components/SortableList';
import { useListActions } from '../hooks/useListActions';
import { useLists } from '../hooks/useLists';
import { MAX_LISTS, MAX_NAME, errorText, move, nameProblem } from '../lib/cache';
import { listPath } from '../paths';
import { openEditListItems } from '../store';

export function ManageListsDialog({ focusId, onClose }: { focusId?: string; onClose(): void }) {
  const { t, i18n } = useTranslation('lists');
  const { t: tc } = useTranslation('common');
  const lists = useLists();
  const actions = useListActions();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [renaming, setRenaming] = useState<{ id: string; value: string; error: string | null; busy: boolean } | null>(null);
  const fmt = new Intl.NumberFormat(i18n.language);
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<{ id?: string; part: string } | null>(null);

  // Start on the list the dialog was opened for.
  const startedOn = useRef(false);
  useEffect(() => {
    if (startedOn.current || !focusId || !lists.data) return;
    startedOn.current = true;
    bodyRef.current?.querySelector<HTMLElement>(`[data-sort-key="${CSS.escape(focusId)}"] [data-sort-part="name"]`)?.focus();
  }, [focusId, lists.data]);

  // After a rename or delete, focus lands somewhere sensible instead of the dialog itself.
  useLayoutEffect(() => {
    const want = focusAfter.current;
    if (!want || !bodyRef.current) return;
    focusAfter.current = null;
    const scope = want.id ? bodyRef.current.querySelector(`[data-sort-key="${CSS.escape(want.id)}"]`) : null;
    const el =
      scope?.querySelector<HTMLElement>(`[data-sort-part="${want.part}"]`) ??
      bodyRef.current.querySelector<HTMLElement>('[data-sort-part="delete"]') ??
      bodyRef.current.querySelector<HTMLElement>('input');
    el?.focus();
  });

  const items = lists.data ?? [];

  const submitRename = async (e: FormEvent, list: CustomList) => {
    e.preventDefault();
    if (!renaming || renaming.busy) return;
    const problem = nameProblem(renaming.value, items, list.id);
    if (problem) {
      setRenaming({ ...renaming, error: t(problem, { max: MAX_NAME }) });
      return;
    }
    setRenaming({ ...renaming, busy: true, error: null });
    const ok = await actions.rename(list, renaming.value).catch((err: unknown) => {
      setRenaming((r) => r && { ...r, busy: false, error: errorText(err, t) });
      return false;
    });
    if (ok) {
      focusAfter.current = { id: list.id, part: 'rename' };
      setRenaming(null);
    } else setRenaming((r) => r && { ...r, busy: false });
  };

  const remove = (list: CustomList, index: number) => {
    const next = items[index + 1] ?? items[index - 1];
    focusAfter.current = { id: next?.id, part: 'delete' };
    const viewing = pathname === listPath(list.id);
    actions.remove(list, (restored) => {
      // Undo gives the list a new id: follow it when its page was open.
      if (viewing) void navigate(listPath(restored.id), { replace: true });
    });
  };

  let body;
  if (lists.error) {
    body = <ErrorState size="inline" error={lists.error} title={t('loadFailed')} onRetry={() => void lists.refetch()} />;
  } else if (!lists.data) {
    body = (
      <div className="flex flex-col gap-2" role="status" aria-busy="true" aria-label={t('loading')}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-11 w-full rounded-md" />
        ))}
      </div>
    );
  } else if (items.length === 0) {
    body = <EmptyState size="inline" icon={<ListOrdered className="size-6" />} title={t('emptyTitle')} description={t('emptyHint')} />;
  } else {
    body = (
      <SortableList<CustomList>
        items={items}
        label={t('title')}
        testId="manage-lists"
        getKey={(l) => l.id}
        getLabel={(l) => l.name}
        locked={(l) => renaming?.id === l.id}
        onMove={(from, to) => actions.reorder(move(items, from, to))}
        renderRow={(list, index) =>
          renaming?.id === list.id ? (
            <form className="flex min-w-0 flex-1 flex-col gap-1" onSubmit={(e) => void submitRename(e, list)} noValidate>
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={renaming.value}
                  data-sort-part="name"
                  aria-label={t('renameLabel', { list: list.name })}
                  aria-invalid={renaming.error ? true : undefined}
                  maxLength={MAX_NAME * 2}
                  onChange={(e) => setRenaming({ ...renaming, value: e.target.value, error: null })}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      e.stopPropagation();
                      focusAfter.current = { id: list.id, part: 'rename' };
                      setRenaming(null);
                    }
                  }}
                  className={cn(
                    'h-9 min-w-0 flex-1 rounded-md border bg-surface-2 px-2.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    renaming.error ? 'border-danger' : 'border-border',
                  )}
                />
                <Button type="submit" size="sm" variant="primary" loading={renaming.busy}>
                  {tc('save')}
                </Button>
              </div>
              {renaming.error ? (
                <p className="text-xs text-danger" role="alert">
                  {renaming.error}
                </p>
              ) : null}
            </form>
          ) : (
            <>
              <Link
                to={listPath(list.id)}
                onClick={onClose}
                data-sort-part="name"
                className="flex min-w-0 flex-1 flex-col rounded-md px-1.5 py-1 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span dir="auto" className="truncate text-sm font-medium text-fg">
                  {list.name}
                </span>
                <span className="text-xs tabular-nums text-fg-subtle">{t('channelCount', { count: list.itemCount, formatted: fmt.format(list.itemCount) })}</span>
              </Link>
              <IconButton
                size="sm"
                variant="ghost"
                data-sort-part="home"
                pressed={list.onDashboard}
                label={t('showOnHome', { list: list.name })}
                title={list.onDashboard ? t('onHome') : t('notOnHome')}
                icon={<LayoutDashboard className={cn('size-4', list.onDashboard && 'text-accent')} />}
                onClick={() => actions.setOnDashboard(list, !list.onDashboard)}
              />
              <IconButton
                size="sm"
                variant="ghost"
                data-sort-part="items"
                label={t('editChannelsOf', { list: list.name })}
                icon={<ListOrdered className="size-4" />}
                onClick={() => openEditListItems(list.id, { fromManage: true })}
              />
              <IconButton
                size="sm"
                variant="ghost"
                data-sort-part="rename"
                label={t('renameLabel', { list: list.name })}
                icon={<Pencil className="size-4" />}
                onClick={() => setRenaming({ id: list.id, value: list.name, error: null, busy: false })}
              />
              <IconButton
                size="sm"
                variant="ghost"
                data-sort-part="delete"
                label={t('deleteLabel', { list: list.name })}
                icon={<Trash2 className="size-4" />}
                className="hover:text-danger"
                onClick={() => remove(list, index)}
              />
            </>
          )
        }
      />
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('manageLists')}
      description={t('reorderHint')}
      size="md"
      testId="manage-lists-dialog"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-xs tabular-nums text-fg-subtle">{lists.data ? t('listsUsed', { used: fmt.format(items.length), max: fmt.format(MAX_LISTS) }) : ''}</span>
          <Button variant="primary" size="sm" onClick={onClose}>
            {t('done')}
          </Button>
        </div>
      }
    >
      <div ref={bodyRef}>
        {body}
        <div className="mt-3 border-t border-divider pt-3">
          <NewListForm lists={lists.data} autoFocus={!focusId && items.length === 0} />
        </div>
      </div>
    </Dialog>
  );
}
