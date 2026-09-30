import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Session files for the store and reader tests, in pi's format (session-format.md in the harness). */

export const at = (minute: number): number => Date.UTC(2026, 8, 29, 12, minute);
const iso = (time: number): string => new Date(time).toISOString();

export type Line = Record<string, unknown>;

export const header = (id: string, cwd: string, minute = 0): Line => ({
  type: 'session',
  version: 3,
  id,
  timestamp: iso(at(minute)),
  cwd,
});

export const system = (id: string, parentId: string | null, bytes: number): Line => ({
  type: 'message',
  id,
  parentId,
  timestamp: iso(at(0)),
  message: { role: 'system', content: '', sections: { preamble: 'p'.repeat(bytes) }, timestamp: at(0) },
});

export const user = (id: string, parentId: string | null, text: string, minute: number): Line => ({
  type: 'message',
  id,
  parentId,
  timestamp: iso(at(minute)),
  message: { role: 'user', content: [{ type: 'text', text }], timestamp: at(minute) },
});

export const assistant = (id: string, parentId: string | null, text: string, minute: number): Line => ({
  type: 'message',
  id,
  parentId,
  timestamp: iso(at(minute)),
  message: {
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'e2e',
    model: 'e2e-fake-model',
    stopReason: 'stop',
    timestamp: at(minute),
  },
});

export const toolOutput = (id: string, parentId: string | null, bytes: number, minute: number): Line => ({
  type: 'message',
  id,
  parentId,
  timestamp: iso(at(minute)),
  message: {
    role: 'toolResult',
    toolCallId: `call-${id}`,
    toolName: 'bash',
    content: [{ type: 'text', text: 'o'.repeat(bytes) }],
    isError: false,
    timestamp: at(minute),
  },
});

export const info = (id: string, parentId: string | null, name: string, minute: number): Line => ({
  type: 'session_info',
  id,
  parentId,
  timestamp: iso(at(minute)),
  name,
});

const text = (lines: Line[]): string => lines.map((line) => `${JSON.stringify(line)}\n`).join('');

export function writeSession(file: string, lines: Line[]): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text(lines));
  return file;
}

export function appendSession(file: string, lines: Line[]): void {
  appendFileSync(file, text(lines));
}
