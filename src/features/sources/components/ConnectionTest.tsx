import { CircleAlert, CircleCheck, PlugZap } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ConnectionTestResult } from '@/api/rpc';
import { RpcError } from '@/api/transport';

import { Button } from '../_shim';
import { redactText } from '../lib/redact';

type TestState = { status: 'idle' } | { status: 'running' } | { status: 'done'; result: ConnectionTestResult } | { status: 'failed'; error: RpcError };

/**
 * "Test connection" button with an inline verdict. `run` returns null when the
 * form is invalid (errors are then shown on the fields).
 */
export function ConnectionTest({ run, disabled }: { run: () => Promise<ConnectionTestResult> | null; disabled?: boolean }) {
  const { t } = useTranslation('sources');
  const [state, setState] = useState<TestState>({ status: 'idle' });

  const onClick = async () => {
    const pending = run();
    if (!pending) {
      setState({ status: 'idle' });
      return;
    }
    setState({ status: 'running' });
    try {
      setState({ status: 'done', result: await pending });
    } catch (e) {
      setState({ status: 'failed', error: RpcError.from(e) });
    }
  };

  const ok = state.status === 'done' && state.result.ok;
  const raw =
    state.status === 'done'
      ? state.result.ok
        ? state.result.name
          ? t('testOkNamed', { name: state.result.name })
          : (state.result.message ?? t('testOk'))
        : (state.result.message ?? t('testFailedGeneric'))
      : state.status === 'failed'
        ? t('testError', { message: state.error.message })
        : null;
  // Portal messages can echo the request URL, password included.
  const message = raw === null ? null : redactText(raw);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        size="sm"
        variant="secondary"
        icon={<PlugZap aria-hidden className="size-4" />}
        loading={state.status === 'running'}
        disabled={disabled}
        onClick={() => void onClick()}
      >
        {state.status === 'running' ? t('testing') : t('testConnection')}
      </Button>
      <p aria-live="polite" className="flex min-w-0 items-center gap-1.5 text-sm">
        {message ? (
          <>
            {ok ? (
              <CircleCheck aria-hidden className="size-4 shrink-0 text-success" />
            ) : (
              <CircleAlert aria-hidden className="size-4 shrink-0 text-danger" />
            )}
            <span className={ok ? 'text-success' : 'text-danger'} data-testid="connection-test-result">
              {message}
            </span>
          </>
        ) : null}
      </p>
    </div>
  );
}
