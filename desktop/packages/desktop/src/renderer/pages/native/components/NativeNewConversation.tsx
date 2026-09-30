/**
 * Starts a native conversation: in one of the folders recent conversations worked in, or in a folder picked from the
 * disk, with the permission mode its mu starts in (mu's own default unless one is chosen). The new conversation opens,
 * ready for its first message; one that cannot be made says why.
 */
import { Button, Popover, Select } from '@arco-design/web-react';
import { FolderOpen, Plus } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeConversation, NativeFailure } from '@/common/kyrn/nativeBridge';
import { iconColors } from '@/renderer/styles/colors';
import { errorKey } from '../utils/errorWords';
import { useNativeClient } from '../utils/nativeClient';
import { folderName } from '../utils/paths';

/** mu's permission modes (MU_PERMISSIONS), named as the settings name them; '' is mu's own default. */
const MODES = ['full', 'jev', 'ask'] as const;

const NativeNewConversation: React.FC<{ recent: string[]; onCreated: (conversation: NativeConversation) => void }> = ({
  recent,
  onCreated,
}) => {
  const { t } = useTranslation();
  const client = useNativeClient();
  const [open, setOpen] = useState(false);
  const [permissions, setPermissions] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<NativeFailure>();

  const start = async (cwd: string | undefined) => {
    if (!cwd) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await client.create(cwd, permissions || undefined);
      if (result.ok === false) {
        setFailure(result);
        return;
      }
      setOpen(false);
      onCreated(result.data);
    } catch (error) {
      // The IPC itself failed: said as a host that could not start.
      setFailure({ ok: false, kind: 'failed', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <div className='w-280px flex flex-col gap-10px' data-testid='native-new-panel'>
      <div className='text-14px font-500 text-t-primary'>{t('mu.native.new.title')}</div>
      {recent.length ? (
        <div className='flex flex-col gap-2px'>
          <div className='text-12px text-t-tertiary'>{t('mu.native.new.recent')}</div>
          {recent.map((cwd) => (
            <button
              type='button'
              key={cwd}
              title={cwd}
              disabled={busy}
              data-testid='native-recent-folder'
              className='w-full flex items-baseline gap-8px px-8px py-4px rd-6px border-none bg-transparent cursor-pointer text-start hover:bg-fill-3'
              onClick={() => void start(cwd)}
            >
              <span className='shrink-0 text-13px text-t-primary'>{folderName(cwd)}</span>
              <span className='min-w-0 truncate text-12px text-t-tertiary'>{cwd}</span>
            </button>
          ))}
        </div>
      ) : null}
      <Button
        long
        loading={busy}
        icon={<FolderOpen theme='outline' size='14' fill={iconColors.secondary} />}
        data-testid='native-project'
        onClick={() => void client.pickFolder().then(start, () => {})}
      >
        {t('mu.native.new.pick')}
      </Button>
      <div className='flex items-center justify-between gap-8px'>
        <span className='shrink-0 text-12px text-t-secondary'>{t('mu.native.new.permissions')}</span>
        {/* Its list opens inside the popover: one opened on the page would count as a click outside it. */}
        <Select
          size='small'
          className='min-w-0 flex-1'
          data-testid='native-permissions'
          value={permissions}
          onChange={(value: string) => setPermissions(value)}
          getPopupContainer={(node) => node.parentElement ?? document.body}
          options={[
            { label: t('mu.native.new.defaultPermissions'), value: '' },
            ...MODES.map((mode) => ({ label: t(`mu.permissions.modes.${mode}.title`), value: mode })),
          ]}
        />
      </div>
      {failure ? (
        <div className='text-12px leading-18px text-danger [word-break:break-word]' data-testid='native-create-failed'>
          {t(errorKey(failure.kind))} {failure.message}
        </div>
      ) : null}
    </div>
  );

  return (
    <Popover trigger='click' position='rt' popupVisible={open} onVisibleChange={setOpen} content={content}>
      <Button
        type='text'
        size='mini'
        icon={<Plus theme='outline' size='14' />}
        aria-label={t('mu.native.sider.new')}
        title={t('mu.native.sider.new')}
        data-testid='native-new'
      />
    </Popover>
  );
};

export default NativeNewConversation;
