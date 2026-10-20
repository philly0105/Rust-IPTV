import { Eye, EyeOff } from 'lucide-react';
import { useState, type InputHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton, Input, cn } from '@/ui';

export interface SecretInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** The show and hide button's names; "Show password" and "Hide password" by default. */
  showLabel?: string;
  hideLabel?: string;
  /** Classes for the wrapper (its width in a row of controls). */
  wrapperClassName?: string;
}

/**
 * Password-style input with a show/hide toggle: source passwords, and the TMDB key in Settings
 * (SS-9), so every secret field looks and behaves the same.
 */
export function SecretInput({ showLabel, hideLabel, className, wrapperClassName, disabled, ...props }: SecretInputProps) {
  const { t } = useTranslation('sources');
  const [shown, setShown] = useState(false);
  return (
    <div className={cn('relative', wrapperClassName)}>
      <Input {...props} disabled={disabled} type={shown ? 'text' : 'password'} autoComplete="off" spellCheck={false} className={cn('pe-11', className)} />
      <div className="absolute inset-y-0 end-0.5 flex items-center">
        <IconButton
          label={shown ? (hideLabel ?? t('hideSecret')) : (showLabel ?? t('showSecret'))}
          icon={shown ? <EyeOff aria-hidden size={16} /> : <Eye aria-hidden size={16} />}
          aria-pressed={shown}
          disabled={disabled}
          onClick={() => setShown((s) => !s)}
        />
      </div>
    </div>
  );
}
