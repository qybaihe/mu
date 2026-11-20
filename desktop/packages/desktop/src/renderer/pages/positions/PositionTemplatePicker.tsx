/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The wizard's template tab: the community catalog (awesome-grokbot, CC0)
 * as a starting point instead of a project directory. The tab ensures the
 * catalog cache on open (downloading it once when missing), searches it —
 * free text plus a category filter — and adopting one entry hands the
 * wizard the draft derived from it; the review step, the overlap check and
 * the safe write are the wizard's own, shared with the directory path.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Select } from '@arco-design/web-react';
import { positionBridge } from '@/common/chat/team/positions/positionBridge';
import type { TemplateCatalogErrorCode, TemplateCatalogStatus, TemplateEntry } from '@/common/chat/team/positions/templateCatalogCore';
import { draftFromTemplate } from '@/common/chat/team/positions/templateCatalogCore';

/** What adopting one entry hands the wizard: the draft's four fields. */
export type TemplateDraftResult = ReturnType<typeof draftFromTemplate>;

type PositionTemplatePickerProps = {
  onAdopt: (draft: TemplateDraftResult) => void;
};

const RESULT_LIMIT = 8;

const PositionTemplatePicker: React.FC<PositionTemplatePickerProps> = ({ onAdopt }) => {
  const { t } = useTranslation();

  const [status, setStatus] = useState<TemplateCatalogStatus | undefined>();
  const [ensuring, setEnsuring] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | undefined>();
  const [categories, setCategories] = useState<{ category: string; count: number }[]>([]);
  const [results, setResults] = useState<TemplateEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | undefined>();

  /** One search round: cache-only, status and filter options come with the answer. */
  const runSearch = useCallback(async (text: string, filter?: string) => {
    setSearching(true);
    setError(undefined);
    try {
      const answer = await positionBridge.templatesSearch.invoke({
        query: text,
        category: filter,
        limit: RESULT_LIMIT,
      });
      if (answer.ok === false) {
        setError(answer.error);
        return;
      }
      setStatus(answer.data.status);
      setCategories(answer.data.categories);
      setResults(answer.data.results);
      setSearched(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSearching(false);
    }
  }, []);

  /** The open of the tab ensures the cache (one download when missing), then loads the filter options. */
  useEffect(() => {
    let cancelled = false;
    const ensure = async () => {
      setEnsuring(true);
      let available = false;
      try {
        const answer = await positionBridge.templatesEnsure.invoke({});
        if (cancelled) return;
        if (answer.ok === false) {
          setError(answer.error);
          return;
        }
        setStatus(answer.data);
        available = answer.data.available;
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
        return;
      } finally {
        if (!cancelled) setEnsuring(false);
      }
      if (!cancelled && available) await runSearch('', undefined);
    };
    void ensure();
    return () => {
      cancelled = true;
    };
  }, [runSearch]);

  const refresh = useCallback(async () => {
    setEnsuring(true);
    setError(undefined);
    try {
      const answer = await positionBridge.templatesEnsure.invoke({ refresh: true });
      if (answer.ok === false) setError(answer.error);
      else {
        setStatus(answer.data);
        if (answer.data.available) await runSearch(query, category);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setEnsuring(false);
    }
  }, [category, query, runSearch]);

  const categoryLabel = (id: string): string => {
    const key = `positions.wizard.template.category.${id}`;
    const label = t(key);
    return label === key ? id : label;
  };

  /** A fetch failure's code as this language's text — the main process ships codes, not strings. */
  const errorText = (code: TemplateCatalogErrorCode): string =>
    code === 'download-failed'
      ? t('positions.wizard.template.errorDownloadFailed')
      : t('positions.wizard.template.errorUnparseable');

  const fetchedOn = status?.fetchedAt !== undefined ? new Date(status.fetchedAt).toLocaleDateString() : undefined;

  return (
    <div data-testid='position-template-picker' className='flex flex-col gap-10px'>
      <div className='text-12px text-t-tertiary'>{t('positions.wizard.template.hint')}</div>

      {/* The cache's state: how many templates, fetched when, and the refresh or retry it asks for. */}
      <div data-testid='position-template-status' className='flex items-center gap-8px text-12px text-t-secondary'>
        {ensuring ? (
          <span>{t('positions.wizard.template.downloading')}</span>
        ) : status?.available === true ? (
          <>
            <span>{t('positions.wizard.template.statusReady', { count: status.count, date: fetchedOn ?? '—' })}</span>
            {status.stale ? <span className='text-warning'>{t('positions.wizard.template.statusStale')}</span> : null}
            <Button
              data-testid='position-template-refresh'
              size='mini'
              onClick={() => void refresh()}
              className='ml-auto'
            >
              {t('positions.wizard.template.refresh')}
            </Button>
          </>
        ) : (
          <>
            <span className='text-warning'>
              {status?.errorCode !== undefined ? errorText(status.errorCode) : t('positions.wizard.template.unavailable')}
            </span>
            <Button
              data-testid='position-template-retry'
              size='mini'
              onClick={() => void refresh()}
              className='ml-auto'
            >
              {t('positions.wizard.template.retry')}
            </Button>
          </>
        )}
      </div>

      {error ? (
        <div data-testid='position-template-error' className='text-12px text-danger'>
          {error}
        </div>
      ) : null}

      <div className='flex items-center gap-8px'>
        <Input.Search
          data-testid='position-template-search'
          aria-label={t('positions.wizard.template.searchPlaceholder')}
          placeholder={t('positions.wizard.template.searchPlaceholder')}
          value={query}
          loading={searching}
          disabled={status?.available !== true}
          onChange={setQuery}
          onSearch={() => void runSearch(query, category)}
          className='flex-1'
        />
        <Select
          data-testid='position-template-category'
          aria-label={t('positions.wizard.template.categoryLabel')}
          placeholder={t('positions.wizard.template.categoryAll')}
          value={category}
          disabled={status?.available !== true}
          onChange={(value) => {
            setCategory(value);
            void runSearch(query, value);
          }}
          className='w-140px'
        >
          <Select.Option value=''>{t('positions.wizard.template.categoryAll')}</Select.Option>
          {categories.map((entry) => (
            <Select.Option key={entry.category} value={entry.category}>
              {`${categoryLabel(entry.category)} (${entry.count})`}
            </Select.Option>
          ))}
        </Select>
      </div>

      {results.length > 0 ? (
        <div className='flex flex-col gap-6px max-h-260px overflow-y-auto'>
          {results.map((entry, index) => (
            <div
              key={entry.slug}
              data-testid={`position-template-row-${index}`}
              className='flex items-start gap-10px p-10px rd-8px bg-fill-1 hover:bg-fill-2 transition-colors'
            >
              <div className='flex flex-col gap-4px flex-1 min-w-0'>
                <div className='flex items-center gap-8px'>
                  <span className='text-13px font-500 text-t-primary truncate'>{entry.name}</span>
                  <span className='shrink-0 px-6px h-18px leading-18px rd-6px text-11px bg-fill-3 text-t-secondary'>
                    {categoryLabel(entry.category)}
                  </span>
                </div>
                <div className='text-12px text-t-secondary line-clamp-2'>{entry.summary_zh}</div>
              </div>
              <Button
                data-testid={`position-template-adopt-${index}`}
                size='mini'
                type='primary'
                onClick={() => onAdopt(draftFromTemplate(entry))}
                className='shrink-0'
              >
                {t('positions.wizard.template.adopt')}
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {searched && !searching && results.length === 0 && status?.available === true ? (
        <div data-testid='position-template-empty' className='text-12px text-t-tertiary'>
          {query.trim() ? t('positions.wizard.template.empty') : t('positions.wizard.template.hint')}
        </div>
      ) : null}
    </div>
  );
};

export default PositionTemplatePicker;
