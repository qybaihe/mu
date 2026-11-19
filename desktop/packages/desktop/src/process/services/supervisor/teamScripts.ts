/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The team script as the app ships it, one module for every workspace that
 * creates teams: the supervisor's and each library position's. The canonical
 * dispatch rules block (single source: dispatchRules.ts) is injected at the
 * script's placeholder, so a team built over REST is seeded at creation —
 * whoever's workspace ran the `add`.
 */
import teamsScriptSource from '@/common/chat/supervisor/teams.cjs?raw';
import { TEAM_DISPATCH_RULES_BLOCK } from '@/common/chat/teamDispatch/dispatchRules';

export const shippedTeamsScript = teamsScriptSource.replace(
  '/* mu-dispatch-rules-block */ null',
  JSON.stringify(TEAM_DISPATCH_RULES_BLOCK)
);
