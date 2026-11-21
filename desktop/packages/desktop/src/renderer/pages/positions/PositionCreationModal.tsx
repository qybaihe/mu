/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The position creation wizard, in two starting flavours: pick a project
 * directory (the Electron folder dialog) and see its heuristic profile at
 * once (no model calls — the first screens of AGENTS.md/HANDOFF.md/README/
 * package.json, with a one-shot mu run offered when they say nothing), or
 * start from the community template catalog (the template tab: search,
 * filter, adopt). Both hand the same review step — id, display-name
 * candidates, description, body, the identity colour the id will wear —
 * where everything is editable. Creating checks the draft against the
 * roster first: an overlap (same id, name, project root or near-identical
 * description) is a red warning that demands a deliberate confirmation,
 * per the user's dedup rule; the write itself only ever adds a new library
 * file, refusing an id that exists.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Checkbox, Input, Message, Radio } from '@arco-design/web-react';
import classNames from 'classnames';
import { ipcBridge } from '@/common';
import { positionBridge } from '@/common/chat/team/positions/positionBridge';
import type { ProjectAnalysis } from '@/common/chat/team/positions/positionBridge';
import {
  POSITION_ID_RE,
  findPositionOverlaps,
  type PositionOverlapReason,
} from '@/common/chat/team/positions/positionProjectProfile';
import { describeDraft, describeGapQuestions } from '@/common/chat/team/positions/positionDescribeCore';
import { positionIdentityColor } from '@/common/chat/team/positions/positionIdentityColor';
import MuModal from '@renderer/components/base/MuModal';
import PositionTemplatePicker, { type TemplateDraftResult } from '@renderer/pages/positions/PositionTemplatePicker';
import { refreshPositions, usePositionRoster } from '@renderer/pages/positions/usePositionRoster';
import { rowButtonProps } from '@renderer/utils/ui/rowButton';

type PositionCreationModalProps = {
  open: boolean;
  onClose: () => void;
};

/** How the wizard starts: a project directory's files, a catalog template, or the user's own description. */
type WizardMode = 'directory' | 'template' | 'describe';

/** What the review step edits; initialized from either flavour's draft, freely editable. */
type WizardForm = { id: string; displayName: string; description: string; antiJob: string; body: string };

const formOf = (analysis: ProjectAnalysis): WizardForm => ({
  id: analysis.draft.id,
  displayName: analysis.draft.displayNameCandidates[0] ?? analysis.profile.projectName ?? '',
  description: analysis.draft.description,
  antiJob: '',
  body: analysis.draft.body,
});

