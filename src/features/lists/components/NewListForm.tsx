/**
 * The inline "New list" field: name, Create, and the core's rules checked as
 * the user types (empty, too long, a name already taken, the 50-list limit).
 */

import { Plus } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel, CustomList } from '@/api/types';

import { Button, cn } from '../deps';
import { useListActions } from '../hooks/useListActions';
import { MAX_LISTS, MAX_NAME, errorText, nameProblem } from '../lib/cache';

export interface NewListFormProps {
  lists: readonly CustomList[] | undefined;
  /** The new list starts with this channel. */
  channel?: Channel;
  onCreated?(list: CustomList): void;
  autoFocus?: boolean;
  className?: string;
}

export function NewListForm({ lists, channel, onCreated, autoFocus, className }: NewListFormProps) {
  const { t } = useTranslation('lists');
  const actions = useListActions();
  const id = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const atLimit = (lists?.length ?? 0) >= MAX_LISTS;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy || atLimit) return;
    const problem = nameProblem(name, lists);
    if (problem) {
      setError(t(problem, { max: MAX_NAME }));
      return;
    }
    setBusy(true);
    try {
      const list = await actions.create(name, channel);
      setName('');
      setError(null);
      onCreated?.(list);
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  if (atLimit) {
    return (
      <p className={cn('rounded-md bg-surface-2 px-3 py-2 text-sm text-fg-muted', className)} role="note">
        {t('errorTooMany', { max: MAX_LISTS })}
      </p>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className={cn('flex flex-col gap-1', className)} noValidate>
      <label htmlFor={id} className="sr-only">
        {t('newListName')}
      </label>
      <div className="flex items-stretch gap-2">
        <input
          id={id}
          value={name}
          maxLength={MAX_NAME * 2}
          autoComplete="off"
          spellCheck={false}
          data-autofocus={autoFocus ? '' : undefined}
          placeholder={t('newListName')}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          className={cn(
            'h-9 min-w-0 flex-1 rounded-md border bg-surface-2 px-3 text-sm text-fg outline-none placeholder:text-fg-subtle focus-visible:ring-2 focus-visible:ring-focus',
            error ? 'border-danger' : 'border-border',
          )}
        />
        <Button type="submit" size="sm" variant="secondary" icon={<Plus className="size-4" />} loading={busy} className="h-9">
          {t('create')}
        </Button>
      </div>
      {error ? (
        <p id={`${id}-err`} className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
