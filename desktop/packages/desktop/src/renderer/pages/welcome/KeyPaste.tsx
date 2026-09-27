import React from 'react';
import { Button, Input, Link } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import AionSelect from '@/renderer/components/base/AionSelect';
import MuErrorMessage from '@/renderer/pages/settings/KyrnSettings/fields/MuErrorMessage';
import { camel } from '@/renderer/pages/settings/KyrnSettings/providers/endpoints';
import { StatusDot, type DotState } from '@/renderer/pages/settings/KyrnSettings/providers/parts';
import choiceStyles from '@/renderer/pages/settings/KyrnSettings/sections/sections.module.css';
import { formatNumber } from '@/renderer/services/i18n/format';
import { openExternalUrl } from '@/renderer/utils/platform';
import Field from './Field';
import { isServiceId, MODEL_SERVICES, type ModelService } from './services';
import type { KeyCheck, KeySetup } from './useKeySetup';
import styles from './Welcome.module.css';

type KeyPasteProps = {
  setup: KeySetup;
  /** Next was pressed: say what is missing. */
  tried: boolean;
};

type Said = { text: string; dot: DotState; failing: boolean; detail: string };

/** What the check says, in plain words: the connection test's result codes, worded for someone setting up. */
function useCheckWords(service: ModelService | undefined, check: KeyCheck, works: boolean): Said | undefined {
  const { t, i18n } = useTranslation();
  if (!service || check.phase === 'idle') return undefined;
  const name = t(`mu.welcome.apiKey.services.${service.id}.name`);
  const words = (key: string, extra: Record<string, unknown> = {}) =>
    t(`mu.welcome.apiKey.outcome.${key}`, { service: name, ...extra });
  if (check.phase === 'checking')
    return {
      text: t(service.keyless ? 'mu.welcome.apiKey.lookingLocal' : 'mu.welcome.apiKey.checking', { service: name }),
      dot: 'busy',
      failing: false,
      detail: '',
    };
  // The main process refused the check itself (a key with a space in it): its own words, shown by the caller.
  if (check.phase === 'failed') return { text: '', dot: 'attention', failing: true, detail: '' };
  const { outcome, result } = check;
  const status = result.status ?? '';
  let text: string;
  if (outcome === 'ok') text = words(service.keyless ? 'okLocal' : service.openList ? 'openList' : 'ok');
  else if (outcome === 'empty') text = words(service.keyless ? 'emptyLocal' : 'empty');
  else if (outcome === 'unreachable') text = words(service.keyless ? 'offline' : 'unreachable');
  else if (outcome === 'other')
    text = t(`mu.test.${camel(result.code)}`, {
      status,
      count: result.models.length,
      ms: formatNumber(result.latencyMs, i18n.language),
    });
  else text = words(outcome, { status });
  return { text, dot: works ? 'ready' : 'attention', failing: !works, detail: works ? '' : result.detail };
}

/**
 * The key tile: paste a key, and mu tells the service from its shape (or asks, when it fits several or none), checks
 * the key with that service alone, and starts on a model the service lists. No address, no wire format.
 */
