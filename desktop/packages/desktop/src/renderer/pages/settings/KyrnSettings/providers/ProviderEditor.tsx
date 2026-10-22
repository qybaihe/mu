import React, { useId, useState } from 'react';
import { Checkbox, Input, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import MuSelect from '@/renderer/components/base/MuSelect';
import {
  ENDPOINT_TYPES,
  isPlainRemoteEndpoint,
  suggestProviderId,
  type EndpointType,
  type ListedModel,
  type ProviderSettings,
} from '@/common/kyrn/models';
import { formatNameList } from '@/renderer/services/i18n/list';
import { ModifiedMark } from '../fields/Row';
import ConnectionTest from './ConnectionTest';
import ModelRows from './ModelRows';
import { ENDPOINT_PLACEHOLDER, camel, customProviderName, providerProblems } from './endpoints';
import { EndpointMark, ProviderHead, RemoveMenu } from './parts';
import styles from './providers.module.css';

type ProviderEditorProps = {
  provider: ProviderSettings;
  /** Not saved yet: its id can still be chosen. */
  isNew: boolean;
  modified: boolean;
  /** Ids no new provider may take: the other providers, hand-written entries, and what the running mu reports. */
  takenIds: Set<string>;
  typedKey: string;
  /** models.json cannot be written from here (comments, or unreadable). */
  readOnly: boolean;
  onChange: (provider: ProviderSettings) => void;
  onKey: (value: string) => void;
  /** Asks first, then removes it from the draft: it leaves models.json when the draft is saved. */
  onRemove: () => void;
};

/**
 * One custom provider: its name, the API format (it decides what the address and everything below mean), the
 * address, the key with a connection test, and its models.
 */
export default function ProviderEditor(props: ProviderEditorProps) {
  const { provider, isNew, modified, takenIds, typedKey, readOnly, onChange, onKey, onRemove } = props;
  const { t, i18n } = useTranslation();
  // Until somebody types an id, it follows the name.
  const [idTouched, setIdTouched] = useState(false);
  const [listed, setListed] = useState<{ ids: string[]; facts: Record<string, ListedModel> }>({ ids: [], facts: {} });
  const problems = providerProblems(provider, isNew, takenIds);
  const keyState = typedKey ? 'typed' : provider.key === 'managed' && !provider.keySet ? 'empty' : provider.key;
  const endpoint = camel(provider.api);
  const formatLabel = useId();

  return (
    <div className={styles.editor} data-testid='mu-provider-editor'>
      <ProviderHead
        mark={<EndpointMark size={20} />}
        title={customProviderName(t, provider)}
        badges={
          <>
            {isNew ? <Tag size='small'>{t('mu.providers.unsaved')}</Tag> : null}
            <ModifiedMark show={modified && !isNew} />
          </>
        }
        actions={<RemoveMenu disabled={readOnly} onRemove={onRemove} testId='mu-provider-more' />}
      />

      <div className={styles.fields}>
        <div className={styles.pair}>
          <label className={styles.field}>
            <span className={styles.label}>{t('mu.providers.name')}</span>
            <Input
              disabled={readOnly}
              aria-label={t('mu.providers.name')}
              placeholder={t('mu.providers.namePlaceholder')}
              value={provider.name}
              onChange={(name) =>
                onChange({
                  ...provider,
                  name,
                  ...(isNew && !idTouched ? { id: suggestProviderId(name) || provider.id } : {}),
                })
              }
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>{t('mu.providers.id')}</span>
            <Input
              disabled={!isNew || readOnly}
              aria-label={t('mu.providers.id')}
              status={problems.id ? 'error' : undefined}
              value={provider.id}
              onChange={(id) => {
                setIdTouched(true);
                onChange({ ...provider, id });
              }}
            />
            <span className={problems.id ? styles.problem : styles.hint}>
              {problems.id ? t(`mu.providers.idProblem.${problems.id}`) : t('mu.providers.idHelp')}
            </span>
          </label>
        </div>

        <div className={styles.field}>
          <span className={styles.label} id={formatLabel}>
            {t('mu.providers.endpointType')}
          </span>
          <MuSelect
            disabled={readOnly}
            aria-labelledby={formatLabel}
            data-testid='mu-endpoint-select'
            value={provider.api}
            options={ENDPOINT_TYPES.map((api) => ({ value: api, label: t(`mu.endpoints.${camel(api)}.name`) }))}
            onChange={(api: EndpointType) => onChange({ ...provider, api })}
          />
          <span className={styles.hint}>{t(`mu.endpoints.${endpoint}.hint`)}</span>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>{t('mu.providers.baseUrl')}</span>
          <Input
            disabled={readOnly}
            aria-label={t('mu.providers.baseUrl')}
            status={problems.baseUrl === 'unsafe' ? 'error' : undefined}
            placeholder={ENDPOINT_PLACEHOLDER[provider.api]}
            value={provider.baseUrl}
            onChange={(baseUrl) => onChange({ ...provider, baseUrl })}
          />
          {problems.baseUrl === 'unsafe' ? (
            <span className={styles.problem}>{t('mu.endpointRule')}</span>
          ) : isPlainRemoteEndpoint(provider.baseUrl.trim()) ? (
            <span className={styles.warn} data-testid='mu-provider-plain-http'>
              {t('mu.endpointPlain')}
            </span>
          ) : (
            <span className={styles.hint}>{t(`mu.endpoints.${endpoint}.url`)}</span>
          )}
        </label>

        <div className={styles.field}>
          <span className={styles.label}>
            {t('mu.apiKey')}
            <Tag size='small' data-testid='mu-key-state'>
              {t(`mu.keyState.${keyState}`)}
            </Tag>
          </span>
          <Input.Password
            disabled={readOnly}
            aria-label={t('mu.apiKey')}
            autoComplete='new-password'
            placeholder={t(
              provider.key === 'manual'
                ? 'mu.providers.keyReplace'
                : provider.keySet
                  ? 'mu.keyKeep'
                  : 'mu.providers.keyEnter'
            )}
            value={typedKey}
            onChange={onKey}
          />
          {/* Where the key is kept, in plain words: the file and the variable are the app's business. */}
          <span className={styles.hint}>{t('mu.keyHelp')}</span>
          <Checkbox
            disabled={readOnly}
            checked={provider.authHeader}
            onChange={(authHeader) => onChange({ ...provider, authHeader })}
          >
            <span className={styles.hint}>{t('mu.providers.authHeader')}</span>
          </Checkbox>
          {provider.headerNames.length ? (
            <span className={styles.hint}>
              {t('mu.providers.headers', { names: formatNameList(provider.headerNames, i18n.language) })}
            </span>
          ) : null}
          <ConnectionTest
            provider={provider}
            typedKey={typedKey}
            disabled={Boolean(problems.baseUrl) || Boolean(problems.id)}
            onModels={(ids, facts) => setListed({ ids, facts })}
          />
        </div>

        <div>
          <ModelRows
            models={provider.models}
            suggestions={listed.ids}
            facts={listed.facts}
            disabled={readOnly}
            onChange={(models) => onChange({ ...provider, models })}
          />
          {problems.models ? <div className={styles.problem}>{t(`mu.models.problem.${problems.models}`)}</div> : null}
        </div>
      </div>
    </div>
  );
}
