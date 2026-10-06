import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import AionSelect from '@/renderer/components/base/AionSelect';
import type { LoginStatus } from '@/common/kyrn/login';
import type { AvailableModels } from '@/common/kyrn/models';
import type { KyrnSettings } from '@/common/kyrn/types';
import ChoiceTile from '../fields/ChoiceTile';
import fieldStyles from '../fields/fields.module.css';
import { Card } from '../sections/SectionShell';
import sectionStyles from '../sections/sections.module.css';
import { providerLabel } from './endpoints';
import { filterModelOption, modelNamesOf, modelOption } from './modelOptions';

/** The board is written by the conversation's own model. */
const SESSION = 'session';
/** The models mu recommends for the board (the harness's src/board/model.ts), whoever provides them. */
const RECOMMENDED = [/claude-opus-4[.-]6/, /gemini-3\.8-flash/];
const isRecommended = (id: string): boolean => RECOMMENDED.some((pattern) => pattern.test(id));

/** "provider/model" split at the first slash: a provider id has none, a model id may (OpenRouter's do). */
export function splitModelRef(ref: string): { provider: string; model: string } {
  const at = ref.indexOf('/');
  return at > 0 ? { provider: ref.slice(0, at), model: ref.slice(at + 1) } : { provider: '', model: '' };
}

type BoardModelCardProps = {
  settings: KyrnSettings;
  available: AvailableModels;
  /** Subscriptions signed in to from the app, which a running mu may not have reported yet. */
  accounts?: LoginStatus['signedIn'];
  /** Providers removed on this screen that the snapshot of mu's last connection still lists. */
  hidden?: ReadonlySet<string>;
  onChange: (model: string) => void;
};

/**
 * The model that writes the plain-language board, the whole of its page: one picked here, or the conversation's own.
 * `/board model` in a conversation sets the same thing, and the first `/board on` asks when nothing is picked yet.
 */
export default function BoardModelCard({ settings, available, accounts = [], hidden, onChange }: BoardModelCardProps) {
  const { t } = useTranslation();
  const { model: value, supported } = settings.boardModel;
  const session = value === SESSION;
  const picked = session ? { provider: '', model: '' } : splitModelRef(value);
  // The provider only narrows the list: the setting changes once a model is picked.
  const [narrowed, setNarrowed] = useState(picked.provider);
  // What "a model of your choice" goes back to after the conversation's model was picked for a while.
  const [last, setLast] = useState(session ? '' : value);
  const provider = picked.provider || narrowed;

  const { providers } = settings.models;
  const listed = hidden?.size ? available.providers.filter((entry) => !hidden.has(entry.id)) : available.providers;
  const providerIds = [
    ...new Set([
      ...providers.map((entry) => entry.id),
      ...listed.map((entry) => entry.id),
      ...accounts.map((entry) => entry.provider),
      provider,
    ]),
  ].filter(Boolean);
  const models =
    providers.find((entry) => entry.id === provider)?.models ??
    listed.find((entry) => entry.id === provider)?.models ??
    accounts.find((entry) => entry.provider === provider)?.models ??
    [];
  const modelIds = [...new Set([...models.map((model) => model.id), picked.model])].filter(Boolean);
  const names = modelNamesOf(models);
  // The recommended ones first, marked; the rest as they came. Each by its name, its id in the tooltip.
  const modelOptions = [...modelIds.filter(isRecommended), ...modelIds.filter((id) => !isRecommended(id))].map((id) =>
    modelOption(id, names.get(id) ?? '', isRecommended(id) ? t('mu.boardModel.recommendedTag') : undefined)
  );

  const pick = (ref: string) => {
    if (ref !== SESSION) setLast(ref);
    onChange(ref);
  };

  return (
    // The page's header names the setting and says what it is: the card is its choices alone.
    <Card testId='mu-board-model'>
      {supported ? (
        <div className={sectionStyles.choiceRows} role='radiogroup' aria-label={t('mu.boardModel.title')}>
          <ChoiceTile
            testId='mu-board-model-pick'
            title={t('mu.boardModel.pick')}
            description={t('mu.boardModel.recommended')}
            active={!session}
            onPick={() => pick(last)}
          >
            <div className={sectionStyles.choiceField}>
              <span className={sectionStyles.choiceLabel}>{t('mu.boardModel.provider')}</span>
              <AionSelect
                size='small'
                showSearch
                allowClear
                className={fieldStyles.wide}
                aria-label={t('mu.boardModel.provider')}
                placeholder={t('mu.boardModel.notSet')}
                value={provider || undefined}
                options={providerIds.map((id) => ({ value: id, label: providerLabel(t, settings.models, id) }))}
                onChange={(next?: string) => {
                  setNarrowed(next ?? '');
                  // A model belongs to its provider: another provider, and it is to be picked again.
                  if (picked.model && next !== picked.provider) pick('');
                }}
              />
              <span className={sectionStyles.choiceLabel}>{t('mu.boardModel.model')}</span>
              <AionSelect
                size='small'
                showSearch
                allowCreate
                allowClear
                disabled={!provider}
                className={fieldStyles.wide}
                aria-label={t('mu.boardModel.model')}
                placeholder={provider ? t('mu.boardModel.notSet') : t('mu.boardModel.pickProvider')}
                value={picked.model || undefined}
                options={modelOptions}
                filterOption={filterModelOption}
                onChange={(model?: string) => pick(model ? `${provider}/${model}` : '')}
              />
              {value ? null : <div className={sectionStyles.choiceHint}>{t('mu.boardModel.unset')}</div>}
            </div>
          </ChoiceTile>
          <ChoiceTile
            testId='mu-board-model-session'
            title={t('mu.boardModel.session')}
            description={t('mu.boardModel.sessionHelp')}
            active={session}
            onPick={() => pick(SESSION)}
          />
        </div>
      ) : (
        <div className={sectionStyles.choiceHint}>{t('mu.boardModel.update')}</div>
      )}
    </Card>
  );
}
