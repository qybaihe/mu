import React, { useState } from 'react';
import { Button, Checkbox, Input, InputNumber, Tag } from '@arco-design/web-react';
import { Check, Delete, Edit, Plus } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import {
  THINKING_LEVELS,
  supportedThinkingLevels,
  withThinkingLevel,
  type ListedModel,
  type ProviderModel,
  type ThinkingLevel,
} from '@/common/kyrn/models';
import { formatNumber } from '@/renderer/services/i18n/format';
import { blankModel, listedModel } from './endpoints';
import { tokenSize } from './parts';
import styles from './providers.module.css';

type ModelRowsProps = {
  models: ProviderModel[];
  onChange: (models: ProviderModel[]) => void;
  /** Model ids the endpoint listed in the last connection test, offered as one-click additions. */
  suggestions: string[];
  /** What the list stated about those models, by id: a model added from it starts with these (#23). */
  facts?: Record<string, ListedModel>;
  disabled?: boolean;
};

/**
 * The models of a custom provider, one line each: its id and what it can do (context window, thinking, images).
 * A line opens for editing; a model without an id stays open, since it cannot be saved like that.
 */
export default function ModelRows({ models, onChange, suggestions, facts = {}, disabled }: ModelRowsProps) {
  const { t, i18n } = useTranslation();
  // Rows have no identity other than their position, so the open one is an index that follows removals.
  const [open, setOpen] = useState<number>();
  const update = (index: number, patch: Partial<ProviderModel>) =>
    onChange(models.map((model, i) => (i === index ? { ...model, ...patch } : model)));
  const setReasoning = (index: number, reasoning: boolean) => {
    const model = models[index];
    update(index, { reasoning, thinkingLevels: supportedThinkingLevels(reasoning, model.thinkingLevelMap) });
  };
  const setLevel = (index: number, level: ThinkingLevel, on: boolean) => {
    const model = models[index];
    const thinkingLevelMap = withThinkingLevel(model.thinkingLevelMap, level, on);
    update(index, { thinkingLevelMap, thinkingLevels: supportedThinkingLevels(model.reasoning, thinkingLevelMap) });
  };
  const remove = (index: number) => {
    onChange(models.filter((_, i) => i !== index));
    setOpen((now) => (now === undefined || now === index ? undefined : now > index ? now - 1 : now));
  };
  const add = (id?: string) => {
    onChange([...models, id ? listedModel(id, facts[id]) : blankModel()]);
    if (!id) setOpen(models.length);
  };
  const offered = suggestions.filter((id) => !models.some((model) => model.id === id)).slice(0, 24);
  // "Model ID 2" for a screen reader: the field and the row it is in, worded by the language.
  const label = (key: string, index: number) =>
    t('mu.models.rowField', { field: t(key), n: formatNumber(index + 1, i18n.language) });

  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <span className={styles.label}>{t('mu.models.title')}</span>
        <Button
          size='mini'
          type='text'
          className={styles.iconButton}
          disabled={disabled}
          data-testid='mu-model-add'
          icon={<Plus theme='outline' size='12' />}
          onClick={() => add()}
        >
          {t('mu.models.add')}
        </Button>
      </div>
      <div className={styles.models} data-testid='mu-models'>
        {models.length ? null : <div className={styles.modelsEmpty}>{t('mu.models.none')}</div>}
        {models.map((model, index) => {
          const unnamed = !model.id.trim();
          const editing = open === index || unnamed;
          const name = unnamed ? t('mu.models.noId') : model.id;
          // A read-only line still opens, to show what the line leaves out (max output, the display name).
          const toggle = editing ? t('mu.models.done') : t(disabled ? 'mu.models.show' : 'mu.models.edit', { name });
          return (
            // eslint-disable-next-line react/no-array-index-key
            <div className={styles.model} key={index} data-testid={`mu-model-${index}`}>
              <div className={styles.modelLine}>
                <span className={unnamed ? styles.modelIdEmpty : styles.modelId}>{name}</span>
                {model.name && model.name !== model.id ? <span className={styles.modelName}>{model.name}</span> : null}
                <span
                  className={styles.modelTag}
                  title={t('mu.models.contextTag', { size: tokenSize(model.contextWindow, i18n.language) })}
                >
                  {tokenSize(model.contextWindow, i18n.language)}
                </span>
                {model.reasoning ? <span className={styles.modelTag}>{t('mu.models.tagReasoning')}</span> : null}
                {model.imageInput ? <span className={styles.modelTag}>{t('mu.models.tagImage')}</span> : null}
                <span className={styles.spacer} />
                <Button
                  size='mini'
                  type='text'
                  disabled={unnamed}
                  aria-expanded={editing}
                  aria-label={toggle}
                  title={toggle}
                  data-testid={`mu-model-edit-${index}`}
                  icon={editing ? <Check theme='outline' size='14' /> : <Edit theme='outline' size='14' />}
                  onClick={() => setOpen(editing ? undefined : index)}
                />
                <Button
                  size='mini'
                  type='text'
                  status='danger'
                  disabled={disabled}
                  aria-label={t('mu.models.removeNamed', { name })}
                  title={t('mu.models.removeNamed', { name })}
                  data-testid={`mu-model-remove-${index}`}
                  icon={<Delete theme='outline' size='14' />}
                  onClick={() => remove(index)}
                />
              </div>
              {editing ? (
                <div className={styles.modelEdit}>
                  <Input
                    size='small'
                    disabled={disabled}
                    aria-label={label('mu.models.id', index)}
                    placeholder={t('mu.models.idField')}
                    value={model.id}
                    onChange={(id) => update(index, { id })}
                  />
                  <Input
                    size='small'
                    disabled={disabled}
                    aria-label={label('mu.models.name', index)}
                    placeholder={t('mu.models.name')}
                    value={model.name}
                    onChange={(value) => update(index, { name: value })}
                  />
                  <div className={styles.modelFacts}>
                    <InputNumber
                      size='small'
                      hideControl
                      className={styles.modelNumber}
                      disabled={disabled}
                      aria-label={label('mu.models.context', index)}
                      prefix={t('mu.models.context')}
                      min={1}
                      max={100000000}
                      precision={0}
                      value={model.contextWindow}
                      onChange={(value) => typeof value === 'number' && update(index, { contextWindow: value })}
                    />
                    <InputNumber
                      size='small'
                      hideControl
                      className={styles.modelNumber}
                      disabled={disabled}
                      aria-label={label('mu.models.maxOutput', index)}
                      prefix={t('mu.models.maxOutput')}
                      min={1}
                      max={100000000}
                      precision={0}
                      value={model.maxTokens}
                      onChange={(value) => typeof value === 'number' && update(index, { maxTokens: value })}
                    />
                    <Checkbox
                      disabled={disabled}
                      aria-label={label('mu.models.reasoning', index)}
                      checked={model.reasoning}
                      onChange={(reasoning) => setReasoning(index, reasoning)}
                    >
                      {t('mu.models.reasoning')}
                    </Checkbox>
                    <Checkbox
                      disabled={disabled}
                      aria-label={label('mu.models.image', index)}
                      checked={model.imageInput}
                      onChange={(imageInput) => update(index, { imageInput })}
                    >
                      {t('mu.models.image')}
                    </Checkbox>
                  </div>
                  {model.reasoning ? (
                    <div className={styles.modelLevels} data-testid={`mu-model-levels-${index}`}>
                      <span className={styles.label}>{t('mu.models.levels')}</span>
                      <div className={styles.modelLevelRow}>
                        {THINKING_LEVELS.map((level) => (
                          <Checkbox
                            key={level}
                            disabled={disabled}
                            aria-label={label(`mu.levels.${level}`, index)}
                            checked={supportedThinkingLevels(true, model.thinkingLevelMap).includes(level)}
                            onChange={(on) => setLevel(index, level, on)}
                          >
                            {t(`mu.levels.${level}`)}
                          </Checkbox>
                        ))}
                      </div>
                      <p className={styles.hint}>{t('mu.models.levelsHelp')}</p>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {offered.length ? (
        <div className={styles.suggestions}>
          {offered.map((id) => (
            <Tag
              key={id}
              size='small'
              className='cursor-pointer'
              icon={<Plus theme='outline' size='10' />}
              title={t('mu.models.addListed', { name: id })}
              data-testid={`mu-model-offer-${id}`}
              onClick={() => add(id)}
            >
              {id}
              {facts[id]?.contextWindow ? (
                <span className={styles.offerSize}>{tokenSize(facts[id].contextWindow, i18n.language)}</span>
              ) : null}
            </Tag>
          ))}
        </div>
      ) : null}
    </div>
  );
}
