/**
 * What quick open (Cmd/Ctrl+P) lists for a query: the folder's files whose name or path spells it, best first.
 *
 * A query matches a file's name or its whole path, as one run of characters (`store` in `workPanelStore.ts`) or in
 * order with gaps (`wps` in `workPanelStore.ts`); case does not matter. Its name before its path, a run before gaps:
 * first the name the query is all of but the extension (`store` for `store.ts`), then a name it starts, then the others;
 * among equals, the shorter name, then the shorter path, then by path.
 */

/** Files a query lists at most; with no query, the first ones of the folder's list. */
export const QUICK_OPEN_ROWS = 50;

/** One row: the path, its name and its folder apart, and which characters of each the query matched. */
export type QuickOpenRow = { path: string; name: string; dir: string; nameHits: number[]; dirHits: number[] };

/** Where `query` is in `text` as one run, case aside; null when it is not. */
function runHits(text: string, query: string): number[] | null {
  const start = text.toLowerCase().indexOf(query);
  return start < 0 ? null : Array.from({ length: query.length }, (_, index) => start + index);
}

/** The characters of `text` that spell `query` in order, each taken as early as it comes; null when they do not. */
function gapHits(text: string, query: string): number[] | null {
  const lower = text.toLowerCase();
  const hits: number[] = [];
  let from = 0;
  for (const char of query) {
    const at = lower.indexOf(char, from);
    if (at < 0) return null;
    hits.push(at);
    from = at + 1;
  }
  return hits;
}

const split = (path: string): { name: string; dir: string } => {
  const cut = path.lastIndexOf('/') + 1;
  return { name: path.slice(cut), dir: path.slice(0, cut) };
};

/** The rows for `query` from `paths`, best first, at most `limit`. */
export function rankFiles(paths: readonly string[], query: string, limit = QUICK_OPEN_ROWS): QuickOpenRow[] {
  const keyword = query.trim().toLowerCase().replace(/\\/g, '/');
  if (!keyword)
    return paths.slice(0, limit).map((path): QuickOpenRow => ({ path, ...split(path), nameHits: [], dirHits: [] }));
  const scored: { row: QuickOpenRow; rank: number }[] = [];
  for (const path of paths) {
    const { name, dir } = split(path);
    let rank: number;
    let hits: number[] | null;
    let inName = true;
    if ((hits = runHits(name, keyword)))
      rank = hits[0] > 0 ? 2 : name.length === keyword.length || name[keyword.length] === '.' ? 0 : 1;
    else if ((hits = gapHits(name, keyword))) rank = 3;
    else {
      inName = false;
      if ((hits = runHits(path, keyword))) rank = 4;
      else if ((hits = gapHits(path, keyword))) rank = 5;
      else continue;
    }
    const nameHits = inName ? hits : hits.filter((at) => at >= dir.length).map((at) => at - dir.length);
    const dirHits = inName ? [] : hits.filter((at) => at < dir.length);
    scored.push({ row: { path, name, dir, nameHits, dirHits }, rank });
  }
  return scored
    .toSorted(
      (a, b) =>
        a.rank - b.rank ||
        a.row.name.length - b.row.name.length ||
        a.row.path.length - b.row.path.length ||
        a.row.path.localeCompare(b.row.path)
    )
    .slice(0, limit)
    .map(({ row }) => row);
}
