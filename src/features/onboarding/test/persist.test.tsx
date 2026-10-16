// saveOnboarding writes the markers through settings.update, moves the
// cached settings at once, refreshes only its own keys from the answer, and
// never rejects. ensureOnboardingStrings / useOnboardingStrings load the
// English strings on demand when the shell leaves them out of the entry.
import { act, cleanup, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider, initReactI18next } from 'react-i18next';

const rpcMock = vi.hoisted(() => ({ current: null as null | { call: (cmd: string, args?: unknown) => Promise<unknown> } }));
vi.mock('@/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/transport')>();
  const call = async (cmd: string, args?: unknown) => {
    try {
      return await rpcMock.current!.call(cmd, args);
    } catch (e) {
      throw actual.RpcError.from(e);
    }
  };
  return { ...actual, rpc: call, rpcRaw: call };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

const h = await import('./harness');
let core = h.createCore();
rpcMock.current = { call: (cmd, args) => core.call(cmd, args) };
const { saveOnboarding } = await import('../persist');
const { ensureOnboardingStrings, useOnboardingStrings } = await import('../strings');
const { queryClient, rpcKey } = await import('@/api/query');
const { DEFAULT_SETTINGS } = await import('@/api/types');

type S = typeof DEFAULT_SETTINGS;
const cached = () => queryClient.getQueryData<S>(rpcKey('settings.get'));

beforeEach(() => {
  h.resetShared();
  core = h.createCore();
});
afterEach(() => cleanup());

describe('saveOnboarding', () => {
  it('writes the patch and moves the cache before the core answers', async () => {
    queryClient.setQueryData(rpcKey('settings.get'), { ...DEFAULT_SETTINGS });
    const done = saveOnboarding({ tourCompleted: true });
    expect(cached()?.tourCompleted).toBe(true);
    await expect(done).resolves.toBe(true);
    expect(core.updates()).toEqual([{ tourCompleted: true }]);
    expect(core.state.settings.tourCompleted).toBe(true);
  });

  it('takes only its own keys from the answer', async () => {
    queryClient.setQueryData(rpcKey('settings.get'), { ...DEFAULT_SETTINGS, language: 'de' });
    core.state.settings = { ...DEFAULT_SETTINGS, language: 'fr' } as S;
    await saveOnboarding({ lastSeenVersion: '0.1.0' });
    expect(cached()?.lastSeenVersion).toBe('0.1.0');
    // An unrelated edit in the cache is not overwritten by the core's copy.
    expect(cached()?.language).toBe('de');
  });

  it('does not create a settings entry that was never loaded', async () => {
    await saveOnboarding({ tourCompleted: true });
    expect(cached()).toBeUndefined();
  });

  it('resolves false and warns when the core refuses, without rejecting', async () => {
    core.state.failUpdates = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    queryClient.setQueryData(rpcKey('settings.get'), { ...DEFAULT_SETTINGS });
    await expect(saveOnboarding({ lastSeenVersion: '0.1.0' })).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    // The cache keeps the new value, so this session does not ask again.
    expect(cached()?.lastSeenVersion).toBe('0.1.0');
  });

  it('skips an empty patch', async () => {
    await expect(saveOnboarding({})).resolves.toBe(true);
    expect(core.calls).toEqual([]);
  });
});

function bareI18n() {
  const i18n = i18next.createInstance();
  void i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['common'],
    defaultNS: 'common',
    resources: { en: { common: {} } },
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  return i18n;
}

describe('onboarding strings', () => {
  it('loads the English strings when the bundle is missing', async () => {
    const i18n = bareI18n();
    expect(i18n.t('whatsNewTitle', { ns: 'onboarding' })).toBe('whatsNewTitle');
    await ensureOnboardingStrings(i18n);
    expect(i18n.t('whatsNewTitle', { ns: 'onboarding' })).toBe("What's new");
  });

  it('resolves at once when they are already there', async () => {
    const i18n = bareI18n();
    await ensureOnboardingStrings(i18n);
    const again = ensureOnboardingStrings(i18n);
    await expect(again).resolves.toBeUndefined();
  });

  it('renders nothing until the strings are in, then the real text', async () => {
    const i18n = bareI18n();
    function Probe() {
      const { t, ready } = useOnboardingStrings();
      return ready ? <p data-testid="probe">{t('tourNext')}</p> : null;
    }
    render(
      <I18nextProvider i18n={i18n}>
        <Probe />
      </I18nextProvider>,
    );
    expect(screen.queryByTestId('probe')).toBeNull();
    await act(async () => {
      await ensureOnboardingStrings(i18n);
    });
    expect((await screen.findByTestId('probe')).textContent).toBe('Next');
  });

  it('is ready at once when the strings are bundled', () => {
    function Probe() {
      const { ready } = useOnboardingStrings();
      return <p data-testid="probe">{String(ready)}</p>;
    }
    render(
      <I18nextProvider i18n={h.i18n}>
        <Probe />
      </I18nextProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('true');
  });
});
