/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Api, Earth, Editor, FileText, PeopleSpeak, Search, Terminal } from '@icon-park/react';
import React from 'react';
import styles from './MessageToolGroupSummary.module.css';

/**
 * A 12px monochrome mark for what a call does, so a column of steps can be skimmed without reading every verb. The
 * kind is read off the tool's own name — the harness names its tools after the work (`read`, `bash`, `delegate`) —
 * and anything unrecognised gets the neutral mark rather than a guess.
 */

type Kind = 'read' | 'edit' | 'shell' | 'search' | 'web' | 'agent' | 'other';

/** In order: the first word of the name that names a kind wins, so `WriteFile` is an edit and not a read. */
const WORDS: ReadonlyArray<readonly [ReadonlySet<string>, Kind]> = [
  [new Set(['bash', 'shell', 'exec', 'terminal', 'command', 'run', 'stdin']), 'shell'],
  [new Set(['write', 'edit', 'replace', 'patch', 'apply', 'notebook', 'create']), 'edit'],
  [new Set(['read', 'cat', 'view', 'open', 'file']), 'read'],
  [new Set(['grep', 'glob', 'search', 'find', 'rg', 'ls', 'list']), 'search'],
  [new Set(['web', 'fetch', 'browser', 'url', 'http', 'curl', 'navigate']), 'web'],
  [new Set(['hive', 'delegate', 'agent', 'task', 'bee', 'swarm']), 'agent'],
];

/** `Shell Command`, `WriteFile`, `mcp__weather__forecast` all come apart into plain lowercase words. */
const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

export const toolKind = (name: string): Kind => {
  const parts = words(name);
  for (const [set, kind] of WORDS) {
    if (parts.some((part) => set.has(part))) return kind;
  }
  return 'other';
};

const ICONS: Record<Kind, React.ComponentType<{ size?: number | string; theme?: 'outline' }>> = {
  read: FileText,
  edit: Editor,
  shell: Terminal,
  search: Search,
  web: Earth,
  agent: PeopleSpeak,
  other: Api,
};

const ToolKindIcon: React.FC<{ name: string }> = ({ name }) => {
  const Icon = ICONS[toolKind(name)];
  return (
    <span className={styles.kindIcon} aria-hidden='true'>
      <Icon size={12} theme='outline' />
    </span>
  );
};

export default ToolKindIcon;
