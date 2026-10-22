/**
 * What an imported conversation said before it came to mu, read back from mu's session: the person's messages, the
 * answers with the tools they called, and the summaries compactions left (common/kyrn/importChats.ts). Plain text: the
 * words as they were written. The settings dialogs' frame (MuModal's standard variant, as the import dialog): the
 * title at the start and a close button.
 */
import { Spin } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { toolTally, type ImportedHistory, type ImportedHistoryItem } from '@/common/kyrn/importChats';
import MuModal from '@/renderer/components/base/MuModal';
import { formatNameList } from '@/renderer/services/i18n/list';
import { muErrorText, toMuError, type MuErrorText } from '@/renderer/pages/settings/KyrnSettings/fields/muError';

type Props = {
  conversationId: string;
  /** The tool's own name: Claude Code, Codex. */
  tool: string;
  visible: boolean;
  onClose: () => void;
};

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; history: ImportedHistory }
  | { phase: 'failed'; error: MuErrorText };

const Step: React.FC<{ item: ImportedHistoryItem; tool: string }> = ({ item, tool }) => {
  const { t, i18n } = useTranslation();
  const who =
    item.kind === 'user'
      ? t('mu.importChats.history.you')
      : item.kind === 'summary'
        ? t('mu.importChats.history.summary')
        : tool;
  const tools =
    item.kind === 'assistant'
      ? formatNameList(
          toolTally(item.tools).map(({ name, times }) => (times > 1 ? `${name} ×${times}` : name)),
          i18n.language
        )
      : '';
  return (
    <div className='flex flex-col gap-4px py-12px' data-testid='imported-history-step' data-kind={item.kind}>
      <span className='text-12px font-600 leading-18px text-t-secondary'>{who}</span>
      {item.text ? (
        <div className='text-13px leading-20px text-t-primary whitespace-pre-wrap break-words'>{item.text}</div>
      ) : null}
      {tools ? (
        <span className='text-12px leading-18px text-t-tertiary'>{t('mu.importChats.history.tools', { tools })}</span>
      ) : null}
    </div>
  );
};

const ImportedHistoryModal: React.FC<Props> = ({ conversationId, tool, visible, onClose }) => {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    if (!visible) return;
    let live = true;
    setState({ phase: 'loading' });
    kyrnBridge.importHistory
      .invoke({ conversationId })
      .then((result) => {
        if (live) setState({ phase: 'ready', history: unwrap(result) });
      })
      .catch((error: unknown) => {
        if (live) setState({ phase: 'failed', error: muErrorText(t, i18n.language, toMuError(error)) });
      });
    return () => {
      live = false;
    };
  }, [visible, conversationId, t, i18n.language]);

  return (
    <MuModal
      variant='standard'
      header={{ title: t('mu.importChats.history.title', { tool }), showClose: true }}
      visible={visible}
      onCancel={onClose}
      footer={null}
      style={{ width: 720 }}
      unmountOnExit
    >
      <div className='max-h-[64vh] overflow-y-auto' data-testid='imported-history'>
        {state.phase === 'loading' ? (
          <div className='flex items-center gap-8px py-24px text-13px text-t-secondary'>
            <Spin size={16} />
            {t('mu.importChats.history.loading')}
          </div>
        ) : state.phase === 'failed' ? (
          <div className='py-16px text-13px leading-20px text-t-primary' role='alert'>
            {state.error.text}
            {state.error.detail ? (
              <div className='mt-4px text-12px text-t-tertiary break-words'>{state.error.detail}</div>
            ) : null}
          </div>
        ) : state.history.items.length === 0 ? (
          <div className='py-24px text-13px text-t-secondary'>{t('mu.importChats.history.empty')}</div>
        ) : (
          <div className='flex flex-col divide-y divide-b-base'>
            {state.history.earlier > 0 ? (
              <div className='pb-12px text-12px text-t-tertiary'>
                {t('mu.importChats.history.earlier', { count: state.history.earlier })}
              </div>
            ) : null}
            {state.history.items.map((item, index) => (
              <Step key={index} item={item} tool={tool} />
            ))}
          </div>
        )}
      </div>
    </MuModal>
  );
};

export default ImportedHistoryModal;
