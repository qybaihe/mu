import React from 'react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import type { SubscriptionProvider } from '@/common/kyrn/login';
import MuSelect from '@/renderer/components/base/MuSelect';
import ProviderMark from '@renderer/components/brand/ProviderMark';
import LoginWaiting, {
  ExperimentalTag,
  LoginProblem,
  providerName,
} from '@/renderer/pages/settings/KyrnSettings/accounts/LoginWaiting';
import { useSubscriptionLogin } from '@/renderer/pages/settings/KyrnSettings/accounts/useSubscriptionLogin';
import choiceStyles from '@/renderer/pages/settings/KyrnSettings/sections/sections.module.css';
import styles from './Welcome.module.css';

type Props = {
  /** The account and model chosen, as `provider/model`; empty while none is. */
  value: string;
  onChange: (value: string) => void;
};

/**
 * Signing in with a subscription instead of an API key: ChatGPT, Claude, Grok, and Google (experimental, when the
 * harness has it). One button per service, with its mark; a button of a service not signed in to starts the sign-in
 * in the browser. Once an account is signed in, its model is picked here (pi's own starting model for that service
 * first).
 */
export default function SubscriptionLogin({ value, onChange }: Props) {
  const { t } = useTranslation();
  const flow = useSubscriptionLogin((provider, models) => {
    if (models[0]) onChange(`${provider}/${models[0].id}`);
  });
  const { login, running } = flow;
  const chosen = value.split('/')[0] as SubscriptionProvider | '';

  const pick = (provider: SubscriptionProvider) => {
    const account = flow.account(provider);
    if (!account) return flow.start(provider);
    if (chosen !== provider && account.models[0]) onChange(`${provider}/${account.models[0].id}`);
  };
  const account = chosen ? flow.account(chosen) : undefined;

  return (
    <div className={styles.login}>
      <div className={styles.accounts}>
        {flow.offered.map((provider) => {
          const signedIn = Boolean(flow.account(provider));
          const busy = running && login?.provider === provider;
          return (
            <button
              key={provider}
              type='button'
              data-testid={`mu-login-${provider}`}
              className={classNames(styles.account, chosen === provider && signedIn && styles.accountActive)}
              disabled={running && !busy}
              onClick={() => pick(provider)}
            >
              <span className={styles.accountMark}>
                <ProviderMark provider={provider} size={22} />
              </span>
              <span className={styles.accountText}>
                <span className={styles.accountName}>
                  {providerName(t, provider)}
                  <ExperimentalTag provider={provider} />
                </span>
                <span className={classNames(styles.accountPlan, signedIn && !busy && styles.accountReady)}>
                  {busy
                    ? t('mu.welcome.login.inProgress')
                    : signedIn
                      ? t('mu.welcome.login.signedIn')
                      : t(`mu.welcome.login.providers.${provider}.plan`)}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {running && login?.provider ? (
        <LoginWaiting
          key={login.id}
          login={{ ...login, provider: login.provider }}
          onAnswer={flow.answer}
          onCancel={flow.cancel}
        />
      ) : null}
      <LoginProblem failure={flow.failure} />

      {account && account.models.length ? (
        <div className={choiceStyles.choiceField}>
          <label className={choiceStyles.choiceLabel}>{t('mu.welcome.model.model')}</label>
          <MuSelect
            showSearch
            aria-label={t('mu.welcome.model.model')}
            value={value}
            options={account.models.map((model) => ({ value: `${account.provider}/${model.id}`, label: model.name }))}
            onChange={(next: string) => onChange(next)}
          />
        </div>
      ) : null}
    </div>
  );
}
