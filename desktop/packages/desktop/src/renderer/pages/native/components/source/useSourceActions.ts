/**
 * What the person does to the files of the source tab: stage them, or take them out of the index (common/kyrn/
 * gitBridge.ts). One action at a time; its rows are busy until git answers, and the tab reads the repository again
 * after it, done or not. A refusal is said in a message with git's first line.
 */
import { Message } from '@arco-design/web-react';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { unwrap } from '@/common/kyrn/bridge';
import { kyrnGitBridge, type GitChange } from '@/common/kyrn/gitBridge';
import { changeKey } from '../../utils/gitRows';

export type SourceAction = 'stage' | 'unstage';

/** The paths an action names for a change: a rename taken out of the index takes its old path with it. */
const pathsOf = (action: SourceAction, change: GitChange): string[] =>
  action === 'unstage' && change.from ? [change.path, change.from] : [change.path];

export function useSourceActions(
  cwd: string,
  read: () => void
): { busy: ReadonlySet<string>; act: (action: SourceAction, changes: GitChange[]) => Promise<void> } {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const going = useRef(false);

  const act = useCallback(
    async (action: SourceAction, changes: GitChange[]) => {
      if (going.current || changes.length === 0) return;
      going.current = true;
      setBusy(new Set(changes.map(changeKey)));
      const paths = [...new Set(changes.flatMap((change) => pathsOf(action, change)))];
      try {
        unwrap(await kyrnGitBridge[action].invoke({ cwd, paths }));
      } catch (error) {
        Message.error(
          t('mu.native.panel.source.actionFailed', { reason: error instanceof Error ? error.message : String(error) })
        );
      } finally {
        going.current = false;
        setBusy(new Set());
        read();
      }
    },
    [cwd, read, t]
  );

  return { busy, act };
}
