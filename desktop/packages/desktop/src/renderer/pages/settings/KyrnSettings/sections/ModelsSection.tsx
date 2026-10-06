import React from 'react';
import { Alert, Button } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import type { AvailableModels } from '@/common/kyrn/models';
import type { KyrnSettings } from '@/common/kyrn/types';
import { useSubscriptionLogin } from '../accounts/useSubscriptionLogin';
import type { Draft } from '../draft';
import { ErrorDetail } from '../fields/MuErrorMessage';
import { ModifiedMark } from '../fields/Row';
import BoardModelCard from '../providers/BoardModelCard';
import DefaultModelCard from '../providers/DefaultModelCard';
import ProviderManager from '../providers/ProviderManager';
import { hiddenIds } from '../providers/removed';
import SectionShell from './SectionShell';

type ModelsSectionProps = {
  draft: Draft;
  base: KyrnSettings;
  available: AvailableModels;
  onDraft: (change: (draft: Draft) => Draft) => void;
};

/** Removed here, but still in the snapshot of what mu last reported: offered neither as usable nor as a start. */
const hiddenOf = ({ models }: KyrnSettings) =>
  hiddenIds([...models.providers.map((provider) => provider.id), ...models.foreign.map((entry) => entry.id)]);

/**
 * Every provider behind the models: the subscriptions to sign in to, the endpoints set up here, and what else the
 * running mu reported. Which model a new session starts with is the next page.
 */
export default function ProvidersSection({ draft, base, available, onDraft }: ModelsSectionProps) {
  const { t } = useTranslation();
  const inRouter = useInRouterContext();
  const { models } = draft.settings;
  const setModels = (patch: Partial<KyrnSettings['models']>) =>
    onDraft((now) => ({ ...now, settings: { ...now.settings, models: { ...now.settings.models, ...patch } } }));
  return (
    <SectionShell
      id='providers'
      title={t('mu.sections.providers')}
      description={t('mu.providers.lead')}
      actions={inRouter ? <ReopenGuide /> : undefined}
    >
      <ProviderManager
        draft={draft}
        base={base}
        available={available}
        onModels={setModels}
        onKeys={(providerKeys) => onDraft((now) => ({ ...now, providerKeys }))}
        hidden={hiddenOf(draft.settings)}
      >
        {models.problem ? (
          <Alert
            type='error'
            content={
              <>
                <div>{t('mu.providers.unreadable')}</div>
                <ErrorDetail>{models.problem}</ErrorDetail>
              </>
            }
          />
        ) : null}
        {models.commented ? <Alert type='warning' content={t('mu.providers.commented')} /> : null}
      </ProviderManager>
    </SectionShell>
  );
}

/**
 * The model and thinking level a new session starts with. It offers every provider set up on the previous page, and
 * the models of a subscription signed in to a moment ago.
 */
export function DefaultModelSection({ draft, base, available, onDraft }: ModelsSectionProps) {
  const { t } = useTranslation();
  const { accounts } = useSubscriptionLogin();
  return (
    <SectionShell id='defaultModel' title={t('mu.sections.defaultModel')} description={t('mu.defaults.summary')}>
      <DefaultModelCard
        settings={draft.settings}
        base={base}
        available={available}
        accounts={accounts}
        hidden={hiddenOf(draft.settings)}
        onChange={(defaults) =>
          onDraft((now) => ({
            ...now,
            settings: { ...now.settings, models: { ...now.settings.models, defaults } },
          }))
        }
      />
    </SectionShell>
  );
}

/**
 * The model that writes the plain-language board, a page of its own: one of the models of the providers, or the
 * conversation's own.
 */
export function BoardModelSection({ draft, base, available, onDraft }: ModelsSectionProps) {
  const { t } = useTranslation();
  const { accounts } = useSubscriptionLogin();
  return (
    <SectionShell
      id='boardModel'
      title={t('mu.sections.boardModel')}
      description={t('mu.boardModel.summary')}
      actions={<ModifiedMark show={draft.settings.boardModel.model !== base.boardModel.model} />}
    >
      <BoardModelCard
        settings={draft.settings}
        available={available}
        accounts={accounts}
        hidden={hiddenOf(draft.settings)}
        onChange={(model) =>
          onDraft((now) => ({
            ...now,
            settings: { ...now.settings, boardModel: { ...now.settings.boardModel, model } },
          }))
        }
      />
    </SectionShell>
  );
}

/** Opens the first-run guide again. Only where there is a router to open it in. */
function ReopenGuide() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Button size='small' type='text' data-testid='mu-open-welcome' onClick={() => navigate('/welcome')}>
      {t('mu.welcome.reopen')}
    </Button>
  );
}
