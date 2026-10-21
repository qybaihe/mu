/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { parseError } from '@/common/utils';
import type { TFunction } from 'i18next';

export type WorkspacePathErrorCode = 'WORKSPACE_PATH_UNAVAILABLE' | 'WORKSPACE_PATH_RUNTIME_UNAVAILABLE';
export type TeamAssistantCreateErrorCode =
  | 'TEAM_ASSISTANT_ID_REQUIRED'
  | 'TEAM_ASSISTANT_NOT_FOUND'
  | 'TEAM_ASSISTANT_FIELD_UNSUPPORTED';

export type ConversationCreateErrorCode = 'WORKSPACE_PATH_UNAVAILABLE' | TeamAssistantCreateErrorCode;
export type ConversationRuntimeWorkspaceErrorCode = 'WORKSPACE_PATH_RUNTIME_UNAVAILABLE';

const BACKEND_ERROR_CODE_MAP: Record<string, WorkspacePathErrorCode> = {
  WORKSPACE_PATH_UNAVAILABLE: 'WORKSPACE_PATH_UNAVAILABLE',
  WORKSPACE_PATH_RUNTIME_UNAVAILABLE: 'WORKSPACE_PATH_RUNTIME_UNAVAILABLE',
  WORKSPACE_PATH_CONTAINS_WHITESPACE_UNSUPPORTED: 'WORKSPACE_PATH_UNAVAILABLE',
  WORKSPACE_PATH_CONTAINS_WHITESPACE_RUNTIME_UNSUPPORTED: 'WORKSPACE_PATH_RUNTIME_UNAVAILABLE',
  WORKSPACE_TRAILING_WHITESPACE_UNSUPPORTED: 'WORKSPACE_PATH_UNAVAILABLE',
};

const TEAM_BACKEND_ERROR_CODE_MAP: Record<string, TeamAssistantCreateErrorCode> = {
  TEAM_ASSISTANT_ID_REQUIRED: 'TEAM_ASSISTANT_ID_REQUIRED',
  TEAM_ASSISTANT_NOT_FOUND: 'TEAM_ASSISTANT_NOT_FOUND',
  TEAM_ASSISTANT_FIELD_UNSUPPORTED: 'TEAM_ASSISTANT_FIELD_UNSUPPORTED',
};

// Temporary fallback for older backend builds that still return BAD_REQUEST
// plus a human-readable message. Remove after the dedicated backend code has
// shipped everywhere we support.
const LEGACY_BACKEND_MESSAGE_PATTERNS: Array<{
  code: WorkspacePathErrorCode;
  pattern: RegExp;
}> = [
  {
    code: 'WORKSPACE_PATH_UNAVAILABLE',
    pattern: /workspace directory names ending in whitespace are not supported/i,
  },
  {
    code: 'WORKSPACE_PATH_UNAVAILABLE',
    pattern:
      /workspace (directory|path).*(contain|contains|containing).*(whitespace|space).*(not supported|unsupported)/i,
  },
];

type EmbeddedBackendErrorPayload = {
  code?: string;
  error?: string;
  details?: unknown;
};

type WorkspacePathErrorDetails = {
  workspace_path?: string;
};

type TeamAssistantErrorDetails = {
  assistant_id?: string;
  field?: string;
};

