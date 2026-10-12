import { CircleAlert, CircleCheck, PlugZap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ConnectionTestResult } from '@/api/rpc';
import type { SourceKind } from '@/api/types';
import { RpcError } from '@/api/transport';

import { Button } from '@/ui';
import { importErrorCode, nextStepKey, summaryKey } from '../lib/errors';
import { redactText } from '../lib/redact';

type TestState = { status: 'idle' } | { status: 'running' } | { status: 'done'; result: ConnectionTestResult } | { status: 'failed'; error: RpcError };

/**
 * "Test connection" button with an inline verdict. `run` returns null when the
 * form is invalid (errors are then shown on the fields). `inputs` identifies the
 * tested details: when it changes, an earlier verdict no longer applies and is cleared.
 */
export function ConnectionTest({
  run,
  disabled,
  inputs,
  kind,
}: {
  run: () => Promise<ConnectionTestResult> | null;
  disabled?: boolean;
  inputs?: string;
  /** The tested source's kind, for sign-in advice that names its login. */
  kind?: SourceKind;
}) {
  const { t } = useTranslation('sources');
  const [state, setState] = useState<TestState>({ status: 'idle' });
  // Bumped on every run and input change, so a slow answer for older details is dropped.
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setState({ status: 'idle' });
  }, [inputs]);

  const onClick = async () => {
    const pending = run();
    const gen = ++generation.current;
    if (!pending) {
      setState({ status: 'idle' });
      return;
    }
    setState({ status: 'running' });
    try {
      const result = await pending;
      if (gen === generation.current) setState({ status: 'done', result });
    } catch (e) {
      if (gen === generation.current) setState({ status: 'failed', error: RpcError.from(e) });
    }
  };

  const ok = state.status === 'done' && state.result.ok;
  let message: string | null = null;
  let nextStep: string | null = null;
  let detail: string | null = null;
  if (state.status === 'done') {
    const r = state.result;
    if (r.ok) message = r.name ? t('testOkNamed', { name: r.name }) : (r.message ?? t('testOk'));
    else {
      message = r.message ?? t('testFailedGeneric');
      const code = importErrorCode(r.message);
      if (code !== 'internal') nextStep = t(nextStepKey({ code, message: r.message }, kind));
    }
  } else if (state.status === 'failed') {
    // The plain summary first; the core's own text (English, often technical) behind a disclosure.
    message = t(summaryKey(state.error));
    nextStep = t(nextStepKey(state.error, kind));
    detail = state.error.message;
  }

  return (
    <div className="flex flex-wrap items-start gap-3" data-testid="connection-test" data-status={state.status}>
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
      <div aria-live="polite" className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
        {message ? (
          <>
            <p className="flex min-w-0 items-center gap-1.5">
              {ok ? (
                <CircleCheck aria-hidden className="size-4 shrink-0 text-success" />
              ) : (
                <CircleAlert aria-hidden className="size-4 shrink-0 text-danger" />
              )}
              {/* Portal messages can echo the request URL, password included. */}
              <span className={ok ? 'break-words text-success' : 'break-words text-danger'} data-testid="connection-test-result">
                {redactText(message)}
              </span>
            </p>
            {nextStep ? (
              <p className="text-fg-muted" data-testid="connection-test-hint">
                {nextStep}
              </p>
            ) : null}
            {detail ? (
              <details className="text-xs text-fg-subtle">
                <summary className="w-fit cursor-pointer rounded-sm hover:text-fg-muted">{t('technicalDetails')}</summary>
                <p className="mt-1 break-words font-mono" dir="ltr">
                  {redactText(detail)}
                </p>
              </details>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
