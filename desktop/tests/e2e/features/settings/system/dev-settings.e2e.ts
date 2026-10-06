/**
 * DevSettings E2E Tests
 *
 * Covers: DevTools toggle, the way to the in-app browser page's switch (the one switch of the browser connection),
 * CDP URL display, MCP config collapse.
 * Only visible in dev mode — gracefully skips when hidden.
 * All operations via UI — zero invokeBridge, zero mock.
 */

import { test, expect } from '../../../fixtures';
import { goToSettings, waitForSettle } from '../../../helpers/navigation';
import { takeScreenshot } from '../../../helpers/screenshots';
import { ARCO_SWITCH } from '../../../helpers/selectors';

function devSection(page: import('@playwright/test').Page) {
  return page.getByTestId('dev-settings');
}

async function scrollToDevSettings(page: import('@playwright/test').Page): Promise<boolean> {
  const section = devSection(page);
  await section.scrollIntoViewIfNeeded().catch(() => {});
  return section.isVisible({ timeout: 3_000 }).catch(() => false);
}

test.describe('DevSettings', () => {
  test.beforeEach(async ({ page }) => {
    await goToSettings(page, 'developer');
    await waitForSettle(page);
  });

  test('TC-DEV-01: DevTools button is visible with correct label', async ({ page }) => {
    const visible = await scrollToDevSettings(page);
    if (!visible) {
      test.skip(true, 'DevSettings not visible — not in dev mode');
      return;
    }

    const btn = devSection(page).locator('button:has-text("DevTools")').first();
    await expect(btn).toBeVisible();
    const text = await btn.textContent();
    expect(text).toBeTruthy();
    expect(text).toMatch(/DevTools/i);
    await takeScreenshot(page, 'dev-settings/tc-dev-01/01-visible.png');
  });

  test("TC-DEV-02: has no browser switch of its own and leads to the in-app browser page's", async ({ page }) => {
    const visible = await scrollToDevSettings(page);
    if (!visible) {
      test.skip(true, 'DevSettings not visible — not in dev mode');
      return;
    }

    const section = devSection(page);
    await expect(section.locator(ARCO_SWITCH)).toHaveCount(0);
    await takeScreenshot(page, 'dev-settings/tc-dev-02/01-no-switch.png');

    await section.getByRole('button', { name: /in-app browser settings/i }).click();
    await page.waitForURL(/#\/settings\/browser/);
    await expect(page.locator(ARCO_SWITCH).first()).toBeVisible();
    await takeScreenshot(page, 'dev-settings/tc-dev-02/02-browser-page.png');
  });

  test('TC-DEV-03: should display CDP URL with port, Link and Copy buttons', async ({ page }) => {
    const visible = await scrollToDevSettings(page);
    if (!visible) {
      test.skip(true, 'DevSettings not visible — not in dev mode');
      return;
    }

    const section = devSection(page);
    const portText = section.locator('text=/127\\.0\\.0\\.1:\\d+/').first();
    const portVisible = await portText.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!portVisible) {
      test.skip(true, 'CDP port not available — the agent may not use the in-app browser');
      return;
    }

    await expect(portText).toBeVisible();
    const urlRow = portText.locator('xpath=ancestor::div[contains(@class,"flex")][1]');
    const btnCount = await urlRow.locator('button').count();
    expect(btnCount).toBe(2);
    await takeScreenshot(page, 'dev-settings/tc-dev-03/01-url-and-buttons.png');
  });

  test('TC-DEV-04: should expand MCP config and show code block with Copy', async ({ page }) => {
    const visible = await scrollToDevSettings(page);
    if (!visible) {
      test.skip(true, 'DevSettings not visible — not in dev mode');
      return;
    }

    const section = devSection(page);
    const collapseHeaders = section.locator('.arco-collapse-item-header');
    const headerCount = await collapseHeaders.count().catch(() => 0);
    if (headerCount === 0) {
      test.skip(true, 'MCP Collapse not available — CDP port may not be active');
      return;
    }

    const firstHeader = collapseHeaders.first();
    await expect(firstHeader).toBeVisible();
    const copyBtn = firstHeader.locator('button').first();
    await expect(copyBtn).toBeVisible();
    await takeScreenshot(page, 'dev-settings/tc-dev-04/01-collapsed.png');

    await firstHeader.click();
    const preBlock = section.locator('pre').first();
    await expect(preBlock).toBeVisible();
    expect(await preBlock.textContent()).toContain('mcpServers');
    await takeScreenshot(page, 'dev-settings/tc-dev-04/02-expanded.png');

    await firstHeader.click();
    await page
      .waitForFunction((sel) => document.querySelector(sel)?.clientHeight === 0, '.arco-collapse-item-content', {
        timeout: 3_000,
      })
      .catch(() => {});
  });
});
