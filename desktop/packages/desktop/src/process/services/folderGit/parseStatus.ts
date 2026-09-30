import type { GitArea, GitBranch, GitChange, GitChangeKind } from '../../../common/kyrn/gitBridge';

/*
 * `git status --porcelain=v2 -z --branch` read into the tab's changes. Every record ends with a NUL; a rename's
 * record is followed by one more, its old path. The fields before a path are fixed in number, so a path keeps its
 * spaces. (git-status(1), "Porcelain Format Version 2".)
 */

/** git's letter for one side of a change, in the X (index) or Y (working tree) column. */
const KINDS: Record<string, GitChangeKind> = {
  M: 'modified',
  T: 'typechange',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
};

/** Fields before the path: `1 XY sub mH mI mW hH hI path`, `2 ... Xscore path`, `u XY sub m1 m2 m3 mW h1 h2 h3 path`. */
const FIELDS_BEFORE_PATH: Record<string, number> = { '1': 8, '2': 9, u: 10 };

/** The path of a record: what follows its fixed fields. */
function pathOf(record: string, fields: number): string {
  let at = 0;
  for (let field = 0; field < fields; field += 1) {
    at = record.indexOf(' ', at) + 1;
    if (at === 0) return '';
  }
  return record.slice(at);
}

/** One ordinary or renamed record as its changes: one for the index side, one for the working tree side. */
function changesOf(xy: string, path: string, from: string | undefined): GitChange[] {
  const changes: GitChange[] = [];
  const sides: Array<[string, GitArea]> = [
    [xy[0] ?? '.', 'staged'],
    [xy[1] ?? '.', 'unstaged'],
  ];
  for (const [letter, area] of sides) {
    if (letter === '.') continue;
    const kind = KINDS[letter] ?? 'modified';
    changes.push(
      from !== undefined && (kind === 'renamed' || kind === 'copied')
        ? { path, area, kind, from }
        : { path, area, kind }
    );
  }
  return changes;
}

/** The branch headers: `# branch.oid <commit> | (initial)`, `# branch.head <name> | (detached)`, upstream, ahead/behind. */
function readHeader(branch: GitBranch, line: string): void {
  const [, key = '', value = ''] = /^# (\S+) ?(.*)$/.exec(line) ?? [];
  if (key === 'branch.oid' && value !== '(initial)') branch.commit = value.slice(0, 7);
  else if (key === 'branch.head' && value !== '(detached)') branch.name = value;
  else if (key === 'branch.upstream') branch.upstream = value;
  else if (key === 'branch.ab') {
    const ab = /^\+(\d+) -(\d+)$/.exec(value);
    if (ab) {
      branch.ahead = Number(ab[1]);
      branch.behind = Number(ab[2]);
    }
  }
}

/**
 * The branch and every change of git's output, in git's order. `complete`: false when the output was cut; its last
 * record may then be partial and is left out.
 */
export function parseStatus(output: string, complete = true): { branch: GitBranch; changes: GitChange[] } {
  const records = output.split('\0');
  // The text after the last NUL is empty when the output is whole, and a partial record when it was cut.
  records.pop();
  if (!complete && records.length > 0 && records.at(-1)?.startsWith('2 ')) records.pop();
  const branch: GitBranch = {};
  const changes: GitChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    const type = record[0] ?? '';
    if (type === '#') readHeader(branch, record);
    else if (type === '?') changes.push({ path: record.slice(2), area: 'untracked', kind: 'untracked' });
    else if (type === 'u')
      changes.push({ path: pathOf(record, FIELDS_BEFORE_PATH.u), area: 'conflicted', kind: 'conflicted' });
    else if (type === '1')
      changes.push(...changesOf(record.slice(2, 4), pathOf(record, FIELDS_BEFORE_PATH['1']), undefined));
    else if (type === '2') {
      const from = records[index + 1];
      index += 1;
      changes.push(...changesOf(record.slice(2, 4), pathOf(record, FIELDS_BEFORE_PATH['2']), from));
    }
  }
  return { branch, changes: changes.filter((change) => change.path) };
}
