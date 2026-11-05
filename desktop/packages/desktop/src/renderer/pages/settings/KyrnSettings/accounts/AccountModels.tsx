import React, { useRef, useState } from 'react';
import { Button, Checkbox, Message } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { LoginModel } from '@/common/kyrn/login';
import MuSearchInput from '@/renderer/components/base/MuSearchInput';
import providerStyles from '../providers/providers.module.css';
import { recheckMu } from '../recheck';
import styles from './accounts.module.css';

type AccountModelsProps = {
  /** pi's provider id: a signed-in account's, or one an API key makes usable. */
  provider: string;
  /** The provider as the screen names it, for the notice after a sign-in. */
  name: string;
  models: LoginModel[];
  /** The ids the model menus offer; undefined from an older harness, which offers them all. */
  enabled?: string[];
  /** The model new conversations start on, when it is one of the account's: marked, and pointed out when unchecked. */
  startModel?: string;
  /** Signed in a moment ago on this page: the choice is asked for. */
  fresh: boolean;
  enable: (provider: string, models: string[] | 'default') => Promise<void>;
};

/** What the harness says when a choice would leave no model at all (pi's enabled-models.ts). */
const NO_MODEL_LEFT = 'At least one model must stay enabled';
/** Past this many models the list gets a search box. */
const SEARCH_FROM = 12;

const matches = (model: LoginModel, query: string): boolean => {
  const words = query.trim().toLowerCase();
  return !words || model.id.toLowerCase().includes(words) || model.name.toLowerCase().includes(words);
};

/**
 * Which of a provider's models the model menus offer (pi's global `enabledModels`, written by `mu auth enable`). A
 * click applies at once, outside the save bar, as a sign-in does; the boxes show the click while it is written. All
 * of them is the default, saved as the provider's every model, the ones it gains later too.
 *
 * A long list (OpenRouter's) is searched, and "Select all" and "Select none" then mean the models found. A choice that
 * would leave no model anywhere is not written: the boxes stay empty, waiting for the models to keep, the way one
 * starts over from "Select none".
 */
export default function AccountModels({
  provider,
  name,
  models,
  enabled,
  startModel,
  fresh,
  enable,
}: AccountModelsProps) {
  const { t } = useTranslation();
  // The choice being written, shown until the last write comes back with what is saved.
  const [draft, setDraft] = useState<string[]>();
  // Nothing checked, which the harness refused: shown so until a model is checked.
  const [held, setHeld] = useState(false);
  const holding = useRef(false);
  const writing = useRef(0);
  // Which click is the newest: only its refusal holds the boxes empty.
  const clicks = useRef(0);
  const [query, setQuery] = useState('');
  const ids = models.map((model) => model.id);
  const shown = draft ?? enabled ?? ids;
  const listed = query.trim() ? models.filter((model) => matches(model, query)) : models;
  const listedIds = listed.map((model) => model.id);
  const all = listedIds.every((id) => shown.includes(id));
  const none = !listedIds.some((id) => shown.includes(id));
  const whole = ids.every((id) => shown.includes(id));
  // pi starts a new session on the default only while it is offered, else on the first model that is.
  const start = models.find((model) => model.id === startModel);
  const startOff = start && !shown.includes(start.id);

  const choose = (next: string[]) => {
    const kept = ids.filter((id) => next.includes(id));
    setDraft(kept);
    holding.current = false;
    setHeld(false);
    writing.current += 1;
    clicks.current += 1;
    const click = clicks.current;
    // Every one of them is the default: it takes in the models the provider gains later too.
    void enable(provider, ids.every((id) => kept.includes(id)) ? 'default' : kept)
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        if (detail.includes(NO_MODEL_LEFT) && kept.length === 0) {
          if (click === clicks.current) {
            holding.current = true;
            setHeld(true);
          }
          return;
        }
        Message.error(
          detail.includes(NO_MODEL_LEFT) ? t('mu.accounts.enable.lastModel') : t('mu.accounts.enable.failed')
        );
      })
      .finally(() => {
        writing.current -= 1;
        if (writing.current > 0 || holding.current) return;
        setDraft(undefined);
        // The snapshot the new-conversation page lists models from is read again.
        void recheckMu();
      });
  };

  return (
    <div className={providerStyles.field} data-testid={`mu-account-models-${provider}`}>
      {fresh ? (
        <div className={styles.modelsFresh} data-testid='mu-account-models-fresh'>
          {t('mu.accounts.enable.fresh', { name, count: ids.length })}
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
          <Button
            size='mini'
            type='text'
            data-testid='mu-account-models-all'
            disabled={all}
            onClick={() => choose([...shown, ...listedIds])}
          >
            {t('mu.accounts.enable.all')}
          </Button>
          <Button
            size='mini'
            type='text'
            data-testid='mu-account-models-none'
            disabled={none}
            onClick={() => choose(shown.filter((id) => !listedIds.includes(id)))}
          >
            {t('mu.accounts.enable.none')}
          </Button>
          <Button
            size='mini'
            type='text'
            data-testid='mu-account-models-reset'
            disabled={whole}
            onClick={() => choose(ids)}
          >
            {t('mu.accounts.enable.reset')}
          </Button>
        </div>
      </div>
      <div className={providerStyles.hint}>{t('mu.accounts.enable.hint')}</div>
      {held ? (
        <div className={styles.modelsFresh} role='status' data-testid='mu-account-models-held'>
          {t('mu.accounts.enable.pickOne')}
        </div>
      ) : null}
      {startOff ? (
        <div className={providerStyles.hint} data-testid='mu-account-models-start-off'>
          {t('mu.accounts.enable.startOff', { name: start.name || start.id })}
        </div>
      ) : null}
      {models.length > SEARCH_FROM ? (
        <MuSearchInput
          value={query}
          onChange={setQuery}
          allowClear
          placeholder={t('mu.accounts.enable.search', { count: models.length })}
          data-testid='mu-account-models-search'
        />
      ) : null}
      <div className={styles.modelsList}>
        {listed.map((model) => (
          <Checkbox
            key={model.id}
            data-testid={`mu-account-model-${model.id}`}
            checked={shown.includes(model.id)}
            onChange={(on: boolean) => choose(ids.filter((id) => (id === model.id ? on : shown.includes(id))))}
          >
            <span className={styles.modelName}>{model.name || model.id}</span>
            {model.name && model.name !== model.id ? <span className={styles.modelId}>{model.id}</span> : null}
            {model.id === startModel ? (
              <span className={styles.modelTag} data-testid='mu-account-model-start'>
                {t('mu.accounts.enable.startTag')}
              </span>
            ) : null}
          </Checkbox>
        ))}
        {listed.length === 0 ? (
          <div className={providerStyles.hint} data-testid='mu-account-models-nothing'>
            {t('mu.accounts.enable.nothingFound')}
          </div>
        ) : null}
      </div>
    </div>
  );
}
