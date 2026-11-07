import { describe, expect, it } from 'vitest';
import { QUICK_OPEN_ROWS, rankFiles } from '@/renderer/components/layout/Sider/CommandPalette/quickOpenModel';

/**
 * What quick open (Cmd/Ctrl+P) lists for a query (quickOpenModel.ts): a file's name before its path, one run of
 * characters before characters with gaps, the start of a name first, then the shorter path.
 */

const PATHS = [
  'README.md',
  'src/renderer/components/layout/WorkPanel/workPanelStore.ts',
  'src/renderer/components/layout/WorkPanel/WorkPanelTabs.tsx',
  'src/renderer/stores/store.ts',
  'docs/store-notes.md',
  'tests/unit/workPanelStore.dom.test.ts',
  'src/process/panel/index.ts',
];

const paths = (query: string) => rankFiles(PATHS, query).map((row) => row.path);

describe('quick open', () => {
  it('lists the folder as it came, up to its limit, before anything is typed', () => {
    expect(paths('')).toEqual(PATHS);
    const many = Array.from({ length: QUICK_OPEN_ROWS + 10 }, (_, index) => `f${index}.ts`);
    expect(rankFiles(many, '')).toHaveLength(QUICK_OPEN_ROWS);
  });

  it('puts the name the query is all of first, then one it starts, then one that holds it, then a path', () => {
    expect(paths('store')).toEqual([
      'src/renderer/stores/store.ts',
      'docs/store-notes.md',
      'src/renderer/components/layout/WorkPanel/workPanelStore.ts',
      'tests/unit/workPanelStore.dom.test.ts',
      // Its letters in order through the path: last.
      'src/renderer/components/layout/WorkPanel/WorkPanelTabs.tsx',
    ]);
  });

  it('finds a name by its letters in order, with gaps, case aside', () => {
    expect(paths('wps')[0]).toBe('src/renderer/components/layout/WorkPanel/workPanelStore.ts');
    expect(paths('WPTabs')).toEqual(['src/renderer/components/layout/WorkPanel/WorkPanelTabs.tsx']);
  });

  it('falls back to the whole path, and marks where the query matched in the name and in its folder', () => {
    const [row] = rankFiles(PATHS, 'process/panel');
    expect(row.path).toBe('src/process/panel/index.ts');
    expect(row.name).toBe('index.ts');
    expect(row.dir).toBe('src/process/panel/');
    expect(row.nameHits).toEqual([]);
    expect(row.dirHits).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(rankFiles(PATHS, 'store')[0].nameHits).toEqual([0, 1, 2, 3, 4]);
    expect(paths('zzz')).toEqual([]);
  });
});
