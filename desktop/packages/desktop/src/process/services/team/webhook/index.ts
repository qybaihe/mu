/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Answers `webhook.status` / `webhook.setEnabled`
 * (common/chat/team/webhook/webhookBridge.ts) and syncs the loopback
 * listener with the persisted switch at boot.
 */
export {
  deliverWebhook,
  handleWebhookRequest,
  initWebhookBridge,
  startWebhookListener,
  stopWebhookListener,
  syncWebhookWithSettings,
  type WebhookDeps,
  type WebhookDeliveryResult,
  type WebhookRequestScope,
} from './webhookService';
