/**
 * The conversations page's way in for Claude Code, Codex and ZCode conversations: one row with the three tools' marks,
 * and the dialog it opens
 * (./ImportChatsModal.tsx), which looks for them only once it is open. An action, not a setting: nothing here is
 * stored.
 */
import { Button } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IMPORT_TOOL_NAMES, IMPORT_TOOLS } from '@/common/kyrn/importChats';
import ImportToolMark from '@/renderer/components/brand/ImportToolMark';
import PreferenceRow from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/PreferenceRow';
import ImportChatsModal from './ImportChatsModal';

const ImportChats: React.FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // A list of its own under the page's rows (settings.css): a hairline above, no box around it.
  return (
    <>
      <div className='settings-list' data-testid='import-chats'>
        <PreferenceRow label={t('mu.importChats.title')} description={t('mu.importChats.description')}>
          <span className='flex items-center gap-12px'>
            <span className='flex items-center gap-6px text-t-secondary'>
              {IMPORT_TOOLS.map((tool) => (
                <span key={tool} className='flex' title={IMPORT_TOOL_NAMES[tool]}>
                  <ImportToolMark tool={tool} size={18} />
                </span>
              ))}
            </span>
            <Button onClick={() => setOpen(true)}>{t('mu.importChats.open')}</Button>
          </span>
        </PreferenceRow>
      </div>
      {open ? <ImportChatsModal visible onClose={() => setOpen(false)} /> : null}
    </>
  );
};

export default ImportChats;
