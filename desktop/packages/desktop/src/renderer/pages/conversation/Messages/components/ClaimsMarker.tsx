/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The claims marker: what an agent's final reply claims, checked against the
 * machine, rendered under the reply in team conversations only. Two markers,
 * both reader-only (nothing is retried or reworded):
 *  - `inProgress` — the reply announces work while the turn ran no tool;
 *  - `missingFiles` — a deliberate Markdown file link points at nothing.
 * Teammate-delivered rows get the file check but not the work check: their
 * tool use happened in their own conversation, invisible here, so a work
 * marker on them would be a guess, not a check.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Remind } from '@icon-park/react';
import {
  claimsFor,
  fileCheckCandidates,
  inProgressClaimOf,
  type ReplyClaims,
} from '@renderer/pages/team/core/claimsCore';
import { missingPathsOf, teamInfoOf } from '@renderer/pages/team/core/claimsEnv';

type MarkerState = { enabled: boolean; workspace: string | undefined };

const ClaimsMarker: React.FC<{
  conversationId: string | undefined;
  text: string;
  worked: boolean | undefined;
  /** Teammate-delivered rows skip the work check (their tools ran elsewhere). */
  isTeammateDelivery: boolean;
}> = ({ conversationId, text, worked, isTeammateDelivery }) => {
  const { t } = useTranslation();
  const [scope, setScope] = useState<MarkerState>({ enabled: false, workspace: undefined });
  const [missingFiles, setMissingFiles] = useState<string[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    if (!conversationId) return;
    void teamInfoOf(conversationId).then((info) => {
      if (cancelled) return;
      setScope({ enabled: Boolean(info?.teamId), workspace: info?.workspace });
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const candidates = useMemo(
    () => (scope.enabled ? fileCheckCandidates(text, scope.workspace, undefined) : []),
    [scope.enabled, scope.workspace, text]
  );

  useEffect(() => {
    let cancelled = false;
    if (candidates.length === 0) {
      setMissingFiles(undefined);
      return;
    }
    void missingPathsOf(candidates.map((candidate) => candidate.path)).then((missing) => {
      if (cancelled) return;
      // Report the raw link as written, not the resolved path the check used.
      const missingSet = new Set(missing);
      const raws = [...new Set(candidates.filter((candidate) => missingSet.has(candidate.path)).map((c) => c.raw))];
      setMissingFiles(raws);
    });
    return () => {
      cancelled = true;
    };
  }, [candidates]);

  if (!scope.enabled) return null;
  if (worked === undefined && !isTeammateDelivery) return null;
  const checkedWorked = isTeammateDelivery ? true : worked === true;
  const claims: ReplyClaims | undefined =
    missingFiles !== undefined
      ? claimsFor({ text, missingFiles, worked: checkedWorked })
      : inProgressClaimOf(text, checkedWorked)
        ? { missingFiles: [], inProgress: true }
        : undefined;
  if (claims === undefined) return null;
  // Same card chrome as the flow's inline task cards — one family of cards.
  return (
    <div data-testid='claims-marker' className='mt-4px flex flex-col gap-4px max-w-100%'>
      {claims.inProgress ? (
        <div
          data-testid='claims-marker-in-progress'
          className='w-fit max-w-100% flex items-center gap-6px px-10px py-4px rd-10px text-12px leading-17px'
          style={{
            border: '1px solid rgb(var(--warning-3))',
            background: 'rgb(var(--warning-1))',
            color: 'rgb(var(--warning-6))',
          }}
        >
          <Remind theme='outline' size='12' className='shrink-0' />
          <span>{t('team.workbench.claims.inProgress')}</span>
        </div>
      ) : null}
      {claims.missingFiles.length > 0 ? (
        <div
          data-testid='claims-marker-missing-files'
          className='w-fit max-w-100% flex items-center gap-6px px-10px py-4px rd-10px text-12px leading-17px'
          style={{
            border: '1px solid rgb(var(--warning-3))',
            background: 'rgb(var(--warning-1))',
            color: 'rgb(var(--warning-6))',
          }}
        >
          <Remind theme='outline' size='12' className='shrink-0' />
          <span className='min-w-0 break-words'>
            {t('team.workbench.claims.missingFiles', { files: claims.missingFiles.join('、') })}
          </span>
        </div>
      ) : null}
    </div>
  );
};

export default ClaimsMarker;
