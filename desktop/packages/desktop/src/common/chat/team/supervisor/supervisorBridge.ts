/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The supervisor between the window and the main process
 * (process/services/supervisor/). Before the supervisor's first conversation
 * the window asks the main process to prepare its workspace: the injected
 * rules file, the teams.cjs maintenance script, and the TEAMS.md index.
 */
import { bridge } from '../../../platform/bridge';
import type { KyrnResult } from '../../../kyrn/errors';
import type { SupervisorTeam } from './supervisorCore';

/** The supervisor's workspace folder; `changed` says any app-owned file in it was rewritten. */
export type SupervisorWorkspaceResult = { workspace: string; changed: boolean };

/** The shared teams index as the sidebar's team section reads it. */
export type SupervisorTeamsResult = { teams: SupervisorTeam[] };

/** Registers (or refreshes) one team in the shared index: what a manually created group chat does. */
export type SupervisorRegisterTeamParams = {
  name: string;
  positions: string[];
  teamId: string;
  leadConversationId: string;
  /** The creating surface's lifecycle choice; absent on refresh re-registrations. */
  ttlDays?: number;
  permanent?: boolean;
};

/** Sets one team's lifecycle (day count and/or permanent flag): what the monitor card's popover saves. */
export type SupervisorTeamLifecycleParams = { teamId: string; ttlDays?: number; permanent?: boolean };

export const supervisorBridge = {
  /** Prepares (and refreshes) the supervisor workspace: rules, script, teams index. */
  ensure: bridge.buildProvider<KyrnResult<SupervisorWorkspaceResult>, void>('supervisor.ensure'),
  /** The shared TEAMS.md index (active and retired rows), for a team's lifecycle state. */
  teams: bridge.buildProvider<KyrnResult<SupervisorTeamsResult>, void>('supervisor.teams'),
  /** Upserts one team row in the shared index (by team id): registration and member-change refreshes. */
  registerTeam: bridge.buildProvider<KyrnResult<SupervisorTeamsResult>, SupervisorRegisterTeamParams>(
    'supervisor.registerTeam'
  ),
  /** Sets one team's lifecycle (ttlDays / permanent) in the shared index. */
  setTeamLifecycle: bridge.buildProvider<KyrnResult<SupervisorTeamsResult>, SupervisorTeamLifecycleParams>(
    'supervisor.setTeamLifecycle'
  ),
};