export default function KeyPaste({ setup, tried }: KeyPasteProps) {
  const { t } = useTranslation();
  const { service, candidates, check } = setup;
  const typed = setup.key.trim();
  const said = useCheckWords(service, check, setup.works);
  // A key several services' shapes fit is asked about with just those; any other key with every service.
  const offered = candidates.length > 1 ? candidates : MODEL_SERVICES;
  let serviceHint = t('mu.welcome.apiKey.serviceHint');
  if (service) serviceHint = setup.recognized ? t('mu.welcome.apiKey.recognized') : '';
  else if (typed) serviceHint = t(candidates.length > 1 ? 'mu.welcome.apiKey.ambiguous' : 'mu.welcome.apiKey.unknown');

  return (
    <div className={styles.fields}>
      <Field
        label={t('mu.welcome.model.key')}
        problem={tried && !typed && !service?.keyless ? t('mu.welcome.apiKey.problems.key') : undefined}
      >
        <Input.Password
          autoFocus
          aria-label={t('mu.welcome.model.key')}
          autoComplete='new-password'
          value={setup.key}
          placeholder={t('mu.welcome.apiKey.placeholder')}
          onChange={setup.setKey}
        />
      </Field>
      <Field
        label={t('mu.welcome.apiKey.service')}
        problem={tried && typed && !service ? t('mu.welcome.apiKey.problems.service') : undefined}
      >
        <AionSelect
          aria-label={t('mu.welcome.apiKey.service')}
          data-testid='mu-welcome-key-service'
          value={service?.id}
          placeholder={t('mu.welcome.apiKey.servicePlaceholder')}
          options={offered.map((entry) => ({
            value: entry.id,
            label: t(`mu.welcome.apiKey.services.${entry.id}.label`),
          }))}
          onChange={(value: unknown) => {
            if (isServiceId(value)) setup.choose(value);
          }}
        />
        {serviceHint || service?.keyPage ? (
          <div className={styles.hintRow}>
            {serviceHint ? (
              <span className={choiceStyles.choiceHint} data-testid='mu-welcome-key-hint'>
                {serviceHint}
              </span>
            ) : null}
            {service?.keyPage ? (
              <Link
                className={styles.keyPage}
                href={service.keyPage}
                data-testid='mu-welcome-key-page'
                onClick={(event) => {
                  event.preventDefault();
                  void openExternalUrl(service.keyPage ?? '');
                }}
              >
                {t('mu.welcome.apiKey.keyPage')}
              </Link>
            ) : null}
          </div>
        ) : null}
      </Field>

      {said ? (
        <div className={styles.check}>
          {said.text ? (
            <div
              className={styles.checkStatus}
              role={said.failing ? 'alert' : 'status'}
              data-testid='mu-welcome-key-status'
              data-outcome={check.phase === 'done' ? check.outcome : check.phase}
            >
              <StatusDot state={said.dot} label={said.text} />
              <span>{said.text}</span>
            </div>
          ) : null}
          {check.phase === 'failed' ? (
            <div className={styles.problem} role='alert' data-testid='mu-welcome-key-status' data-outcome='failed'>
              <MuErrorMessage error={check.error} />
            </div>
          ) : null}
          {/* What the service itself said is its own line, not glued to our sentence. */}
          {said.detail ? (
            <div className={choiceStyles.choiceHint}>{t('mu.test.detail', { detail: said.detail })}</div>
          ) : null}
          {said.failing ? (
            <div>
              <Button size='small' data-testid='mu-welcome-key-recheck' onClick={setup.recheck}>
                {t('mu.welcome.apiKey.recheck')}
              </Button>
            </div>
          ) : null}
          {tried && said.failing ? (
            <div className={styles.problem} role='alert'>
              {/* A service on this machine has no key to blame. */}
              {service?.keyless
                ? t('mu.welcome.apiKey.problems.notReady', {
                    service: t(`mu.welcome.apiKey.services.${service.id}.name`),
                  })
                : t('mu.welcome.apiKey.problems.notWorking')}
            </div>
          ) : null}
        </div>
      ) : null}

      {setup.works && check.phase === 'done' ? (
        <Field
          label={t('mu.welcome.apiKey.startsWith')}
          problem={tried && !setup.model.trim() ? t('mu.welcome.apiKey.problems.model') : undefined}
        >
          {check.outcome === 'ok' ? (
            <AionSelect
              showSearch
              aria-label={t('mu.welcome.apiKey.startsWith')}
              data-testid='mu-welcome-key-model'
              value={setup.model || undefined}
              options={setup.models}
              onChange={(value: unknown) => setup.setModel(typeof value === 'string' ? value : '')}
            />
          ) : (
            // Nothing listed to pick from: the model is typed, the service's usual one filled in.
            <Input
              aria-label={t('mu.welcome.apiKey.startsWith')}
              data-testid='mu-welcome-key-model'
              value={setup.model}
              placeholder={t('mu.welcome.model.modelId')}
              onChange={setup.setModel}
            />
          )}
          <div className={choiceStyles.choiceHint}>{t('mu.welcome.apiKey.modelHint')}</div>
        </Field>
      ) : null}
    </div>
  );
}
