import { Eye, EyeOff } from 'lucide-react';
import { useState, type InputHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton, Input } from '@/ui';

/** Password-style input with a show/hide toggle. */
export function SecretInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const { t } = useTranslation('sources');
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={shown ? 'text' : 'password'} autoComplete="off" spellCheck={false} className="pr-11" />
      <div className="absolute inset-y-0 right-0.5 flex items-center">
        <IconButton
          label={shown ? t('hideSecret') : t('showSecret')}
          icon={shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
        />
      </div>
    </div>
  );
}