const PositionCreationModal: React.FC<PositionCreationModalProps> = ({ open, onClose }) => {
  const { t } = useTranslation();
  const { positions } = usePositionRoster();

  const [directory, setDirectory] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<ProjectAnalysis | undefined>();
  const [aiRunning, setAiRunning] = useState(false);
  const [aiError, setAiError] = useState<string | undefined>();
  const [analyzeError, setAnalyzeError] = useState<string | undefined>();
  const [reviewing, setReviewing] = useState(false);
  const [form, setForm] = useState<WizardForm | undefined>();
  const [nameCandidates, setNameCandidates] = useState<string[]>([]);
  const [mode, setMode] = useState<WizardMode>('directory');
  const [describeText, setDescribeText] = useState('');
  const [forceOverlap, setForceOverlap] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // A closed wizard forgets everything; the next open starts at the picker.
  useEffect(() => {
    if (open) return;
    setDirectory('');
    setAnalyzing(false);
    setAnalysis(undefined);
    setAiRunning(false);
    setAiError(undefined);
    setAnalyzeError(undefined);
    setReviewing(false);
    setForm(undefined);
    setNameCandidates([]);
    setMode('directory');
    setDescribeText('');
    setForceOverlap(false);
    setCreating(false);
    setError(undefined);
  }, [open]);

  const analyze = useCallback(async (dir: string, deep: boolean) => {
    setAiError(undefined);
    setAnalyzeError(undefined);
    if (deep) setAiRunning(true);
    else setAnalyzing(true);
    try {
      const answer = await positionBridge.analyzeProject.invoke({ dir, deep });
      if (answer.ok === true) {
        setAnalysis(answer.data);
        setForm(formOf(answer.data));
        setNameCandidates(answer.data.draft.displayNameCandidates);
        return;
      }
      // A failure is shown, never silent: the heuristic answer the wizard
      // already holds stays what it was when the deep run is the one that failed.
      if (deep) setAiError(answer.error);
      else setAnalyzeError(answer.error);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (deep) setAiError(message);
      else setAnalyzeError(message);
    } finally {
      if (deep) setAiRunning(false);
      else setAnalyzing(false);
    }
  }, []);

  const pickDirectory = useCallback(async () => {
    const picked = (await ipcBridge.dialog.showOpen.invoke({ properties: ['openDirectory', 'createDirectory'] }))?.[0];
    if (!picked) return; // cancelled
    setDirectory(picked);
    setAnalysis(undefined);
    setForm(undefined);
    setNameCandidates([]);
    setAiError(undefined);
    setAnalyzeError(undefined);
    await analyze(picked, false);
  }, [analyze]);

  /** A template adoption: the draft fills the review form — no directory, no profile — and the review opens. */
  const adoptTemplate = useCallback((draft: TemplateDraftResult) => {
    setAnalysis(undefined);
    setForm({
      id: draft.id,
      displayName: draft.displayNameCandidates[0] ?? '',
      description: draft.description,
      antiJob: draft.antiJob.join('\n'),
      body: draft.body,
    });
    setNameCandidates(draft.displayNameCandidates);
    setReviewing(true);
  }, []);

  /** What the describe flavour is missing, live: the checklist guides the supplement, one pass, no interview. */
  const describeGaps = useMemo(() => describeGapQuestions(describeText), [describeText]);

  /** A description's hand-off to the review step: the draft it yields, every field editable. */
  const adoptDescribe = useCallback(() => {
    const draft = describeDraft(describeText);
    setAnalysis(undefined);
    setForm({ id: '', displayName: '', description: draft.description, antiJob: '', body: draft.body });
    setNameCandidates([]);
    setReviewing(true);
  }, [describeText]);

  const overlaps = useMemo(
    () =>
      form
        ? findPositionOverlaps(
            {
              id: form.id,
              displayName: form.displayName,
              description: form.description,
              projectRoot: analysis?.draft.projectRoot,
            },
            positions
          )
        : [],
    [analysis, form, positions]
  );

  const idValid = POSITION_ID_RE.test(form?.id.trim() ?? '');
  const fieldsValid =
    form !== undefined && idValid && form.displayName.trim().length > 0 && form.description.trim().length > 0;
  const blocked = overlaps.length > 0 && !forceOverlap;

  const create = useCallback(async () => {
    if (!form || creating || !fieldsValid || blocked) return;
    setCreating(true);
    setError(undefined);
    try {
      const antiJob = form.antiJob
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const answer = await positionBridge.createPosition.invoke({
        id: form.id.trim(),
        displayName: form.displayName.trim(),
        description: form.description.trim(),
        ...(antiJob.length > 0 ? { antiJob } : {}),
        body: form.body,
      });
      if (answer.ok === false) {
        setError(answer.error);
        setCreating(false);
        return;
      }
      Message.success(t('positions.wizard.created', { name: answer.data.displayName }));
      await refreshPositions();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setCreating(false);
    }
  }, [blocked, creating, fieldsValid, form, onClose, t]);

  const reasonLabel = (reason: PositionOverlapReason): string => t(`positions.wizard.overlapReason.${reason}`);

  return (
    <MuModal
      variant='standard'
      header={{
        title: t('positions.wizard.title'),
        subtitle: reviewing
          ? t('positions.wizard.stepReview')
          : mode === 'template'
            ? t('positions.wizard.stepTemplate')
            : mode === 'describe'
              ? t('positions.wizard.stepDescribe')
              : t('positions.wizard.stepPick'),
        showClose: true,
      }}
      visible={open}
      onCancel={creating ? undefined : onClose}
      className='w-[min(560px,calc(100vw-32px))] max-w-560px'
      footer={{
        divider: true,
        render: () => (
          <div className='flex justify-end gap-10px'>
            {reviewing ? (
              <Button
                data-testid='position-creation-back'
                onClick={() => setReviewing(false)}
                className='px-20px min-w-80px'
              >
                {t('positions.wizard.back')}
              </Button>
            ) : null}
            {!reviewing && mode === 'directory' ? (
              <Button
                data-testid='position-creation-next'
                type='primary'
                disabled={analysis === undefined}
                onClick={() => setReviewing(true)}
                className='px-20px min-w-80px'
              >
                {t('positions.wizard.next')}
              </Button>
            ) : null}
            {!reviewing && mode === 'describe' ? (
              <Button
                data-testid='position-creation-describe-next'
                type='primary'
                disabled={describeText.trim().length === 0}
                onClick={adoptDescribe}
                className='px-20px min-w-80px'
              >
                {t('positions.wizard.next')}
              </Button>
            ) : null}
            {reviewing ? (
              <Button
                data-testid='position-creation-create'
                type='primary'
                loading={creating}
                disabled={!fieldsValid || blocked}
                onClick={() => void create()}
                className='px-20px min-w-80px'
              >
                {t('positions.wizard.create')}
              </Button>
            ) : null}
          </div>
        ),
      }}
      unmountOnExit
    >
      <div data-testid='position-creation-modal' className='flex flex-col gap-14px'>
        {/* Step one comes in two flavours: the project directory's files, or the catalog's templates. */}
        {!reviewing ? (
          <Radio.Group
            data-testid='position-creation-mode'
            type='button'
            size='small'
            value={mode}
            onChange={(value) => setMode(value as WizardMode)}
          >
            <Radio value='directory'>{t('positions.wizard.tabDirectory')}</Radio>
            <Radio value='template'>{t('positions.wizard.tabTemplate')}</Radio>
            <Radio value='describe'>{t('positions.wizard.tabDescribe')}</Radio>
          </Radio.Group>
        ) : null}

        {mode === 'template' && !reviewing ? <PositionTemplatePicker onAdopt={adoptTemplate} /> : null}

        {/* Step one, describe flavour: the pasted text, its missing-information checklist, and the pointer to the supervisor's interview. */}
        {mode === 'describe' && !reviewing ? (
          <div data-testid='position-creation-describe' className='flex flex-col gap-10px'>
            <div className='text-13px font-500 text-t-primary'>{t('positions.wizard.describeLabel')}</div>
            <Input.TextArea
              data-testid='position-creation-describe-text'
              aria-label={t('positions.wizard.describeLabel')}
              value={describeText}
              autoSize={{ minRows: 5, maxRows: 10 }}
              placeholder={t('positions.wizard.describePlaceholder')}
              onChange={(value) => setDescribeText(value)}
            />
            <div className='text-12px text-t-tertiary'>{t('positions.wizard.describeSupervisorHint')}</div>
            <div data-testid='position-creation-describe-gaps' className='flex flex-col gap-6px text-13px'>
              {describeGaps.length > 0 ? (
                <>
                  <div className='text-t-secondary'>{t('positions.wizard.describeGapTitle')}</div>
                  {describeGaps.map((gap) => (
                    <div key={gap} data-testid={`position-creation-describe-gap-${gap}`} className='text-warning'>
                      {t(`positions.wizard.describeGap.${gap}`)}
                    </div>
                  ))}
                </>
              ) : (
                <div className='text-t-tertiary'>{t('positions.wizard.describeGapAllSet')}</div>
              )}
            </div>
          </div>
        ) : null}

        {/* Step one, directory flavour: the directory and what the files say about it. */}
        {mode === 'directory' || reviewing ? (
          <div className='flex flex-col gap-14px'>
            <div className='flex items-center gap-10px'>
              <Button data-testid='position-creation-pick' size='small' onClick={() => void pickDirectory()}>
                {directory ? t('positions.wizard.repick') : t('positions.wizard.pick')}
              </Button>
              <span data-testid='position-creation-dir' className='text-13px text-t-secondary truncate flex-1'>
                {directory || t('positions.wizard.pickHint')}
              </span>
            </div>

            {analyzing ? <div className='text-13px text-t-tertiary'>{t('positions.wizard.analyzing')}</div> : null}

            {analysis ? (
              <div data-testid='position-creation-profile' className='flex flex-col gap-6px text-13px'>
                {analysis.aiUsed ? <div className='text-12px text-warning'>{t('positions.wizard.aiUsed')}</div> : null}
                <div className='text-t-primary font-500'>{analysis.profile.projectName}</div>
                {analysis.profile.goal ? (
                  <div className='text-t-secondary'>
                    <span className='text-t-tertiary'>{t('positions.wizard.profile.goal')}：</span>
                    {analysis.profile.goal}
                  </div>
                ) : null}
                {analysis.profile.techStack.length > 0 ? (
                  <div className='text-t-secondary'>
                    <span className='text-t-tertiary'>{t('positions.wizard.profile.stack')}：</span>
                    {analysis.profile.techStack.join('、')}
                  </div>
                ) : null}
                {analysis.profile.constraints.map((line) => (
                  <div key={line} className='text-t-secondary truncate'>
                    <span className='text-t-tertiary'>{t('positions.wizard.profile.constraint')}：</span>
                    {line}
                  </div>
                ))}
                {analysis.profile.empty ? (
                  <div className='text-t-tertiary'>{t('positions.wizard.emptyProfile')}</div>
                ) : null}
              </div>
            ) : null}

            {analyzeError ? (
              <div data-testid='position-creation-analyze-error' className='text-12px text-danger'>
                {t('positions.wizard.analyzeFailed', { error: analyzeError })}
              </div>
            ) : null}

            {aiError ? (
              <div data-testid='position-creation-ai-error' className='text-12px text-danger'>
                {t('positions.wizard.aiFailed', { error: aiError })}
              </div>
            ) : null}

            {analysis?.profile.empty && !analysis.aiUsed ? (
              <div>
                <Button
                  data-testid='position-creation-ai'
                  size='small'
                  type='outline'
                  loading={aiRunning}
                  onClick={() => void analyze(directory, true)}
                >
                  {t('positions.wizard.aiAnalyze')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Step two: the proposal, every field editable, overlaps red-flagged. */}
        {reviewing && form ? (
          <div className='flex flex-col gap-12px'>
            {mode === 'template' ? (
              <div className='text-12px text-t-tertiary'>{t('positions.wizard.template.nameHint')}</div>
            ) : null}
            <div className='flex items-center gap-10px'>
              {/* The identity colour preview: the hue this id will wear on every surface. */}
              <span
                data-testid='position-creation-color'
                className='size-10px rd-full shrink-0'
                style={{ background: positionIdentityColor(form.id).background }}
              />
              <span className='text-12px text-t-tertiary'>{t('positions.wizard.colorPreview')}</span>
            </div>
            <div>
              <div className='mb-6px text-13px font-500 text-t-primary'>{t('positions.wizard.idLabel')}</div>
              <Input
                data-testid='position-creation-id'
                aria-label={t('positions.wizard.idLabel')}
                value={form.id}
                onChange={(value) => setForm({ ...form, id: value })}
                placeholder='lowercase-slug'
              />
              {!idValid ? <div className='mt-4px text-12px text-danger'>{t('positions.wizard.invalidId')}</div> : null}
            </div>
            <div>
              <div className='mb-6px text-13px font-500 text-t-primary'>{t('positions.wizard.nameLabel')}</div>
              <Input
                data-testid='position-creation-name'
                aria-label={t('positions.wizard.nameLabel')}
                value={form.displayName}
                onChange={(value) => setForm({ ...form, displayName: value })}
              />
              {nameCandidates.length > 1 ? (
                <div className='mt-6px flex items-center gap-6px flex-wrap'>
                  <span className='text-12px text-t-tertiary'>{t('positions.wizard.nameCandidates')}</span>
                  {nameCandidates.map((candidate, index) => (
                    <span
                      key={candidate}
                      {...rowButtonProps(() => setForm({ ...form, displayName: candidate }))}
                      data-testid={`position-creation-candidate-${index}`}
                      className={classNames(
                        'px-8px h-22px leading-22px rd-8px text-12px cursor-pointer shrink-0 transition-colors',
                        candidate === form.displayName ? 'bg-fill-3 text-t-primary' : 'text-t-secondary hover:bg-fill-2'
                      )}
                    >
                      {candidate}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div>
              <div className='mb-6px text-13px font-500 text-t-primary'>{t('positions.wizard.descLabel')}</div>
              <Input.TextArea
                data-testid='position-creation-desc'
                aria-label={t('positions.wizard.descLabel')}
                value={form.description}
                autoSize={{ minRows: 2, maxRows: 4 }}
                onChange={(value) => setForm({ ...form, description: value })}
              />
            </div>
            <div>
              <div className='mb-6px text-13px font-500 text-t-primary'>{t('positions.wizard.antiJobLabel')}</div>
              <Input.TextArea
                data-testid='position-creation-antijob'
                aria-label={t('positions.wizard.antiJobLabel')}
                value={form.antiJob}
                autoSize={{ minRows: 2, maxRows: 4 }}
                placeholder={t('positions.wizard.antiJobPlaceholder')}
                onChange={(value) => setForm({ ...form, antiJob: value })}
              />
            </div>
            <div>
              <div className='mb-6px text-13px font-500 text-t-primary'>{t('positions.wizard.bodyLabel')}</div>
              <Input.TextArea
                data-testid='position-creation-body'
                aria-label={t('positions.wizard.bodyLabel')}
                value={form.body}
                autoSize={{ minRows: 5, maxRows: 12 }}
                onChange={(value) => setForm({ ...form, body: value })}
              />
            </div>

            {overlaps.length > 0 ? (
              <div
                data-testid='position-creation-overlap'
                className='flex flex-col gap-8px p-10px rd-8px bg-danger-light-1'
              >
                <div className='text-13px font-500 text-danger'>{t('positions.wizard.overlapTitle')}</div>
                {overlaps.map((overlap) => (
                  <div key={overlap.position.name} className='text-12px text-danger'>
                    {t('positions.wizard.overlapWith', { name: overlap.position.displayName })}：
                    {overlap.reasons.map(reasonLabel).join(' / ')}
                  </div>
                ))}
                <Checkbox
                  data-testid='position-creation-overlap-force'
                  checked={forceOverlap}
                  onChange={setForceOverlap}
                >
                  {t('positions.wizard.overlapForce')}
                </Checkbox>
              </div>
            ) : null}

            {error ? (
              <div data-testid='position-creation-error' className='text-12px text-danger'>
                {error}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </MuModal>
  );
};

export default PositionCreationModal;
