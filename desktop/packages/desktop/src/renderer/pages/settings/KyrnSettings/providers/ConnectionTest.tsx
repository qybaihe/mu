import React, { useState } from 'react';
import { Button } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import type { ListedModel, ProviderSettings, ProviderTestResult } from '@/common/kyrn/models';
import { formatNumber } from '@/renderer/services/i18n/format';
import MuErrorMessage from '../fields/MuErrorMessage';
import { toMuError, type MuError } from '../fields/muError';
import { camel } from './endpoints';
import styles from './providers.module.css';

type ConnectionTestProps = {
  provider: ProviderSettings;
  /** The key typed but not saved, if any. Otherwise the main process uses the saved one, against the saved address only. */
  typedKey: string;
  disabled: boolean;
  /** The ids the endpoint listed, and what the list stated about each (context, output, images, thinking). */
  onModels: (ids: string[], facts: Record<string, ListedModel>) => void;
};

/** One minimal request, made by the main process. What comes back is a code; the words are ours. */
export default function ConnectionTest({ provider, typedKey, disabled, onModels }: ConnectionTestProps) {
  const { t, i18n } = useTranslation();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ProviderTestResult>();
  const [failure, setFailure] = useState<MuError>();

  const run = async () => {
    setRunning(true);
    setResult(undefined);
    setFailure(undefined);
    try {
      const answer = unwrap(
        await kyrnBridge.testProvider.invoke({
          id: provider.id,
          api: provider.api,
          baseUrl: provider.baseUrl.trim(),
          authHeader: provider.authHeader,
          model: provider.models[0]?.id ?? '',
          ...(typedKey ? { apiKey: typedKey } : {}),
        })
      );
      setResult(answer);
      if (answer.models.length) onModels(answer.models, answer.facts ?? {});
    } catch (cause) {
      setFailure(toMuError(cause));
    } finally {
      setRunning(false);
    }
  };

  let message: React.ReactNode = <span className={styles.hint}>{t('mu.test.hint')}</span>;
  if (failure)
    message = (
      <div className={styles.problem} role='alert' data-testid='mu-test-failure'>
        <MuErrorMessage error={failure} />
      </div>
    );
  else if (result) {
    const text = t(`mu.test.${camel(result.code)}`, {
      status: result.status ?? '',
      // Raw, for the plural; the text writes it the app language's way itself (`{{count, number}}`).
      count: result.models.length,
      ms: formatNumber(result.latencyMs, i18n.language),
    });
    message = (
      <div className={result.ok ? styles.ok : styles.problem} role='status' data-testid='mu-test-result'>
        <div>{text}</div>
        {/* What the endpoint itself said is its own line, not glued to our sentence. */}
        {result.detail ? <div className={styles.hint}>{t('mu.test.detail', { detail: result.detail })}</div> : null}
      </div>
    );
  }
  return (
    <div className={styles.test}>
      <Button size='small' loading={running} disabled={disabled} onClick={() => void run()}>
        {t('mu.test.run')}
      </Button>
      {message}
    </div>
  );
}
