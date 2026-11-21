/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The webhook trigger between the window and the main process
 * (process/services/team/webhook/). The settings page asks for the current
 * state (the URL to copy into an external system) and flips the master
 * switch; per-position modes live in the backend's client settings, which
 * both sides read directly, so they are no bridge traffic.
 */
import { bridge } from '../../../platform/bridge';

/** What the settings section shows; `listening` is false whenever the switch is off. */
export type WebhookStatus = {
  /** The master switch's persisted state (`tools.webhookEnabled`). */
  enabled: boolean;
  /** Whether the loopback listener is actually up right now. */
  listening: boolean;
  /** The OS-assigned port while listening; null otherwise. */
  port: number | null;
  /** The per-installation token (`tools.webhookToken`); empty when never generated. */
  token: string;
  /** `http://127.0.0.1:<port>/hook/<岗位id>` — the template the user completes with a position id. */
  urlTemplate: string | null;
};

export const webhookBridge = {
  /** The current state; a fresh boot answers enabled=false until asked again. */
  status: bridge.buildProvider<WebhookStatus, void>('webhook.status'),
  /** Flips the master switch: enabling starts the listener (generating a token when absent). */
  setEnabled: bridge.buildProvider<WebhookStatus, { enabled: boolean }>('webhook.setEnabled'),
};