const getEmbeddedBackendErrorPayload = (error: unknown): EmbeddedBackendErrorPayload | undefined => {
  const parsedError = parseError(error);
  const rawMessage =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : typeof parsedError === 'string'
          ? parsedError
          : '';

  if (!rawMessage) {
    return undefined;
  }

  const jsonStart = rawMessage.indexOf('{');
  if (jsonStart < 0) {
    return undefined;
  }

  try {
    const payload = JSON.parse(rawMessage.slice(jsonStart)) as EmbeddedBackendErrorPayload;
    if (payload && typeof payload === 'object') {
      return payload;
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const getWorkspacePathFromDetails = (details: unknown): string | undefined => {
  if (!details || typeof details !== 'object') {
    return undefined;
  }

  const workspacePath = (details as WorkspacePathErrorDetails).workspace_path;
  return typeof workspacePath === 'string' && workspacePath.trim() ? workspacePath : undefined;
};

const getWorkspacePathErrorPayload = (error: unknown): EmbeddedBackendErrorPayload | undefined => {
  if (isBackendHttpError(error)) {
    return {
      code: error.code,
      error: error.backendMessage,
      details: error.details,
    };
  }

  return getEmbeddedBackendErrorPayload(error);
};

export const getWorkspacePathFromErrorDetails = (error: unknown): string | undefined => {
  const payload = getWorkspacePathErrorPayload(error);
  return getWorkspacePathFromDetails(payload?.details);
};

export const normalizeWorkspacePathErrorCode = (error: unknown): WorkspacePathErrorCode | undefined => {
  const payload = getWorkspacePathErrorPayload(error);
  if (payload) {
    const mappedCode = payload.code ? BACKEND_ERROR_CODE_MAP[payload.code] : undefined;
    if (mappedCode) {
      return mappedCode;
    }

    const matchedLegacyPattern = LEGACY_BACKEND_MESSAGE_PATTERNS.find(({ pattern }) =>
      pattern.test(payload.error ?? '')
    );
    if (matchedLegacyPattern) {
      return matchedLegacyPattern.code;
    }
  }

  return undefined;
};

export const normalizeConversationCreateErrorCode = (error: unknown): ConversationCreateErrorCode | undefined => {
  const workspaceCode = normalizeWorkspacePathErrorCode(error);
  if (workspaceCode === 'WORKSPACE_PATH_UNAVAILABLE') {
    return workspaceCode;
  }

  const payload = getWorkspacePathErrorPayload(error);
  if (!payload?.code) {
    return undefined;
  }
  return TEAM_BACKEND_ERROR_CODE_MAP[payload.code];
};

export const normalizeConversationRuntimeWorkspaceErrorCode = (
  error: unknown
): ConversationRuntimeWorkspaceErrorCode | undefined => {
  const code = normalizeWorkspacePathErrorCode(error);
  return code === 'WORKSPACE_PATH_RUNTIME_UNAVAILABLE' ? code : undefined;
};

/**
 * Wraps the backend's own text (or "Unknown error") in a translated headline, e.g.
 * `(detail) => t('team.create.errorWithDetail', { error: detail })`.
 */
export type ErrorHeadline = (detail: string) => string;

const getRawErrorText = (error: unknown, t: TFunction): string => {
  const payload = getWorkspacePathErrorPayload(error);
  return payload?.error || parseError(error) || t('common.unknownError');
};

/** A create problem the app knows (workspace path, team assistant) as its own translated sentence. */
const describeKnownCreateError = (error: unknown, t: TFunction): string | undefined => {
  const normalizedCode = normalizeConversationCreateErrorCode(error);
  if (!normalizedCode) {
    return undefined;
  }

  if (normalizedCode === 'WORKSPACE_PATH_UNAVAILABLE') {
    const workspacePath = getWorkspacePathFromErrorDetails(error);
    return workspacePath
      ? t('conversation.createError.pathVariants.WORKSPACE_PATH_UNAVAILABLE', { workspacePath })
      : t('conversation.createError.codes.WORKSPACE_PATH_UNAVAILABLE');
  }

  const payload = getWorkspacePathErrorPayload(error);
  const details =
    payload?.details && typeof payload.details === 'object' && !Array.isArray(payload.details)
      ? (payload.details as TeamAssistantErrorDetails)
      : undefined;
  if (normalizedCode === 'TEAM_ASSISTANT_NOT_FOUND') {
    return t('conversation.createError.codes.TEAM_ASSISTANT_NOT_FOUND', { assistantId: details?.assistant_id });
  }
  if (normalizedCode === 'TEAM_ASSISTANT_FIELD_UNSUPPORTED') {
    return t('conversation.createError.codes.TEAM_ASSISTANT_FIELD_UNSUPPORTED', { field: details?.field || 'backend' });
  }
  return t('conversation.createError.codes.TEAM_ASSISTANT_ID_REQUIRED');
};

/**
 * A failed create as a message for the user: a known problem as its own translated sentence, anything else as the
 * backend's text under a translated headline ("Couldn't create the conversation: …" unless `headline` words it for
 * the caller's action).
 */
export const getConversationCreateErrorMessage = (error: unknown, t: TFunction, headline?: ErrorHeadline): string => {
  const known = describeKnownCreateError(error, t);
  if (known) {
    return known;
  }
  const detail = getRawErrorText(error, t);
  return headline ? headline(detail) : t('conversation.createFailedWithDetail', { error: detail });
};

/**
 * A failed create as a detail line under a headline the caller already shows: a known problem as its translated
 * sentence, anything else as the backend's own text.
 */
export const getConversationCreateErrorDetail = (error: unknown, t: TFunction): string =>
  describeKnownCreateError(error, t) ?? getRawErrorText(error, t);

/** An agent that cannot run in its workspace folder, as its own translated sentence. */
const describeKnownRuntimeWorkspaceError = (error: unknown, t: TFunction): string | undefined => {
  const normalizedCode = normalizeConversationRuntimeWorkspaceErrorCode(error);
  if (!normalizedCode) {
    return undefined;
  }
  const workspacePath = getWorkspacePathFromErrorDetails(error);
  return workspacePath
    ? t(`conversation.agentError.codes.${normalizedCode}.bodyWithPath`, { workspacePath })
    : t(`conversation.agentError.codes.${normalizedCode}.body`);
};

/**
 * A failed agent start or send as a message for the user: an unavailable workspace folder as its own translated
 * sentence, anything else as the backend's text under a translated headline ("Couldn't start the agent: …" unless
 * `headline` words it for the caller's action).
 */
export const getConversationRuntimeWorkspaceErrorMessage = (
  error: unknown,
  t: TFunction,
  headline?: ErrorHeadline
): string => {
  const known = describeKnownRuntimeWorkspaceError(error, t);
  if (known) {
    return known;
  }
  const detail = getRawErrorText(error, t);
  return headline ? headline(detail) : t('conversation.agentStartFailedWithDetail', { error: detail });
};

/**
 * A failed agent start or send as a detail line under a headline the caller already shows (an error tip, a failed
 * send): an unavailable workspace folder as its translated sentence, anything else as the backend's own text.
 */
export const getConversationRuntimeWorkspaceErrorDetail = (error: unknown, t: TFunction): string =>
  describeKnownRuntimeWorkspaceError(error, t) ?? getRawErrorText(error, t);
