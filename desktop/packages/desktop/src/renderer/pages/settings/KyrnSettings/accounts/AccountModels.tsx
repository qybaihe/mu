import React, { useRef, useState } from 'react';
import { Button, Checkbox, Message } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { LoginModel, SubscriptionProvider } from '@/common/kyrn/login';
import providerStyles from '../providers/providers.module.css';
import { recheckMu } from '../recheck';
import { providerName } from './LoginWaiting';
import styles from './accounts.module.css';

type AccountModelsProps = {
  provider: SubscriptionProvider;
  models: LoginModel[];
  /** The ids the model menus offer; undefined from an older harness, which offers them all. */
  enabled?: string[];
  /** Signed in a moment ago on this page: the choice is asked for. */
  fresh: boolean;
  enable: (provider: SubscriptionProvider, models: string[] | 'default') => Promise<void>;
};

/** What the harness says when a choice would leave no model at all (pi's enabled-models.ts). */
const NO_MODEL_LEFT = 'At least one model must stay enabled';

/**
 * Which of an account's models the model menus offer (pi's global `enabledModels`, written by `mu auth enable`). A
 * click applies at once, outside the save bar, as a sign-in does; the boxes show the click while it is written. All
 * of them is the default, saved as the account's every model, the ones it gains later too.
 */
export default function AccountModels({ provider, models, enabled, fresh, enable }: AccountModelsProps) {
  const { t } = useTranslation();
  // The choice being written, shown until the last write comes back with what is saved.
  const [draft, setDraft] = useState<string[]>();
  const writing = useRef(0);
  const ids = models.map((model) => model.id);
  const shown = draft ?? enabled ?? ids;
  const all = ids.every((id) => shown.includes(id));
  const none = !ids.some((id) => shown.includes(id));

  const choose = (next: string[]) => {
    setDraft(next);
    writing.current += 1;
    // Every one of them is the default: it takes in the models the account gains later too.
    void enable(provider, ids.every((id) => next.includes(id)) ? 'default' : next)
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        Message.error(
          detail.includes(NO_MODEL_LEFT) ? t('mu.accounts.enable.lastModel') : t('mu.accounts.enable.failed')
        );
      })
      .finally(() => {
        writing.current -= 1;
        if (writing.current > 0) return;
        setDraft(undefined);
        // The snapshot the new-conversation page lists models from is read again.
        void recheckMu();
      });
  };

  return (
    <div className={providerStyles.field} data-testid={`mu-account-models-${provider}`}>
      {fresh ? (
        <div className={styles.modelsFresh} data-testid='mu-account-models-fresh'>
          {t('mu.accounts.enable.fresh', { name: providerName(t, provider), count: ids.length })}
        </div>
      ) : null}
      <div className={providerStyles.fieldHead}>
        <div className={providerStyles.label}>
          {t('mu.accounts.enable.title')}
          <span className={providerStyles.hint} data-testid='mu-account-models-count'>
            {t('mu.accounts.enable.count', { count: ids.filter((id) => shown.includes(id)).length, total: ids.length })}
          </span>
        </div>
        <div className={styles.modelsActions}>
          <Button size='mini' type='text' disabled={all} onClick={() => choose(ids)}>
            {t('mu.accounts.enable.all')}
          </Button>
          <Button size='mini' type='text' disabled={none} onClick={() => choose([])}>
            {t('mu.accounts.enable.none')}
          </Button>
          <Button
            size='mini'
            type='text'
            data-testid='mu-account-models-reset'
            disabled={all}
            onClick={() => choose(ids)}
          >
            {t('mu.accounts.enable.reset')}
          </Button>
        </div>
      </div>
      <div className={providerStyles.hint}>{t('mu.accounts.enable.hint')}</div>
      <div className={styles.modelsList}>
        {models.map((model) => (
          <Checkbox
            key={model.id}
            data-testid={`mu-account-model-${model.id}`}
            checked={shown.includes(model.id)}
            onChange={(on: boolean) => choose(ids.filter((id) => (id === model.id ? on : shown.includes(id))))}
          >
            <span className={styles.modelName}>{model.name || model.id}</span>
            {model.name && model.name !== model.id ? <span className={styles.modelId}>{model.id}</span> : null}
          </Checkbox>
        ))}
      </div>
    </div>
  );
}
