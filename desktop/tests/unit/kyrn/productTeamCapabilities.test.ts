/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  TEAM_ENV_PASS_NAME,
  TEAM_RUNTIME_TOKEN,
  needsTeamCapabilities,
  withTeamEnvPass,
  withTeamSupport,
} from '@process/agent/kyrn/product';

/**
 * The team-capability merge on mu's agent registration (product.ts): a custom
 * agent defaults to no team support and its command env is credential-scrubbed,
 * so the registration must add `supports_team` and pass the team CLI's runtime
 * token through `MU_PASS_ENV` without narrowing anything the user set.
 */

describe('withTeamEnvPass', () => {
  it('adds the pass row to an empty env', () => {
    expect(withTeamEnvPass([])).toEqual([{ name: TEAM_ENV_PASS_NAME, value: TEAM_RUNTIME_TOKEN }]);
  });

  it('appends the token to a user-set MU_PASS_ENV, keeping its other names and rows', () => {
    const rows = [
      { name: 'OTHER_VAR', value: 'x' },
      { name: TEAM_ENV_PASS_NAME, value: 'SECRET_KEY_1 SECRET_KEY_2' },
    ];
    expect(withTeamEnvPass(rows)).toEqual([
      { name: 'OTHER_VAR', value: 'x' },
      { name: TEAM_ENV_PASS_NAME, value: `SECRET_KEY_1 SECRET_KEY_2 ${TEAM_RUNTIME_TOKEN}` },
    ]);
  });

  it('leaves a pass list that already names the token as it is', () => {
    const rows = [{ name: TEAM_ENV_PASS_NAME, value: TEAM_RUNTIME_TOKEN }];
    expect(withTeamEnvPass(rows)).toEqual(rows);
  });

  it('drops env entries that are not name/value rows', () => {
    expect(withTeamEnvPass([{ name: 'X' }, 'junk', null, { name: 'Y', value: '1' }])).toEqual([
      { name: 'Y', value: '1' },
      { name: TEAM_ENV_PASS_NAME, value: TEAM_RUNTIME_TOKEN },
    ]);
  });
});

describe('withTeamSupport', () => {
  it('turns team support on over an empty policy', () => {
    expect(withTeamSupport(undefined)).toEqual({ supports_team: true });
  });

  it('keeps every other policy field of the registration', () => {
    expect(withTeamSupport({ supports_side_question: false, supports_team: false, custom: 'keep' })).toEqual({
      supports_side_question: false,
      supports_team: true,
      custom: 'keep',
    });
  });
});

describe('needsTeamCapabilities', () => {
  it('flags registrations without explicit team support, including a missing policy', () => {
    expect(needsTeamCapabilities({ id: 'a', name: 'mu', enabled: true })).toBe(true);
    expect(needsTeamCapabilities({ id: 'a', name: 'mu', enabled: true, behavior_policy: {} })).toBe(true);
    expect(
      needsTeamCapabilities({ id: 'a', name: 'mu', enabled: true, behavior_policy: { supports_team: true } })
    ).toBe(false);
  });
});
