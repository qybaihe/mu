import React, { useState } from 'react';
import { Button, Input } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  isGoogleProvider,
  isRiskConsent,
  type LoginPrompt,
  type LoginStartOptions,
  type LoginState,
  type SubscriptionProvider,
} from '@/common/kyrn/login';
import { openExternalUrl } from '@/renderer/utils/platform';
import { muErrorText } from '../fields/muError';
import styles from './accounts.module.css';
import type { LoginFailure } from './useSubscriptionLogin';

/** How much of a flow's error is shown under the message: enough to tell what went wrong. */
const DETAIL_LIMIT = 200;

export const providerName = (t: (key: string) => string, provider: SubscriptionProvider) =>
  t(`mu.welcome.login.providers.${provider}.name`);

/** The small tag after the name of a sign-in that is an experiment (the Google ones). */
export function ExperimentalTag({ provider }: { provider: SubscriptionProvider }) {
  const { t } = useTranslation();
  if (!isGoogleProvider(provider)) return null;
  return <span className={styles.experimental}>{t('mu.welcome.login.experimental')}</span>;
}

/**
 * A sign-in in the browser, while it runs. The page on this machine finishes it by itself; pasting the code by hand
 * is only offered as the way out when that does not happen. A sign-in by the pasted address alone (`login.paste`,
 * when another program keeps the callback port) shows its field at once. Give it `key={login.id}`, so a new sign-in
 * starts clean.
 */
