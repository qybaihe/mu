/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The claims marker service: which conversations belong to a team (the marker
 * is a team-visibility affordance, DS-Bot marks group messages), and a cache
 * of file-existence answers so one path is checked at most once per session.
 * All IO lives here; `claimsCore` stays pure.
 */
import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';

type TeamInfo = { teamId: string | undefined; role: string | undefined; workspace: string | undefined } | null;

const teamInfoByConversation = new Map<string, TeamInfo>();
const inflightByConversation = new Map<string, Promise<TeamInfo>>();

const readTeamInfo = (extra: Record<string, unknown> | null | undefined, workspace: string | undefined): TeamInfo => {
  if (!extra) return { teamId: undefined, role: undefined, workspace };
  const teamId = extra.teamId ?? extra.team_id;
  const role = extra.role;
  return {
    teamId: typeof teamId === 'string' && teamId ? teamId : undefined,
    role: typeof role === 'string' && role ? role : undefined,
    workspace,
  };
};

/**
 * The conversation's team scope, fetched once per conversation. `null` until
 * the detail lands; a failed fetch (deleted conversation) settles as no-team.
 */
export const teamInfoOf = (conversationId: string): Promise<TeamInfo> => {
  const cached = teamInfoByConversation.get(conversationId);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = inflightByConversation.get(conversationId);
  if (inflight) return inflight;
  const promise = ipcBridge.conversation.get
    .invoke({ id: conversationId })
    .then((conversation) => {
      const info: TeamInfo = conversation ? readTeamInfo(conversation.extra, conversation.extra?.workspace) : null;
      teamInfoByConversation.set(conversationId, info);
      inflightByConversation.delete(conversationId);
      return info;
    })
    .catch((): TeamInfo => {
      teamInfoByConversation.set(conversationId, null);
      inflightByConversation.delete(conversationId);
      return null;
    });
  inflightByConversation.set(conversationId, promise);
  return promise;
};

const existsByPath = new Map<string, boolean>();

const isMissingAnswer = (error: unknown): boolean => {
  // The file service answers "not there" with HTTP 400 (path resolution failed,
  // os error 2). Anything else — network down, auth, a 500 — is "could not check",
  // and a check that could not run must not invent a claim violation.
  return isBackendHttpError(error) && error.status === 400;
};

/**
 * Which of the candidate paths do not exist, via the backend's file metadata
 * endpoint. Answers are cached per absolute path for the session; a check that
 * could not run (service down, auth, 5xx) counts as existing.
 */
export const missingPathsOf = async (paths: readonly string[]): Promise<string[]> => {
  const unknown = paths.filter((path) => !existsByPath.has(path));
  await Promise.allSettled(
    unknown.map(async (path) => {
      try {
        await ipcBridge.fs.getFileMetadata.invoke({ path });
        existsByPath.set(path, true);
      } catch (error) {
        existsByPath.set(path, !isMissingAnswer(error));
      }
    })
  );
  return paths.filter((path) => existsByPath.get(path) === false);
};

/** Test hook: forget every cached conversation and path answer. */
export const resetClaimsEnvForTest = (): void => {
  teamInfoByConversation.clear();
  inflightByConversation.clear();
  existsByPath.clear();
};
