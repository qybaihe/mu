import React from 'react';
import { Button, Popconfirm, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { LEGACY_PROVIDERS, type SubscriptionProvider } from '@/common/kyrn/login';
import ProviderMark from '@renderer/components/brand/ProviderMark';
import { ProviderHead } from '../providers/parts';
import providerStyles from '../providers/providers.module.css';
import LoginWaiting, { ExperimentalTag, LoginProblem, providerName } from './LoginWaiting';
import type { SubscriptionLoginFlow } from './useSubscriptionLogin';

type AccountDetailProps = {
  provider: SubscriptionProvider;
  flow: SubscriptionLoginFlow;
  /** What mu reported for this id while nobody is signed in: usable through an API key (OpenAI, Grok). */
  byKey?: { models: { id: string; name: string }[] };
  /** Opens the provider whose sign-in is running, when it is another one. */
  onShow: (provider: SubscriptionProvider) => void;
};

/**
 * One subscription in the right pane: signed in or not, signing in or out (at once, outside the save bar: the
 * credential is pi's, in its own store), and what the account can use.
 */
export default function AccountDetail({ provider, flow, byKey, onShow }: AccountDetailProps) {
  const { t } = useTranslation();
  const account = flow.account(provider);
  const { login } = flow;
  const busy = flow.running && login?.provider === provider;
  // One sign-in runs at a time: another one's question or code is on its own pane.
  const other = flow.running && login?.provider && login.provider !== provider ? login.provider : undefined;
  const name = providerName(t, provider);
  // A sign-in mu no longer offers: shown while an account is signed in with it, to be signed out.
  const legacy = LEGACY_PROVIDERS.includes(provider);
  const state = busy
    ? 'mu.welcome.login.inProgress'
    : account
      ? 'mu.welcome.login.signedIn'
      : byKey
        ? 'mu.accounts.byKey'
        : 'mu.accounts.signedOut';
  const models = account?.models ?? byKey?.models ?? [];

  return (
    <div className={providerStyles.editor} data-testid={`mu-account-${provider}`}>
      <ProviderHead
        mark={<ProviderMark provider={provider} size={20} />}
        title={name}
        badges={
          <>
            <ExperimentalTag provider={provider} />
            <Tag size='small' data-testid='mu-account-state'>
              {t(state)}
            </Tag>
          </>
        }
        actions={
          account ? (
            <Popconfirm
              title={t('mu.accounts.signOutConfirm', { name })}
              okText={t('mu.accounts.signOut')}
              onOk={() => void flow.logout(provider)}
            >
              <Button size='small' data-testid={`mu-account-signout-${provider}`} disabled={flow.running}>
                {t('mu.accounts.signOut')}
              </Button>
            </Popconfirm>
          ) : legacy ? null : (
            <Button
              size='small'
              type='primary'
              data-testid={`mu-account-signin-${provider}`}
              loading={busy}
              disabled={flow.running && !busy}
              onClick={() => flow.start(provider)}
            >
              {t('mu.accounts.signIn')}
            </Button>
          )
        }
      />
      <div className={providerStyles.fields}>
        <div className={providerStyles.field}>
          <div className={providerStyles.value}>{t(`mu.welcome.login.providers.${provider}.plan`)}</div>
          {byKey ? <div className={providerStyles.hint}>{t('mu.accounts.byKeyHelp')}</div> : null}
          {legacy ? (
            <div className={providerStyles.hint} data-testid='mu-account-legacy'>
              {t(`mu.accounts.legacy.${provider}`)}
            </div>
          ) : null}
        </div>
        {other ? (
          <div className={providerStyles.hint} data-testid='mu-account-other'>
            {t('mu.accounts.otherRunning', { name: providerName(t, other) })}{' '}
            <Button size='mini' type='text' onClick={() => onShow(other)}>
              {t('mu.accounts.showRunning')}
            </Button>
          </div>
        ) : null}
        {busy && login?.provider ? (
          <LoginWaiting
            key={login.id}
            login={{ ...login, provider: login.provider }}
            onAnswer={flow.answer}
            onCancel={flow.cancel}
          />
        ) : null}
        <LoginProblem failure={flow.failureOf(provider)} />
        {models.length ? (
          <div className={providerStyles.field}>
            <div className={providerStyles.label}>{t('mu.accounts.models')}</div>
            <div className={providerStyles.suggestions}>
              {models.map((model) => (
                <Tag key={model.id} size='small'>
                  {model.name || model.id}
                </Tag>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
