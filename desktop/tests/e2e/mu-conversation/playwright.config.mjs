// The conversation E2E tests' own Playwright configuration: one serial file, one app, generous but bounded times.
// Run through `bun run e2e:conversation` (scripts/kyrn/e2e-conversation.mjs), which builds the app first. MU_E2E_SPEC=native
// (`--native`) runs the native host's file instead of the conversation on AionCore.
import { defineConfig } from '@playwright/test';

const native = process.env.MU_E2E_SPEC === 'native';
const name = native ? 'mu-native' : 'mu-conversation';

export default defineConfig({
  testDir: '.',
  testMatch: native ? 'native*.spec.mjs' : 'conversation.spec.mjs',
  // A step waits on the app, the backend and mu; the slowest (the first start, a relaunch) take well under a minute.
  timeout: 4 * 60_000,
  // The whole run: a stuck app fails the run instead of hanging a CI job.
  globalTimeout: 20 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI
    ? [['github'], ['list'], ['html', { open: 'never', outputFolder: `../report/${name}` }]]
    : [['list'], ['html', { open: 'never', outputFolder: `../report/${name}` }]],
  use: { trace: 'off' },
  outputDir: `../results/${name}`,
});
