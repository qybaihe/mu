/**
 * BuiltinAgent Chat E2E Tests - Permission Modes (P0 + P1)
 *
 * Test Cases Covered:
 * - TC-A-05: Use non-default permission (guid page selection)
 * - TC-A-06: Switch permission mid-conversation
 *
 * Prerequisites:
 * - built-in agent binary available
 * - User logged in
 * - At least 1 ACP model available
 *
 * Data-testid references:
 * - AgentModeSelector: data-testid="agent-mode-selector-<built-in agent id>"
 * - Mode options: data-testid="builtin-agent-mode-option-{mode}"
 */

import { test, expect } from '../../../fixtures';
import {
  resolveBuiltinAgentPreconditions,
  cleanupE2EBuiltinAgentConversations,
  createBuiltinAgentConversationViaBridge,
  sendBuiltinAgentMessage,
  waitForBuiltinAgentReply,
  getBuiltinAgentConversationDB,
  getBuiltinAgentMessages,
  createTempWorkspace,
  selectBuiltinAgentAgent,
  type BuiltinAgentTestModels,
} from '../../../helpers';
import { takeScreenshot } from '../../../helpers/screenshots';
import { BUILTIN_AGENT } from '@/common/platform/backendNames';

test.describe('BuiltinAgent Chat - Permission Modes (P0 + P1)', () => {
  test.setTimeout(120000); // 2 minutes

  let preconditions: { binary: string | null; models: BuiltinAgentTestModels | null };

  test.beforeAll(async ({ page }) => {
    preconditions = await resolveBuiltinAgentPreconditions(page);
    if (!preconditions.binary || !preconditions.models) {
      test.skip(true, 'No builtin-agent-compatible provider found, skipping E2E tests');
    }
  });

  test.afterEach(async ({ page }) => {
    // Cleanup order: ESC × 5 → DB → sessionStorage
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Escape');
    }

    await cleanupE2EBuiltinAgentConversations(page);

    await page.evaluate(() => {
      const keysToRemove: string[] = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (
          key &&
          (key.startsWith('builtin_agent_initial_message_') || key.startsWith('builtin_agent_initial_processed_'))
        ) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((key) => sessionStorage.removeItem(key));
    });
  });

  // ============================================================================
  // TC-A-05: Use non-default permission (guid page selection)
  // ============================================================================

  test('TC-A-05: should use yolo permission selected on guid page', async ({ page }) => {
    const timestamp = Date.now();
    const conversationName = `E2E-builtin-agent-${timestamp}-mode-yolo`;
    const tempWorkspace = createTempWorkspace(`tc-a-05-${timestamp}`);

    try {
      // Step 1: Navigate to guid page
      await page.goto(`${page.url().split('#')[0]}#/guid`);
      await page.waitForLoadState('networkidle');

      // Screenshot 01: guid page loaded
      await takeScreenshot(page, `chat-builtin-agent/tc-a-05/01-guid-page.png`);

      // Step 2: Select the built-in agent agent
      await selectBuiltinAgentAgent(page);

      // Step 3: Select yolo mode
      const modeSelector = page.locator(`[data-testid="agent-mode-selector-${BUILTIN_AGENT}"]`);
      await expect(modeSelector).toBeVisible({ timeout: 10000 });
      await modeSelector.click();
      await page.waitForTimeout(500);

      // Screenshot 02: mode selector open
      await takeScreenshot(page, `chat-builtin-agent/tc-a-05/02-mode-selector-open.png`);

      // Select yolo option
      const yoloOption = page.locator('[data-testid="builtin-agent-mode-option-yolo"]');
      await expect(yoloOption).toBeVisible();
      await yoloOption.click();
      await page.waitForTimeout(500);

      // Screenshot 03: yolo mode selected
      await takeScreenshot(page, `chat-builtin-agent/tc-a-05/03-yolo-selected.png`);

      // Step 4: Send message
      const inputBox = page.locator('[data-testid="guid-input"]');
      await inputBox.fill('Please respond with a simple message.');

      const sendButton = page.locator('[data-testid="guid-send-btn"]');
      await sendButton.click();

      // Step 5: Wait for navigation to conversation page
      await page.waitForURL(/#\/conversation\/[a-f0-9-]+/, { timeout: 15000 });

      const url = page.url();
      const match = url.match(/conversation\/([a-f0-9-]+)/);
      expect(match).not.toBeNull();
      const conversationId = match![1];

      // Step 6: Wait for AI reply
      await waitForBuiltinAgentReply(page, conversationId);

      // Screenshot 04: reply completed
      await takeScreenshot(page, `chat-builtin-agent/tc-a-05/04-reply-completed.png`);

      // ============================================================================
      // DB Assertions
      // ============================================================================

      // 1. Verify conversation created with yolo mode
      const conversation = await getBuiltinAgentConversationDB(page, conversationId);
      expect(conversation).toBeDefined();

      // 2. Verify mode from conversation.extra.sessionMode (built-in agent doesn't use ACP bridge)
      const extra =
        typeof conversation.extra === 'string' ? JSON.parse(conversation.extra || '{}') : conversation.extra || {};
      expect(extra.sessionMode).toBe('yolo');

      // 3. Verify messages exist
      const messages = await getBuiltinAgentMessages(page, conversationId);
      expect(messages.length).toBeGreaterThanOrEqual(2);

      const aiMessages = messages.filter((m) => m.position === 'left');
      expect(aiMessages.length).toBeGreaterThanOrEqual(1);
      // Note: message.status is not set to 'finish' for the built-in agent text messages (only conv.status matters)
    } finally {
      await tempWorkspace.cleanup();
    }
  });

  // ============================================================================
  // TC-A-06: Switch permission mid-conversation
  // ============================================================================

  test('TC-A-06: should switch permission mid-conversation and persist to DB', async ({ page }) => {
    const timestamp = Date.now();
    const conversationName = `E2E-builtin-agent-${timestamp}-switch-mode`;
    const tempWorkspace = createTempWorkspace(`tc-a-06-${timestamp}`);

    try {
      // Step 1: Create conversation via bridge with default mode
      const conversationId = await createBuiltinAgentConversationViaBridge(page, {
        name: conversationName,
        workspace: tempWorkspace.path,
        provider: preconditions.models!.modelA,
        sessionMode: 'default',
      });

      // Screenshot 01: before first message
      await takeScreenshot(page, `chat-builtin-agent/tc-a-06/01-conversation-created.png`);

      // Step 2: Send first message
      await sendBuiltinAgentMessage(page, conversationId, 'Hello, please respond.');

      // Step 3: Wait for first AI reply
      await waitForBuiltinAgentReply(page, conversationId);

      // Screenshot 02: first reply completed
      await takeScreenshot(page, `chat-builtin-agent/tc-a-06/02-first-reply.png`);

      // Step 4: Navigate to conversation page
      await page.goto(`${page.url().split('#')[0]}#/conversation/${conversationId}`);
      await page.waitForLoadState('networkidle');

      // Step 5: Switch to yolo mode
      const modeSelector = page.locator(`[data-testid="agent-mode-selector-${BUILTIN_AGENT}"]`);
      await expect(modeSelector).toBeVisible({ timeout: 10000 });
      await modeSelector.click();
      await page.waitForTimeout(500);

      // Screenshot 03: mode selector open
      await takeScreenshot(page, `chat-builtin-agent/tc-a-06/03-mode-selector-open.png`);

      const yoloOption = page.locator('[data-testid="builtin-agent-mode-option-yolo"]');
      await expect(yoloOption).toBeVisible();
      await yoloOption.click();
      await page.waitForTimeout(1000);

      // Screenshot 04: mode switched to yolo
      await takeScreenshot(page, `chat-builtin-agent/tc-a-06/04-mode-switched.png`);

      // Step 6: Send second message
      await sendBuiltinAgentMessage(page, conversationId, 'What mode are we using now?');

      // Step 7: Wait for second AI reply
      await waitForBuiltinAgentReply(page, conversationId);

      // Screenshot 05: second reply completed
      await takeScreenshot(page, `chat-builtin-agent/tc-a-06/05-second-reply.png`);

      // ============================================================================
      // DB Assertions
      // ============================================================================

      // 1. Verify mode switched to yolo
      const conversation = await getBuiltinAgentConversationDB(page, conversationId);
      const extra =
        typeof conversation.extra === 'string' ? JSON.parse(conversation.extra || '{}') : conversation.extra || {};
      expect(extra.sessionMode).toBe('yolo');

      // 2. Verify message count (at least 4: user1, ai1, user2, ai2)
      const messages = await getBuiltinAgentMessages(page, conversationId);
      expect(messages.length).toBeGreaterThanOrEqual(4);

      // 3. Verify both AI replies exist
      const aiMessages = messages.filter((m) => m.position === 'left');
      expect(aiMessages.length).toBeGreaterThanOrEqual(2);
    } finally {
      await tempWorkspace.cleanup();
    }
  });
});
