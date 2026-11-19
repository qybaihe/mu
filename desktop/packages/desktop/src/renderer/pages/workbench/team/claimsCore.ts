/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Claims: what an agent's final reply says it did or is doing, checked against
 * the machine. A reply that links to a local file which is not there, or
 * announces work while no tool ran in the turn, gets a marker on the message.
 * The marker is only for the reader: nothing is retried, resent or reworded.
 *
 * Direct port of DS-Bot's `claims.js`/`links.js` (90+51 lines, pure functions)
 * with the file-existence check injected: the renderer has no fs, so
 * `missingFileRefs` returns candidates and the caller checks them through the
 * backend. Only deliberate Markdown file links are checked — inline code and
 * plain prose paths are diagnostics and examples, not existence promises.
 */

const GLOB = /[*?[\]{}]/;
const LINE_COL = /:\d+(?::\d+)?$/;
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;
const LINK = /(!?\[[^\]\n]*\]\()(<[^<>\n]*>|[^\s()<>]+)((?:\s+"[^"\n]*")?\))/g;
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/;
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

const decodeTarget = (target: string): string | undefined => {
  try {
    return decodeURIComponent(target);
  } catch {
    return undefined;
  }
};

/** One markdown link destination, as the chat would open it, or undefined when it is not a file path. */
const fileTargetOf = (destination: string): string | undefined => {
  const stripped = destination.startsWith('<') ? destination.slice(1, -1) : destination;
  const hash = stripped.indexOf('#');
  const target = hash < 0 ? stripped : stripped.slice(0, hash);
  const fragment = hash < 0 ? '' : stripped.slice(hash);
  if (target === '' || target.includes('?') || (fragment !== '' && !/^#L[1-9]\d*(?:-L[1-9]\d*)?$/.test(fragment))) {
    return undefined;
  }
  const path = decodeTarget(target);
  if (path === undefined) return undefined;
  const control = [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  if (control || /^[\\/]{2}/.test(path) || (!ABSOLUTE.test(path) && SCHEME.test(path))) return undefined;
  return path;
};

/** The local paths a reply links to, in appearance order, deduplicated. Folder links and globs are skipped. */
export const fileRefsOf = (text: string): string[] => {
  if (typeof text !== 'string' || text === '') return [];
  const found: string[] = [];
  const seen = new Set<string>();
  const parts = text.split(CODE);
  for (let index = 0; index < parts.length; index += 2) {
    for (const match of parts[index].matchAll(LINK)) {
      const path = fileTargetOf(match[2]);
      if (path === undefined) continue;
      const trimmed = path.trim();
      if (trimmed === '' || trimmed === '~' || trimmed.endsWith('/') || trimmed.endsWith('\\') || GLOB.test(trimmed)) {
        continue;
      }
      const key = trimmed.replace(/\\/g, '/');
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(trimmed);
    }
  }
  return found;
};

/** Resolve one raw link against the turn's workspace the way the file service does. */
export const resolveClaimPath = (raw: string, workspace: string | undefined): string => {
  const normalized = raw.replace(/\\/g, '/');
  if (ABSOLUTE.test(normalized) || normalized.startsWith('~/') || normalized === '~') {
    return normalized.replace(/\/+$/, '');
  }
  const base = (workspace ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return base === '' ? normalized : `${base}/${normalized}`;
};

/**
 * The file-check candidates of a reply: `{ raw, path }` for every linked path,
 * plus the `:line:col`-stripped retry when the raw link carries the suffix.
 * `home` is injected (the renderer cannot ask the OS); `~` paths resolve
 * against it so a `~/x` link checks the same file the shell would.
 */
export type FileCheckCandidate = { raw: string; path: string };

export const fileCheckCandidates = (
  text: string,
  workspace: string | undefined,
  home: string | undefined
): FileCheckCandidate[] => {
  const candidates: FileCheckCandidate[] = [];
  const seen = new Set<string>();
  const expandHome = (path: string): string => {
    if (!home) return path;
    if (path === '~') return home;
    if (path.startsWith('~/')) return `${home.replace(/\/+$/, '')}/${path.slice(2)}`;
    return path;
  };
  for (const raw of fileRefsOf(text)) {
    const absolute = expandHome(resolveClaimPath(raw, workspace));
    if (!seen.has(absolute)) {
      seen.add(absolute);
      candidates.push({ raw, path: absolute });
    }
    if (LINE_COL.test(raw)) {
      const stripped = raw.replace(LINE_COL, '');
      if (stripped !== '' && !/^[a-z]:$/i.test(stripped)) {
        const strippedAbsolute = expandHome(resolveClaimPath(stripped, workspace));
        if (!seen.has(strippedAbsolute)) {
          seen.add(strippedAbsolute);
          candidates.push({ raw, path: strippedAbsolute });
        }
      }
    }
  }
  return candidates;
};

// English and Chinese phrases that announce work in progress. Within each sentence, only
// what comes after the last completion phrase counts: "was checking earlier, now completed"
// is done, whereas "part 1 completed, still exporting part 2" still announces ongoing work.
const AFTER_DONE =
  /^[\s\S]*(?:已完成|已经完成|完成了|已导出|已生成|已保存|做好了|搞定|finished|completed|here (?:is|are)\b)/i;
const IN_PROGRESS =
  /\b(?:i(?:'m| am)|we(?:'re| are)|still|currently)\s+(?:still\s+)?(?:working on|working|running|exporting|generating|building|preparing|processing|checking|investigating|researching|drafting|writing|putting together)\b|\b(?:will|going to|about to)\s+(?:report|send|share|finish|follow up|come back)\b|\b(?:in progress|on it now|working on it)\b|(?:正在|还在|仍在)(?:导出|生成|处理|整理|制作|编写|准备|检查|调查|运行|执行|做|写|搜索|分析)|(?:稍后|待会|马上|一会儿|等下)(?:汇报|回复|发|给你|回来|完成)|进行中|处理中|马上回来/;

/** True when the prose (code blocks excluded) announces work still in progress. */
export const announcesWork = (text: string): boolean => {
  if (typeof text !== 'string') return false;
  const prose = text
    .split(CODE)
    .filter((_, index) => index % 2 === 0)
    .join(' ')
    .trim();
  if (prose === '') return false;
  return prose.split(/[\r\n。！？!?；;]+/).some((sentence) => {
    const tail = sentence.replace(AFTER_DONE, '').trim();
    return tail !== '' && IN_PROGRESS.test(tail);
  });
};

/** The marker data for one final reply. `worked` is whether the turn used any tool. */
export type ReplyClaims = { missingFiles: string[]; inProgress?: true };

/**
 * The claims of one final reply given what the machine says: `missingFiles`
 * are the checked-and-missing raw links; the in-progress marker needs the
 * reply to announce work while the turn did nothing (`worked` false).
 */
export const claimsFor = (input: {
  text: string;
  missingFiles: readonly string[];
  worked: boolean;
}): ReplyClaims | undefined => {
  const missingFiles = [...input.missingFiles];
  const inProgress = !input.worked && announcesWork(input.text);
  if (missingFiles.length === 0 && !inProgress) return undefined;
  return { missingFiles, ...(inProgress ? { inProgress: true } : {}) };
};

/** The in-progress half on its own, for renders before the async file check lands. */
export const inProgressClaimOf = (text: string, worked: boolean): boolean => !worked && announcesWork(text);