export default function LoginWaiting({
  login,
  onAnswer,
  onCancel,
}: {
  login: LoginState & { provider: SubscriptionProvider };
  onAnswer: (value: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [pasting, setPasting] = useState(login.paste === true);
  const [code, setCode] = useState('');
  const { prompt } = login;
  const answer = (value: string) => {
    if (!value.trim()) return;
    setCode('');
    onAnswer(value);
  };
  if (isRiskConsent(login.provider, prompt))
    return <RiskConsent provider={login.provider} onContinue={() => onAnswer('continue')} onCancel={onCancel} />;
  const name = providerName(t, login.provider);
  return (
    <div className={styles.panel} data-testid='mu-login-waiting'>
      <div className={styles.waiting}>
        <span className={styles.pulse} aria-hidden='true' />
        <span>
          {login.stored
            ? t('mu.welcome.login.readingModels', { name })
            : login.device
              ? t('mu.welcome.login.waitingDevice', { name })
              : login.url
                ? t('mu.welcome.login.waiting', { name })
                : t('mu.welcome.login.starting', { name })}
        </span>
      </div>
      {login.device ? (
        <div className={styles.deviceCode}>
          <span>{t('mu.welcome.login.deviceCode')}</span>
          <code data-testid='mu-login-device-code'>{login.device.userCode}</code>
        </div>
      ) : null}
      {login.paste && prompt?.type === 'manual_code' && prompt.placeholder ? (
        <div className={styles.hint} data-testid='mu-login-paste-hint'>
          {t('mu.welcome.login.pasteHint', { address: prompt.placeholder })}
        </div>
      ) : null}
      {prompt && (prompt.type !== 'manual_code' || pasting) ? (
        <PromptField prompt={prompt} name={name} value={code} onChange={setCode} onAnswer={answer} />
      ) : null}
      <div className={styles.links}>
        {login.url && !login.stored ? (
          <button type='button' className={styles.link} onClick={() => void openExternalUrl(login.url ?? '')}>
            {t('mu.welcome.login.openAgain')}
          </button>
        ) : null}
        {prompt?.type === 'manual_code' && !pasting ? (
          <button type='button' className={styles.link} data-testid='mu-login-paste' onClick={() => setPasting(true)}>
            {t('mu.welcome.login.pasteCode')}
          </button>
        ) : null}
        <button type='button' className={styles.link} data-testid='mu-login-cancel' onClick={onCancel}>
          {t('mu.welcome.login.cancel')}
        </button>
      </div>
    </div>
  );
}

/**
 * The question a Google sign-in asks before anything opens: these are Google's logins for its own tools, and Google
 * may limit or suspend an account that signs in to them from another program. Said in mu's words; going on takes
 * the person's own click, never a default.
 */
function RiskConsent({
  provider,
  onContinue,
  onCancel,
}: {
  provider: SubscriptionProvider;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.risk} role='group' aria-labelledby='mu-login-risk-title' data-testid='mu-login-risk'>
      <div id='mu-login-risk-title' className={styles.riskTitle}>
        {t('mu.welcome.login.risk.title')}
      </div>
      <p className={styles.riskText}>{t('mu.welcome.login.risk.text', { tool: providerName(t, provider) })}</p>
      <p className={styles.riskText}>{t('mu.welcome.login.risk.instead')}</p>
      <div className={styles.riskActions}>
        <Button size='small' data-testid='mu-login-risk-continue' onClick={onContinue}>
          {t('mu.welcome.login.risk.continue')}
        </Button>
        <button type='button' className={styles.link} data-testid='mu-login-risk-cancel' onClick={onCancel}>
          {t('mu.welcome.login.risk.cancel')}
        </button>
      </div>
    </div>
  );
}

/**
 * The one sentence for a sign-in whose callback port another program keeps: which program, as far as the system says,
 * and what to do there. It stands in for the flow's own English words.
 */
function portInUseText(t: TFunction, failure: LoginFailure): string {
  const port = failure.port ?? 1455;
  const { pid, command, pi } = failure.holder ?? {};
  if (pi && pid) return t('mu.welcome.login.portInUse.session', { port, pid });
  if (command && pid) return t('mu.welcome.login.portInUse.program', { port, command, pid });
  if (pid) return t('mu.welcome.login.portInUse.process', { port, pid });
  return t('mu.welcome.login.portInUse.unknown', { port });
}

/**
 * Why a sign-in or sign-out did not finish: what did not, in a plain sentence; the reason in the app language when the
 * failure has a known code; and the flow's or the call's own words under it. A sign-in that failed can be tried again
 * from here (`onStart`), and one whose callback port another program keeps can be done by the pasted address instead.
 */
export function LoginProblem({
  failure,
  onStart,
}: {
  failure: LoginFailure | undefined;
  /** Starts the sign-in again; without it there is no Retry. */
  onStart?: (provider: SubscriptionProvider, options?: LoginStartOptions) => void;
}) {
  const { t, i18n } = useTranslation();
  if (!failure) return null;
  const { provider } = failure;
  // A port another program keeps, or a sign-in another one took over: one sentence of the app's own says it all.
  const own =
    failure.code === 'port_in_use'
      ? portInUseText(t, failure)
      : failure.code === 'login_taken_over'
        ? t('mu.welcome.login.takenOver')
        : undefined;
  // An uncoded failure has nothing to say beyond its own words.
  const known =
    !own && failure.error && failure.error.code !== 'unknown'
      ? muErrorText(t, i18n.language, failure.error)
      : undefined;
  const detail = own ? undefined : known ? known.detail : failure.detail;
  const retry = failure.action === 'signIn' && provider && onStart ? onStart : undefined;
  return (
    <div className={styles.problem} role='alert' data-testid='mu-login-problem'>
      {own ?? t(failure.action === 'signOut' ? 'mu.accounts.signOutFailed' : 'mu.welcome.login.failed')}
      {known ? <div>{known.text}</div> : null}
      {detail ? (
        <div className={styles.problemDetail} dir='ltr'>
          {detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT)}…` : detail}
        </div>
      ) : null}
      {retry && provider ? (
        <div className={styles.problemActions}>
          <Button size='small' data-testid='mu-login-retry' onClick={() => retry(provider, { paste: failure.paste })}>
            {t('mu.welcome.login.retry')}
          </Button>
          {failure.code === 'port_in_use' && !failure.paste ? (
            <Button
              size='small'
              type='text'
              data-testid='mu-login-paste-instead'
              onClick={() => retry(provider, { paste: true })}
            >
              {t('mu.welcome.login.pasteInstead')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What a flow asks while it runs. The code to paste is mu's own wording. The rarer questions of other flows come with
 * pi's text, which is English: a line in the app language says whose question it is.
 */
function PromptField({
  prompt,
  name,
  value,
  onChange,
  onAnswer,
}: {
  prompt: LoginPrompt;
  /** The provider's name, for the line above pi's own question. */
  name: string;
  value: string;
  onChange: (value: string) => void;
  onAnswer: (value: string) => void;
}) {
  const { t } = useTranslation();
  if (prompt.type === 'select' && prompt.options?.length) {
    return (
      <div className={styles.options} role='group' aria-label={prompt.message}>
        <div className={styles.hint}>{t('mu.welcome.login.asks', { name })}</div>
        <div className={styles.hint} dir='ltr'>
          {prompt.message}
        </div>
        {prompt.options.map((option) => (
          <Button key={option.id} onClick={() => onAnswer(option.id)}>
            {option.label}
          </Button>
        ))}
      </div>
    );
  }
  const manual = prompt.type === 'manual_code';
  const label = manual ? t('mu.welcome.login.code') : prompt.message;
  const placeholder = manual ? t('mu.welcome.login.codePlaceholder') : prompt.placeholder;
  return (
    <div className={styles.prompt}>
      {manual ? null : (
        <>
          <div className={styles.hint}>{t('mu.welcome.login.asks', { name })}</div>
          <div className={styles.hint} dir='ltr'>
            {prompt.message}
          </div>
        </>
      )}
      <div className={styles.codeRow}>
        {prompt.type === 'secret' ? (
          <Input.Password
            autoFocus
            aria-label={label}
            value={value}
            placeholder={placeholder}
            onChange={onChange}
            onPressEnter={() => onAnswer(value)}
          />
        ) : (
          <Input
            autoFocus
            aria-label={label}
            value={value}
            placeholder={placeholder}
            onChange={onChange}
            onPressEnter={() => onAnswer(value)}
          />
        )}
        <Button type='primary' disabled={!value.trim()} onClick={() => onAnswer(value)}>
          {t('mu.welcome.login.submit')}
        </Button>
      </div>
    </div>
  );
}
