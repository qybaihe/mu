import { describe, expect, it } from 'vitest';
import { durable, fromEntries, reduceAll } from '@/common/utils/nativeHost/index.ts';

/**
 * mu's checkpoints in the view: its `kyrn.checkpoint` entries on the branch (live from `entry_appended`, in a file as
 * it is), each with the person's message whose turn it was taken in. And the text mu puts into the person's editor (a
 * rewind gives the request back), which only the live host says.
 */

type Json = Record<string, unknown>;

const checkpointEntry = (id: string, data: Json): Json => ({ type: 'custom', id, customType: 'kyrn.checkpoint', data });
const message = (id: string, text: string): Json => ({
  type: 'message',
  id,
  message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
});
function file(entries: Json[]): Json[] {
  return entries.map((entry, index) => ({ ...entry, parentId: index ? entries[index - 1].id : null }));
}
const first = { id: 1, turn: 1, commit: 'c1', entryId: 'u1', label: 'write the docs', at: 10 };
const second = { id: 2, turn: 2, commit: 'c2', entryId: 'u2', label: 'fix the build', at: 20 };

describe('the checkpoints of a view', () => {
  it('are the checkpoint entries on the branch of a file, oldest first, with what they go back to before', () => {
    const entries = file([
      message('u1', 'write the docs'),
      checkpointEntry('k1', first),
      message('u2', 'fix the build'),
      checkpointEntry('k2', second),
    ]);
    expect(fromEntries(entries).checkpoints).toEqual([
      { id: 1, entryId: 'u1', label: 'write the docs', turn: 1, at: 10 },
      { id: 2, entryId: 'u2', label: 'fix the build', turn: 2, at: 20 },
    ]);
    // An earlier leaf: the branch there had the first only.
    expect(fromEntries(entries, 'u2').checkpoints).toEqual([
      { id: 1, entryId: 'u1', label: 'write the docs', turn: 1, at: 10 },
    ]);
    expect(fromEntries(entries, 'u1').checkpoints).toBeUndefined();
  });

  it('come live from the appended entries as from the file; one without a number or a message is left out', () => {
    const entries = [
      checkpointEntry('k1', first),
      checkpointEntry('k2', { ...second, id: 'two' }),
      checkpointEntry('k3', { ...second, entryId: undefined }),
      checkpointEntry('k4', second),
    ];
    const live = reduceAll(entries.map((entry) => ({ type: 'entry_appended', entry })));
    expect(live.checkpoints?.map((checkpoint) => checkpoint.id)).toEqual([1, 2]);
    expect(durable(live)).toEqual(fromEntries(file(entries)));
  });
});

describe('the text mu puts into the person’s editor', () => {
  it('is the live host’s, the latest one, each with its own id', () => {
    const view = reduceAll([
      { type: 'extension_ui_request', id: 'e1', method: 'set_editor_text', text: 'fix the build' },
      { type: 'extension_ui_request', id: 'e2', method: 'set_editor_text', text: 'fix the build' },
    ]);
    expect(view.host.editorText).toEqual({ id: 'e2', text: 'fix the build' });
    expect(view.dialogs).toEqual([]);
    expect(durable(view).host.editorText).toBeUndefined();
  });
});
