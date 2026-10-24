import { useEffect, useRef, useState } from 'react';
import { Message } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { mutate } from 'swr';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import {
  offeredProviders,
  type LoginModel,
  type LoginState,
  type LoginStatus,
  type SubscriptionProvider,
} from '@/common/kyrn/login';
import { DEFAULT_MODEL_KEY } from '@/renderer/hooks/agent/useMuDefaultModel';
import { emitter } from '@/renderer/utils/emitter';
import { toMuError, type MuError } from '../fields/muError';
import { recheckMu } from '../recheck';
import { providerName } from './LoginWaiting';

type Account = LoginStatus['signedIn'][number];

/** Why a sign-in or sign-out did not work, for a screen to word in the app language. */
export type LoginFailure = {
  action: 'signIn' | 'signOut';
  /** The call's own failure, with the code the main process gave; unset when the flow itself reported an error. */
  error?: MuError;
  /** The raw words (the flow's error, the call's message): a detail line under the sentence. */
  detail: string;
};

export type SubscriptionLoginFlow = {
  /** What can be signed in to here, in the order shown: pi's own flows, and the harness's Google ones when it has them. */
  offered: SubscriptionProvider[];
  /** Who is signed in, with what each account can use. */
  accounts: Account[];
  account: (provider: SubscriptionProvider) => Account | undefined;
  /** The sign-in the main process runs now or ran last; undefined before the first one. */
  login: LoginState | undefined;
  running: boolean;
  /** Why the last sign-in or sign-out did not work; unset when it did. */
  failure: LoginFailure | undefined;
  /** The same, only when it was this provider's sign-in or sign-out. */
  failureOf: (provider: SubscriptionProvider) => LoginFailure | undefined;
  start: (provider: SubscriptionProvider) => void;
  cancel: () => void;
  answer: (value: string) => void;
  logout: (provider: SubscriptionProvider) => Promise<void>;
};

/**
 * The last status read, so a screen opened again starts from it instead of an empty list (reading it anew takes the
 * runner a second or two).
 */
let lastStatus: LoginStatus = { signedIn: [] };

/**
 * Subscription sign-in as a screen sees it. pi's OAuth flow runs in the main process; this reads who is signed in,
 * picks up a sign-in still running from an earlier visit, reads its state twice a second while it runs, and hears
 * of every finished one once (`onSignedIn`).
 */
export function useSubscriptionLogin(
  onSignedIn?: (provider: SubscriptionProvider, models: LoginModel[]) => void
): SubscriptionLoginFlow {
  const { t } = useTranslation();
  const [status, setStatus] = useState<LoginStatus>(lastStatus);
  useEffect(() => {
    lastStatus = status;
  }, [status]);
  const [login, setLogin] = useState<LoginState>();
  // A call that failed before any sign-in state came back, with whose call it was.
  const [problem, setProblem] = useState<{ provider?: SubscriptionProvider; failure?: LoginFailure }>({});
  const heard = useRef(onSignedIn);
  useEffect(() => {
    heard.current = onSignedIn;
  });

  useEffect(() => {
    let live = true;
    void kyrnBridge.loginStatus
      .invoke()
      .then(unwrap)
      .then((found) => live && setStatus(found))
      .catch((): undefined => undefined);
    void kyrnBridge.loginState
      .invoke()
      .then(unwrap)
      .then((found) => live && found.phase === 'running' && setLogin(found))
      .catch((): undefined => undefined);
    return () => {
      live = false;
    };
  }, []);

  // The flow moves on by itself (the browser calls back), so its state is read while it runs.
  const running = login?.phase === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      void kyrnBridge.loginState
        .invoke()
        .then(unwrap)
        .then(setLogin)
        .catch((): undefined => undefined);
    }, 500);
    return () => clearInterval(timer);
  }, [running]);

  const handled = useRef(0);
  useEffect(() => {
    if (!login || login.phase !== 'done' || !login.provider || handled.current === login.id) return;
    handled.current = login.id;
    const provider = login.provider;
    const models = login.models ?? [];
    setStatus((now) => ({
      ...now,
      signedIn: [...now.signedIn.filter((entry) => entry.provider !== provider), { provider, models }],
    }));
    heard.current?.(provider, models);
    void recheckMu();
  }, [login]);

  const failed = (provider: SubscriptionProvider | undefined, action: LoginFailure['action'], cause: unknown) => {
    const error = toMuError(cause);
    setProblem({ provider, failure: { action, error, detail: error.message } });
  };
  const call = async (provider: SubscriptionProvider | undefined, work: () => Promise<LoginState>) => {
    setProblem({});
    try {
      setLogin(await work());
    } catch (error) {
      failed(provider, 'signIn', error);
    }
  };
  const failedLogin: LoginFailure | undefined =
    login?.phase === 'failed' ? { action: 'signIn', detail: login.error || '' } : undefined;

  return {
    offered: offeredProviders(status),
    accounts: status.signedIn,
    account: (provider) => status.signedIn.find((entry) => entry.provider === provider),
    login,
    running,
    failure: problem.failure ?? failedLogin,
    failureOf: (provider) =>
      (problem.provider === provider ? problem.failure : undefined) ??
      (login?.provider === provider ? failedLogin : undefined),
    start: (provider) => {
      void call(provider, async () => unwrap(await kyrnBridge.loginStart.invoke({ provider })));
    },
    cancel: () => {
      // Cancelled after the credential was stored (a slow model list): who is signed in is read again, and mu checked.
      void call(login?.provider, async () => unwrap(await kyrnBridge.loginCancel.invoke())).then(() =>
        kyrnBridge.loginStatus
          .invoke()
          .then(unwrap)
          .then(setStatus)
          .then(() => recheckMu())
          .catch((): undefined => undefined)
      );
    },
    answer: (value) => {
      const reply = value.trim();
      if (!login || !reply) return;
      void call(login.provider, async () =>
        unwrap(await kyrnBridge.loginAnswer.invoke({ id: login.id, value: reply }))
      );
    },
    logout: async (provider) => {
      setProblem({});
      try {
        setStatus(unwrap(await kyrnBridge.loginLogout.invoke({ provider })));
      } catch (error) {
        failed(provider, 'signOut', error);
        return;
      }
      // mu is checked again, so every model list drops the account's models. Then the model new conversations start
      // on, and the conversations running on one of the account's models, go on with one mu still offers.
      await recheckMu();
      const moved = await kyrnBridge.loginSwitchModels
        .invoke({ provider })
        .then(unwrap)
        .catch((): undefined => undefined);
      if (!moved || (!moved.defaultMoved && !moved.conversations)) return;
      if (moved.defaultMoved) {
        void mutate(DEFAULT_MODEL_KEY);
        emitter.emit('mu.files.changed');
      }
      const name = providerName(t, provider);
      Message.info(
        moved.to
          ? t('mu.accounts.switched', { name, model: moved.to.name || moved.to.model })
          : t('mu.accounts.noModelLeft', { name })
      );
    },
  };
}
