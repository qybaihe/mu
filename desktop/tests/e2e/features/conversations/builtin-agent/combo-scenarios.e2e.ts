/**
 * BuiltinAgent Chat E2E Tests - Combo Scenarios (P1)
 *
 * Test Cases Covered:
 * - TC-A-10: Folder + second model + yolo mode
 * - TC-A-11: File + non-default model + default mode
 * - TC-A-12: Full combo (folder + file + second model + yolo)
 *
 * Prerequisites:
 * - built-in agent binary available
 * - User logged in
 * - At least 2 ACP models available
 *
 * Data-testid references:
 * - BuiltinAgentModelSelector: data-testid="builtin-agent-model-selector"
 * - AgentModeSelector: data-testid="agent-mode-selector-<built-in agent id>"
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
  type BuiltinAgentTestModels,
} from '../../../helpers';
import { takeScreenshot } from '../../../helpers/screenshots';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe('BuiltinAgent Chat - Combo Scenarios (P1)', () => {
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
  // TC-A-10: Folder + second model + yolo mode
  // ============================================================================

  test('TC-A-10: should handle folder + second model + yolo mode combo', async ({ page }) => {
    const timestamp = Date.now();
    const conversationName = `E2E-builtin-agent-${timestamp}-combo-folder-model-yolo`;
    const tempWorkspace = createTempWorkspace(`tc-a-10-${timestamp}`);

    try {
      // Step 1: Create test folder
      const testFolderPath = path.join(tempWorkspace.path, 'test-folder');
      await fs.mkdir(testFolderPath, { recursive: true });
      await fs.writeFile(path.join(testFolderPath, 'data.txt'), 'Combo test data');

      // Screenshot 01: before creation
      await takeScreenshot(page, `chat-builtin-agent/tc-a-10/01-before.png`);

      // Step 2: Create conversation via bridge with yolo mode
      const conversationId = await createBuiltinAgentConversationViaBridge(page, {
        name: conversationName,
        workspace: testFolderPath,
        provider: preconditions.models!.modelA,
        sessionMode: 'yolo',
      });

      // Step 3: Navigate to conversation page
      await page.goto(`${page.url().split('#')[0]}#/conversation/${conversationId}`);
      await page.waitForLoadState('networkidle');

      // Step 4: Switch to second model
      const modelSelector = page.locator('[data-testid="builtin-agent-model-selector"]');
      await expect(modelSelector).toBeVisible({ timeout: 10000 });
      await modelSelector.click();
      await page.waitForTimeout(500);

      const modelOptions = page.locator('[data-testid^="builtin-agent-model-option-"]');
      const modelCount = await modelOptions.count();

      if (modelCount < 2) {
        test.skip(true, 'Need at least 2 models for this test');
      }

      const secondModel = modelOptions.nth(1);
      await secondModel.click();
      await page.waitForTimeout(1000);

      // Screenshot 02: after model switch
      await takeScreenshot(page, `chat-builtin-agent/tc-a-10/02-model-switched.png`);

      // Step 5: Send message
      await sendBuiltinAgentMessage(page, conversationId, 'List files in the attached folder.');
      await waitForBuiltinAgentReply(page, conversationId);

      // Screenshot 03: reply completed
      await takeScreenshot(page, `chat-builtin-agent/tc-a-10/03-reply.png`);

      // ============================================================================
      // DB Assertions
      // ============================================================================

      // 1. Verify conversation has workspace
      const conversation = await getBuiltinAgentConversationDB(page, conversationId);
      const extra =
        typeof conversation.extra === 'string' ? JSON.parse(conversation.extra || '{}') : conversation.extra || {};
      expect(extra.workspace).toContain('test-folder');

      // 2. Verify mode is yolo (read from conversation.extra.sessionMode)
      expect(extra.sessionMode).toBe('yolo');

      // 3. Verify messages exist
      const messages = await getBuiltinAgentMessages(page, conversationId);
      expect(messages.length).toBeGreaterThanOrEqual(2);
    } finally {
      await tempWorkspace.cleanup();
    }
  });

  // ============================================================================
  // TC-A-11: File + non-default model + default mode
  // ============================================================================

  test('TC-A-11: should handle file + non-default model + default mode combo', async ({ page }) => {
    const timestamp = Date.now();
    const conversationName = `E2E-builtin-agent-${timestamp}-combo-file-model-default`;
    const tempWorkspace = createTempWorkspace(`tc-a-11-${timestamp}`);

    try {
      // Step 1: Create test file
      const testFilePath = path.join(tempWorkspace.path, 'test-file.txt');
      await fs.writeFile(testFilePath, 'File content for combo test');

      // Screenshot 01: before creation
      await takeScreenshot(page, `chat-builtin-agent/tc-a-11/01-before.png`);

      // Step 2: Create conversation via bridge with default mode
      const conversationId = await createBuiltinAgentConversationViaBridge(page, {
        name: conversationName,
        workspace: tempWorkspace.path,
        provider: preconditions.models!.modelA,
        sessionMode: 'default',
      });

      // Step 3: Navigate to conversation page
      await page.goto(`${page.url().split('#')[0]}#/conversation/${conversationId}`);
      await page.waitForLoadState('networkidle');

      // Step 4: Switch to second model
      if (!preconditions.models!.modelB) {
        test.skip(true, 'Need 2nd builtin-agent-compatible model for combo test');
      }

      const modelSelector = page.locator('[data-testid="builtin-agent-model-selector"]');
      await expect(modelSelector).toBeVisible({ timeout: 10000 });
      await modelSelector.click();
      await page.waitForTimeout(500);

      const secondModel = page.locator(
        `[data-testid="builtin-agent-model-option-${preconditions.models!.modelB.useModel}"]`
      );
      await secondModel.waitFor({ state: 'visible', timeout: 5000 });
      await secondModel.click();
      await page.waitForTimeout(1000);

      // Screenshot 02: after model switch
      await takeScreenshot(page, `chat-builtin-agent/tc-a-11/02-model-switched.png`);

      // Step 5: Send message about file
      await sendBuiltinAgentMessage(page, conversationId, 'Read the content of test-file.txt in the workspace.');
      await waitForBuiltinAgentReply(page, conversationId);

      // Screenshot 03: reply completed
      await takeScreenshot(page, `chat-builtin-agent/tc-a-11/03-reply.png`);

      // ============================================================================
      // DB Assertions
      // ============================================================================

      // 1. Verify conversation has workspace
      const conversation = await getBuiltinAgentConversationDB(page, conversationId);
      const extra =
        typeof conversation.extra === 'string' ? JSON.parse(conversation.extra || '{}') : conversation.extra || {};
      expect(extra.workspace).toBe(tempWorkspace.path);

      // 2. Verify mode is default (from conversation.extra.sessionMode, built-in agent doesn't use ACP bridge)
      expect(extra.sessionMode).toBe('default');

      // 3. Verify messages exist
      const messages = await getBuiltinAgentMessages(page, conversationId);
      expect(messages.length).toBeGreaterThanOrEqual(2);
    } finally {
      await tempWorkspace.cleanup();
    }
  });

  // ============================================================================
  // TC-A-12: Full combo (folder + file + second model + yolo)
  // ============================================================================

  test('TC-A-12: should handle full combo (folder + file + second model + yolo)', async ({ page }) => {
    const timestamp = Date.now();
    const conversationName = `E2E-builtin-agent-${timestamp}-full-combo`;
    const tempWorkspace = createTempWorkspace(`tc-a-12-${timestamp}`);

    try {
      // Step 1: Create test folder and file
      const testFolderPath = path.join(tempWorkspace.path, 'combo-folder');
      await fs.mkdir(testFolderPath, { recursive: true });
      await fs.writeFile(path.join(testFolderPath, 'file1.txt'), 'First file content');
      await fs.writeFile(path.join(testFolderPath, 'file2.txt'), 'Second file content');

      // Screenshot 01: before creation
      await takeScreenshot(page, `chat-builtin-agent/tc-a-12/01-before.png`);

      // Step 2: Create conversation via bridge with yolo mode
      const conversationId = await createBuiltinAgentConversationViaBridge(page, {
        name: conversationName,
        workspace: testFolderPath,
        provider: preconditions.models!.modelA,
        sessionMode: 'yolo',
      });

      // Step 3: Navigate to conversation page
      await page.goto(`${page.url().split('#')[0]}#/conversation/${conversationId}`);
      await page.waitForLoadState('networkidle');

      // Step 4: Switch to second model
      const modelSelector = page.locator('[data-testid="builtin-agent-model-selector"]');
      await expect(modelSelector).toBeVisible({ timeout: 10000 });
      await modelSelector.click();
      await page.waitForTimeout(500);

      const modelOptions = page.locator('[data-testid^="builtin-agent-model-option-"]');
      const modelCount = await modelOptions.count();

      if (modelCount < 2) {
        test.skip(true, 'Need at least 2 models for this test');
      }

      const secondModel = modelOptions.nth(1);
      await secondModel.click();
      await page.waitForTimeout(1000);

      // Screenshot 02: after model switch
      await takeScreenshot(page, `chat-builtin-agent/tc-a-12/02-model-switched.png`);

      // Step 5: Send message about folder and files
      await sendBuiltinAgentMessage(
        page,
        conversationId,
        'List all files in the attached folder and read their contents.'
      );
      await waitForBuiltinAgentReply(page, conversationId);

      // Screenshot 03: reply completed
      await takeScreenshot(page, `chat-builtin-agent/tc-a-12/03-reply.png`);

      // ============================================================================
      // DB Assertions
      // ============================================================================

      // 1. Verify conversation has workspace
      const conversation = await getBuiltinAgentConversationDB(page, conversationId);
      const extra =
        typeof conversation.extra === 'string' ? JSON.parse(conversation.extra || '{}') : conversation.extra || {};
      expect(extra.workspace).toContain('combo-folder');

      // 2. Verify mode is yolo (from conversation.extra.sessionMode, built-in agent doesn't use ACP bridge)
      expect(extra.sessionMode).toBe('yolo');

      // 3. Verify messages exist
      const messages = await getBuiltinAgentMessages(page, conversationId);
      expect(messages.length).toBeGreaterThanOrEqual(2);

      const userMessages = messages.filter((m) => m.position === 'right');
      expect(userMessages.length).toBeGreaterThanOrEqual(1);

      const aiMessages = messages.filter((m) => m.position === 'left');
      expect(aiMessages.length).toBeGreaterThanOrEqual(1);
      // Note: message.status is not set to 'finish' for the built-in agent text messages (only conv.status matters)
    } finally {
      await tempWorkspace.cleanup();
    }
  });
});
