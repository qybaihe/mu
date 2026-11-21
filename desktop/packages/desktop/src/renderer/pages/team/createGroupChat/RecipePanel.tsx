/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The recipe mode of the new-group dialog: the merged recipe cards (built-in
 * plus custom), one selection expanded into its role rows — every row either
 * seated by a roster position (可换岗) or marked 将新建 (可删) — and, when the
 * kept lineup still needs positions the library does not carry, the review
 * step that drafts them (the same fields the wizard's template adoption
 * fills: id, name, duty, taboos, thinking tier — every one editable) before
 * creating them and handing the dialog the final seat list. One click from
 * card to group; the creation chain itself stays the dialog's.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Message, Select } from '@arco-design/web-react';
import { Close } from '@icon-park/react';
import { positionBridge } from '@/common/chat/team/positions/positionBridge';
import { recipeBridge } from '@/common/chat/team/recipes/recipeBridge';
import {
  draftPositionFromRole,
  resolveRecipeRoles,
  type RecipePositionDraft,
  type TeamRecipe,
} from '@/common/chat/team/recipes/recipeCore';
import {
  POSITION_THINKING_LEVELS,
  type PositionThinkingLevel,
} from '@/common/chat/team/thinkingLevel/thinkingLevelCore';
import { positionIdentityColor } from '@/common/chat/team/positions/positionIdentityColor';
import { usePositionRoster, refreshPositions } from '@renderer/pages/positions/usePositionRoster';
import { rowButtonProps } from '@renderer/utils/ui/rowButton';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';

/** What the panel hands the dialog: the seats (ordered position ids), each seat's thinking tier, and each seat's model pick. */
export type RecipeGroupPlan = {
  recipeId: string;
  positionIds: string[];
  thinkingBySeat: (PositionThinkingLevel | undefined)[];
  /** Per-seat model picks ('' or 'default' = the default model), parallel to `positionIds`. */
  modelsBySeat: string[];
  /**
   * The seats' roster entries, resolved and drafted alike: the dialog's own
   * roster snapshot may still be the pre-refresh one when the ready plan
   * arrives, so the plan carries what the create call needs — the created
   * positions' own answers — not just their ids.
   */
  seatInfos: PositionInfo[];
};

type RecipePanelProps = {
  open: boolean;
  /** The dialog learns the current plan (null while a recipe needs confirmed drafts). */
  onPlan: (plan: RecipeGroupPlan | null) => void;
  /** The drafts were created: the final plan (ids computed here, not from a roster re-render) — the dialog may create the group now. */
  onReadyToCreate: (plan: RecipeGroupPlan) => void;
  busy: boolean;
  /** The model ids the per-role model dropdowns offer (the mu assistant's configured list). */
  models: string[];
};

/** One role row's outcome against the roster, after the user's swap/remove overrides. */
type EffectiveRole = {
  roleIndex: number;
  position: PositionInfo | undefined;
  /** True when the user explicitly cleared the swap select back to draft. */
  forcedDraft: boolean;
};

