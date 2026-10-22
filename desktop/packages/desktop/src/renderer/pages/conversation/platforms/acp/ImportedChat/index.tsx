/**
 * The top of a conversation made from a Claude Code, Codex or ZCode conversation: its tool's mark, where it came from,
 * how much came along, and a way to read what was said before (common/kyrn/importChats.ts). In place of the greeting
 * while the conversation has no message of its own yet, and above its first message after that.
 */
import { Button } from '@arco-design/web-react';
import classNames from 'classnames';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IMPORT_TOOL_NAMES, type ImportMark } from '@/common/kyrn/importChats';
import ImportToolMark from '@/renderer/components/brand/ImportToolMark';
import { formatNumber } from '@/renderer/services/i18n/format';
import ImportedHistoryModal from './ImportedHistoryModal';

type Props = {
  conversationId: string;
  mark: ImportMark;
  /** Above the conversation's own messages, rather than alone in the empty conversation. */
  inline?: boolean;
};

const ImportedChatNotice: React.FC<Props> = ({ conversationId, mark, inline = false }) => {
  const { t, i18n } = useTranslation();
  const [reading, setReading] = useState(false);
  const tool = IMPORT_TOOL_NAMES[mark.tool];
  const number = (value: number) => formatNumber(value, i18n.language);
  return (
    <div
      data-testid='imported-chat-notice'
      className={classNames(
        'flex flex-col gap-6px',
        inline ? 'mb-16px pb-12px border-b border-border-2' : 'items-center px-24px text-center max-w-440px'
      )}
    >
      <span className='flex items-center gap-8px text-15px font-600 leading-22px text-t-primary'>
        <ImportToolMark tool={mark.tool} size={18} />
        {t('mu.importChats.notice.title', { tool })}
      </span>
      <span className='text-12px leading-18px text-t-tertiary break-all' title={mark.source}>
        {mark.source}
      </span>
      <span className='text-13px leading-20px text-t-secondary'>
        {t('mu.importChats.notice.counts', {
          user: number(mark.user),
          assistant: number(mark.assistant),
          toolCalls: number(mark.toolCalls),
        })}
      </span>
      {inline ? null : (
        <span className='text-13px leading-20px text-t-secondary' style={{ textWrap: 'balance' }}>
          {t('mu.importChats.notice.goOn')}
        </span>
      )}
      <span>
        <Button type='text' size='small' className='!px-0' onClick={() => setReading(true)}>
          {t('mu.importChats.notice.read')}
        </Button>
      </span>
      <ImportedHistoryModal
        conversationId={conversationId}
        tool={tool}
        visible={reading}
        onClose={() => setReading(false)}
      />
    </div>
  );
};

export default ImportedChatNotice;
