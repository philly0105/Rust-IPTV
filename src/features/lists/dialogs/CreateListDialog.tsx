/** "New list": a name, then either open the new list or stay put with a toast that can open it. */

import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import type { Channel } from '@/api/types';

import { Button, Dialog, displayChannelName, useDisplayPrefs, useToast } from '../deps';
import { NewListForm } from '../components/NewListForm';
import { useLists } from '../hooks/useLists';
import { MAX_NAME } from '../lib/cache';
import { listPath } from '../paths';

export function CreateListDialog({ channel, openAfter, onClose }: { channel?: Channel; openAfter: boolean; onClose(): void }) {
  const { t } = useTranslation('lists');
  const { t: tc } = useTranslation('common');
  const { toast } = useToast();
  const navigate = useNavigate();
  const prefs = useDisplayPrefs();
  const lists = useLists();

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('newList')}
      description={channel ? t('startsWith', { name: displayChannelName(channel.name, prefs.stripCountryPrefix) }) : t('nameHint', { max: MAX_NAME })}
      size="sm"
      testId="list-create"
      footer={
        <Button variant="ghost" size="sm" onClick={onClose}>
          {tc('cancel')}
        </Button>
      }
    >
      <NewListForm
        lists={lists.data}
        channel={channel}
        autoFocus
        onCreated={(list) => {
          onClose();
          if (openAfter) {
            void navigate(listPath(list.id));
            return;
          }
          toast({
            title: t('created', { list: list.name }),
            variant: 'success',
            action: { label: t('open'), onClick: () => void navigate(listPath(list.id)) },
          });
        }}
      />
    </Dialog>
  );
}