const RecipePanel: React.FC<RecipePanelProps> = ({ open, onPlan, onReadyToCreate, busy, models }) => {
  const { t } = useTranslation();
  const { positions: roster } = usePositionRoster();
  const [recipes, setRecipes] = useState<TeamRecipe[] | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  /** Role overrides by index: removed, or swapped to a roster id ('' = forced draft). */
  const [overrides, setOverrides] = useState<Record<number, { removed?: boolean; swapTo?: string }>>({});
  /** Per-role model picks by index ('' = the default model). */
  const [modelByRole, setModelByRole] = useState<Record<number, string>>({});
  const [reviewOpen, setReviewOpen] = useState(false);
  const [draftForms, setDraftForms] = useState<Record<number, RecipePositionDraft>>({});
  const [creatingMissing, setCreatingMissing] = useState(false);

  const recipe = useMemo(() => recipes?.find((entry) => entry.id === selectedId), [recipes, selectedId]);

  // The card list loads when the dialog opens; a closed dialog forgets everything.
  useEffect(() => {
    if (!open) {
      setSelectedId(undefined);
      setOverrides({});
      setModelByRole({});
      setReviewOpen(false);
      setDraftForms({});
      setCreatingMissing(false);
      return;
    }
    let cancelled = false;
    setLoadError(undefined);
    recipeBridge.list
      .invoke()
      .then((answer) => {
        if (cancelled) return;
        if (answer.ok === true) setRecipes(answer.data);
        else setLoadError(answer.error);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const effectiveRoles = useMemo<EffectiveRole[]>(() => {
    if (!recipe) return [];
    const resolveRole = (roleIndex: number): EffectiveRole => {
      const override = overrides[roleIndex];
      if (override?.swapTo !== undefined) {
        if (override.swapTo === '') return { roleIndex, position: undefined, forcedDraft: true };
        return {
          roleIndex,
          position: roster.find((position) => position.name === override.swapTo),
          forcedDraft: false,
        };
      }
      const resolved = resolveRecipeRoles(recipe, roster)[roleIndex];
      return { roleIndex, position: resolved?.position, forcedDraft: false };
    };
    return recipe.roles.map((_, roleIndex) => resolveRole(roleIndex));
  }, [overrides, recipe, roster]);

  const kept = effectiveRoles.filter((entry) => !overrides[entry.roleIndex]?.removed);

  /** The ids the kept seated roles contribute, and the role indices still needing a drafted position. */
  const { seatedIds, missingIndices } = useMemo(() => {
    const seated: string[] = [];
    const missing: number[] = [];
    for (const entry of kept) {
      if (entry.position) seated.push(entry.position.name);
      else missing.push(entry.roleIndex);
    }
    return { seatedIds: seated, missingIndices: missing };
  }, [kept]);

  // The plan the dialog holds: ready the moment every kept role seats (a
  // recipe whose suggestions all resolve, or after the drafts were created);
  // null while drafts wait for confirmation. One position seats once — two
  // roles swapped onto the same position share its seat.
  const plan = useMemo<RecipeGroupPlan | null>(() => {
    if (!recipe || missingIndices.length > 0) return null;
    const seatInfos = kept.flatMap((entry) => (entry.position ? [entry.position] : []));
    const thinkingBySeat = kept.map((entry) => recipe.roles[entry.roleIndex]?.thinkingLevel);
    const modelsBySeat = kept.map((entry) => modelByRole[entry.roleIndex] ?? '');
    return {
      recipeId: recipe.id,
      positionIds: seatInfos.map((position) => position.name),
      thinkingBySeat,
      modelsBySeat,
      seatInfos,
    };
  }, [kept, missingIndices.length, modelByRole, recipe]);

  useEffect(() => {
    onPlan(plan);
  }, [onPlan, plan]);

  // Selecting another recipe (or the same one again) resets the overrides and the review.
  const pickRecipe = useCallback((id: string) => {
    setSelectedId(id);
    setOverrides({});
    setModelByRole({});
    setReviewOpen(false);
    setDraftForms({});
  }, []);

  /** The review step's drafts, prefilled once from the recipe's roles (ids avoid the seats already taken). */
  const openReview = useCallback(() => {
    if (!recipe) return;
    const taken = new Set(seatedIds);
    const drafts: Record<number, RecipePositionDraft> = {};
    for (const roleIndex of missingIndices) drafts[roleIndex] = draftPositionFromRole(recipe, roleIndex, taken);
    setDraftForms(drafts);
    setReviewOpen(true);
  }, [missingIndices, recipe, seatedIds]);

  /**
   * The review's write: every draft becomes a library position (the wizard's
   * own create call, one by one so an overlap names its role), then the
   * dialog gets the final seat list — the seats' own roster entries, the
   * drafts' create answers included, never a roster re-render whose timing
   * is not ours — and may create the group.
   */
  const createMissing = useCallback(async () => {
    if (!recipe || creatingMissing || busy) return;
    setCreatingMissing(true);
    try {
      const created = new Map<number, PositionInfo>();
      for (const roleIndex of missingIndices) {
        const draft = draftForms[roleIndex];
        if (!draft) continue;
        const answer = await positionBridge.createPosition.invoke({
          id: draft.id.trim(),
          displayName: draft.displayName.trim(),
          description: draft.description.trim(),
          ...(draft.antiJob.length > 0 ? { antiJob: draft.antiJob } : {}),
          ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
          body: draft.body,
        });
        if (answer.ok === false) {
          Message.error(t('team.recipes.createFailed', { name: draft.displayName || draft.id, error: answer.error }));
          setCreatingMissing(false);
          return;
        }
        created.set(roleIndex, answer.data);
      }
      await refreshPositions();
      setReviewOpen(false);
      const seatInfos: PositionInfo[] = [];
      const thinkingBySeat: (PositionThinkingLevel | undefined)[] = [];
      const modelsBySeat: string[] = [];
      for (const entry of kept) {
        const seat = entry.position ?? created.get(entry.roleIndex);
        if (!seat || seatInfos.some((taken) => taken.name === seat.name)) continue; // one position seats once
        seatInfos.push(seat);
        thinkingBySeat.push(recipe.roles[entry.roleIndex]?.thinkingLevel);
        modelsBySeat.push(modelByRole[entry.roleIndex] ?? '');
      }
      if (seatInfos.length === 0) return;
      onReadyToCreate({
        recipeId: recipe.id,
        positionIds: seatInfos.map((seat) => seat.name),
        thinkingBySeat,
        modelsBySeat,
        seatInfos,
      });
    } catch (error) {
      Message.error(
        t('team.recipes.createFailed', { name: '', error: error instanceof Error ? error.message : String(error) })
      );
    } finally {
      setCreatingMissing(false);
    }
  }, [busy, creatingMissing, draftForms, kept, missingIndices, modelByRole, onReadyToCreate, recipe, t]);

  const sourceBadge = (entry: TeamRecipe) =>
    entry.source === 'builtin' ? (
      <span className='px-6px h-18px leading-18px rd-9px text-11px bg-fill-3 text-t-secondary shrink-0'>
        {t('team.recipes.builtinBadge')}
      </span>
    ) : (
      <span className='px-6px h-18px leading-18px rd-9px text-11px bg-success-light-1 text-success shrink-0'>
        {t('team.recipes.customBadge')}
      </span>
    );

  // Step one: the card list.
  if (!recipe) {
    return (
      <div data-testid='recipe-card-list' className='flex flex-col gap-10px'>
        {loadError ? (
          <div className='text-12px text-danger'>{t('team.recipes.loadFailed', { error: loadError })}</div>
        ) : null}
        {!loadError && recipes === undefined ? (
          <div className='text-13px text-t-tertiary'>{t('team.recipes.loading')}</div>
        ) : null}
        {recipes?.length === 0 ? <div className='text-13px text-t-tertiary'>{t('team.recipes.empty')}</div> : null}
        {(recipes ?? []).map((entry) => (
          <div
            key={entry.id}
            data-testid={`recipe-card-${entry.id}`}
            {...rowButtonProps(() => pickRecipe(entry.id))}
            className='flex flex-col gap-4px p-12px rd-10px bg-fill-2 hover:bg-fill-3 cursor-pointer transition-colors'
          >
            <div className='flex items-center gap-8px min-w-0'>
              <span className='text-14px font-500 text-t-primary truncate'>{entry.displayName}</span>
              {sourceBadge(entry)}
              <span className='flex-1' />
              <span className='text-12px text-t-tertiary shrink-0'>
                {t('team.recipes.rolesCount', { count: entry.roles.length })}
              </span>
            </div>
            <div className='text-12px text-t-secondary'>{entry.description}</div>
            <div className='text-12px text-t-tertiary truncate'>
              {t('team.recipes.pipelineLabel')}：{entry.pipeline}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Step two: the selected recipe's roles (the review replaces the rows until confirmed).
  if (reviewOpen) {
    return (
      <div data-testid='recipe-review' className='flex flex-col gap-12px'>
        <div className='flex items-center gap-8px'>
          <span className='text-14px font-500 text-t-primary'>
            {t('team.recipes.reviewTitle', { count: missingIndices.length })}
          </span>
        </div>
        <div className='text-12px text-t-tertiary'>{t('team.recipes.reviewHint')}</div>
        {missingIndices.map((roleIndex) => {
          const draft = draftForms[roleIndex] ?? draftPositionFromRole(recipe, roleIndex, new Set(seatedIds));
          const role = recipe.roles[roleIndex];
          const update = (patch: Partial<RecipePositionDraft>) =>
            setDraftForms((prev) => ({ ...prev, [roleIndex]: { ...draft, ...patch } }));
          return (
            <div
              key={roleIndex}
              data-testid={`recipe-review-role-${roleIndex}`}
              className='flex flex-col gap-8px p-10px rd-8px bg-fill-2'
            >
              <div className='flex items-center gap-8px'>
                <span
                  className='size-10px rd-full shrink-0'
                  style={{ background: positionIdentityColor(draft.id).background }}
                />
                <span className='text-13px font-500 text-t-primary'>{role.roleName}</span>
              </div>
              <div className='flex items-center gap-8px'>
                <span className='text-12px text-t-tertiary w-64px shrink-0'>{t('positions.wizard.idLabel')}</span>
                <Input
                  data-testid={`recipe-review-id-${roleIndex}`}
                  className='flex-1'
                  value={draft.id}
                  onChange={(value) => update({ id: value })}
                  placeholder='lowercase-slug'
                />
              </div>
              <div className='flex items-center gap-8px'>
                <span className='text-12px text-t-tertiary w-64px shrink-0'>{t('positions.wizard.nameLabel')}</span>
                <Input
                  data-testid={`recipe-review-name-${roleIndex}`}
                  className='flex-1'
                  value={draft.displayName}
                  onChange={(value) => update({ displayName: value })}
                />
              </div>
              <div className='flex items-center gap-8px'>
                <span className='text-12px text-t-tertiary w-64px shrink-0'>{t('positions.wizard.descLabel')}</span>
                <Input
                  data-testid={`recipe-review-desc-${roleIndex}`}
                  className='flex-1'
                  value={draft.description}
                  onChange={(value) => update({ description: value })}
                />
              </div>
              <div className='flex items-center gap-8px'>
                <span className='text-12px text-t-tertiary w-64px shrink-0'>{t('positions.wizard.antiJobLabel')}</span>
                <Input.TextArea
                  data-testid={`recipe-review-antijob-${roleIndex}`}
                  className='flex-1'
                  value={draft.antiJob.join('\n')}
                  autoSize={{ minRows: 1, maxRows: 3 }}
                  onChange={(value) =>
                    update({
                      antiJob: value
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </div>
              <div className='flex items-center gap-8px'>
                <span className='text-12px text-t-tertiary w-64px shrink-0'>{t('positions.wizard.thinkingLabel')}</span>
                <Select
                  data-testid={`recipe-review-thinking-${roleIndex}`}
                  className='flex-1'
                  value={draft.thinkingLevel || undefined}
                  placeholder={t('positions.wizard.thinkingPlaceholder')}
                  allowClear
                  onChange={(value: PositionThinkingLevel | undefined) => update({ thinkingLevel: value })}
                  options={POSITION_THINKING_LEVELS.map((level) => ({
                    value: level,
                    label: t(`positions.wizard.thinking.${level}`),
                  }))}
                />
              </div>
            </div>
          );
        })}
        <div className='flex justify-end gap-10px'>
          <Button
            data-testid='recipe-review-back'
            size='small'
            disabled={creatingMissing}
            onClick={() => setReviewOpen(false)}
          >
            {t('positions.wizard.back')}
          </Button>
          <Button
            data-testid='recipe-review-create'
            size='small'
            type='primary'
            loading={creatingMissing}
            onClick={() => void createMissing()}
          >
            {t('team.recipes.reviewCreate')}
          </Button>
        </div>
      </div>
    );
  }

  // Step two, the roles of the picked recipe.
  return (
    <div data-testid='recipe-role-list' className='flex flex-col gap-10px'>
      <div className='flex items-center gap-8px'>
        <span className='text-14px font-500 text-t-primary truncate'>{recipe.displayName}</span>
        {sourceBadge(recipe)}
        <span className='flex-1' />
        <span
          {...rowButtonProps(() => pickRecipe(recipe.id))}
          data-testid='recipe-change'
          className='text-12px text-t-secondary cursor-pointer hover:text-t-primary'
        >
          {t('team.recipes.changeRecipe')}
        </span>
      </div>
      <div className='text-12px text-t-tertiary'>
        {t('team.recipes.pipelineLabel')}：{recipe.pipeline}
      </div>
      {kept.map((entry, seat) => {
        const role = recipe.roles[entry.roleIndex];
        const resolved = entry.position !== undefined;
        const swapped = overrides[entry.roleIndex]?.swapTo;
        return (
          <div
            key={entry.roleIndex}
            data-testid={`recipe-role-${entry.roleIndex}`}
            className='flex flex-col gap-6px p-10px rd-8px bg-fill-2'
          >
            <div className='flex items-center gap-8px min-w-0'>
              <span
                className='size-10px rd-full shrink-0'
                style={{
                  background: positionIdentityColor(entry.position?.name ?? `${recipe.id}-r${entry.roleIndex + 1}`)
                    .background,
                }}
              />
              <span className='text-13px font-500 text-t-primary truncate'>{role.roleName}</span>
              {seat === 0 ? (
                <span className='px-6px h-18px leading-18px rd-9px text-11px bg-primary-light-1 text-primary shrink-0'>
                  {t('team.members.leadBadge')}
                </span>
              ) : null}
              <span className='flex-1' />
              {role.thinkingLevel ? (
                <span className='text-11px text-t-tertiary shrink-0'>
                  {t('team.recipes.thinkingBadge', { level: t(`positions.wizard.thinking.${role.thinkingLevel}`) })}
                </span>
              ) : null}
              <span
                {...rowButtonProps(() =>
                  setOverrides((prev) => ({ ...prev, [entry.roleIndex]: { ...prev[entry.roleIndex], removed: true } }))
                )}
                data-testid={`recipe-role-remove-${entry.roleIndex}`}
                className='text-t-tertiary hover:text-danger cursor-pointer shrink-0'
                aria-label={t('team.recipes.removeRole', { name: role.roleName })}
              >
                <Close />
              </span>
            </div>
            <div className='text-12px text-t-secondary'>{role.duty}</div>
            {role.antiJob && role.antiJob.length > 0 ? (
              <div className='text-12px text-warning truncate'>
                {t('team.recipes.antiJobLabel')}：{role.antiJob.join('；')}
              </div>
            ) : null}
            <div className='flex items-center gap-8px'>
              {resolved ? (
                <span
                  data-testid={`recipe-role-badge-${entry.roleIndex}`}
                  className='px-6px h-18px leading-18px rd-9px text-11px bg-success-light-1 text-success shrink-0'
                >
                  {t('team.recipes.resolvedBadge')} · {entry.position?.displayName}
                </span>
              ) : (
                <span
                  data-testid={`recipe-role-badge-${entry.roleIndex}`}
                  className='px-6px h-18px leading-18px rd-9px text-11px bg-warning-light-1 text-warning shrink-0'
                >
                  {t('team.recipes.missingBadge')}
                </span>
              )}
              <Select
                data-testid={`recipe-role-swap-${entry.roleIndex}`}
                className='flex-1 min-w-0'
                size='small'
                value={swapped !== undefined ? swapped : (entry.position?.name ?? '')}
                placeholder={t('team.recipes.swapPlaceholder')}
                onChange={(value: string) =>
                  setOverrides((prev) => ({ ...prev, [entry.roleIndex]: { ...prev[entry.roleIndex], swapTo: value } }))
                }
              >
                <Select.Option value=''>{t('team.recipes.swapDraftOption')}</Select.Option>
                {roster.map((position) => (
                  <Select.Option key={position.name} value={position.name}>
                    {position.displayName}
                  </Select.Option>
                ))}
              </Select>
            </div>
            {/* The seat's model pick: 'default' or one of the configured
                models. A role whose recipe declares a model hint (the review
                roles' 「应异于产出岗」) shows it beside the dropdown — advisory,
                applied only by the person's pick. */}
            <div className='flex items-center gap-8px'>
              <span className='text-11px text-t-tertiary w-64px shrink-0'>{t('team.recipes.modelLabel')}</span>
              <Select
                data-testid={`recipe-role-model-${entry.roleIndex}`}
                className='flex-1 min-w-0'
                size='small'
                value={modelByRole[entry.roleIndex] || 'default'}
                onChange={(value: string) =>
                  setModelByRole((prev) => ({ ...prev, [entry.roleIndex]: value === 'default' ? '' : value }))
                }
              >
                <Select.Option value='default'>{t('team.recipes.modelDefault')}</Select.Option>
                {models.map((model) => (
                  <Select.Option key={model} value={model}>
                    {model}
                  </Select.Option>
                ))}
              </Select>
              {role.modelHint ? (
                <span
                  data-testid={`recipe-role-modelhint-${entry.roleIndex}`}
                  className='px-6px h-18px leading-18px rd-9px text-11px bg-warning-light-1 text-warning shrink-0 whitespace-nowrap'
                >
                  {t('team.recipes.modelHintBadge', { hint: role.modelHint })}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
      {missingIndices.length > 0 ? (
        <Button data-testid='recipe-confirm-missing' type='outline' size='small' disabled={busy} onClick={openReview}>
          {t('team.recipes.confirmMissing', { count: missingIndices.length })}
        </Button>
      ) : null}
      {kept.length === 0 ? <div className='text-12px text-t-tertiary'>{t('team.recipes.needRoles')}</div> : null}
    </div>
  );
};

export default RecipePanel;
