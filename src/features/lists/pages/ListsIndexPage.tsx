/** `/lists`: opens the first list, or invites the user to create one. */

import { ListPlus, ListVideo } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router';

import { Button, EmptyState, ErrorState, Page, Skeleton, useShell } from '../deps';
import { useLists } from '../hooks/useLists';
import { listPath } from '../paths';
import { openCreateList } from '../store';

export function ListsIndexPage() {
  const { t, i18n } = useTranslation('lists');
  const lists = useLists();
  const shell = useShell();

  useEffect(() => {
    shell.setHeader({ title: t('title') });
  }, [i18n.language]);

  const first = lists.data?.[0];
  if (first) return <Navigate to={listPath(first.id)} replace />;

  return (
    // Under the header like the other Library pages' empty states (library-13), not centred in the
    // window, so moving between them does not make the content jump.
    <Page width="default" className="flex min-w-0 flex-col" data-testid="lists-index">
      <h1 className="sr-only">{t('title')}</h1>
      {lists.error ? (
        <ErrorState error={lists.error} title={t('loadFailed')} hint={t('localDataHint')} onRetry={() => lists.refetch()} />
      ) : !lists.data ? (
        <div className="flex w-full max-w-md flex-col gap-3" role="status" aria-busy="true" aria-label={t('loading')}>
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : (
        <EmptyState
          icon={<ListVideo className="size-7" />}
          title={t('emptyTitle')}
          description={t('emptyHint')}
          action={
            <Button variant="primary" icon={<ListPlus className="size-4" />} onClick={() => openCreateList({ openAfter: true })}>
              {t('createList')}
            </Button>
          }
        />
      )}
    </Page>
  );
}
