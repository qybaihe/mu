/**
 * What mu may do without asking in this conversation (full access, Jev approves, minimal), as a pill at the left of
 * the send box, with the look of the permission pill in mu's other conversations (AgentModeSelector, compact). The mode
 * in force is mu's latest `permissions.mode` frame, else what the session file says; a pick sends mu's own
 * `/permissions <mode> --here`, which switches this conversation only (the mode new conversations start in is set in
 * the settings). It runs at once, during a run too: mu checks the next call under the new mode.
 */
import { Dropdown, Menu, Tooltip } from '@arco-design/web-react';
import { Down, Shield } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeResult } from '@/common/kyrn/nativeBridge';
import type { PiCommand } from '@/common/utils/nativeHost';
import RuntimeSelectorPill from '@/renderer/components/agent/RuntimeSelectorPill';
import { iconColors } from '@/renderer/styles/colors';
import { permissionCommand, type PermissionState } from './composerModel';

const NativePermissionPill: React.FC<{
  state: PermissionState;
  /** A message is on its way to pi: the switch waits for it. */
  held: boolean;
  request: (command: PiCommand) => Promise<NativeResult<unknown>>;
}> = ({ state, held, request }) => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [switching, setSwitching] = useState(false);
  const { mode, modes } = state;
  const nameOf = (id: string, label?: string): string => t(`agentMode.${id}`, { defaultValue: label || id });
  const current = mode
    ? nameOf(mode, modes.find((each) => each.id === mode)?.label)
    : t('mu.native.new.defaultPermissions');

  const pick = async (next: string) => {
    setVisible(false);
    if (next === mode) return;
    setSwitching(true);
    try {
      await request({ type: 'prompt', message: permissionCommand(next) });
    } finally {
      setSwitching(false);
    }
  };

  const menu = (
    <Menu>
      <Menu.ItemGroup title={t('agentMode.switchMode')}>
        {modes.map((each) => (
          <Menu.Item key={each.id} className={mode === each.id ? '!bg-2' : ''} onClick={() => void pick(each.id)}>
            <div className='flex items-center gap-8px' data-testid='native-permission-option' data-mode={each.id}>
              <span aria-hidden='true' className='w-16px shrink-0 flex items-center text-t-primary'>
                {mode === each.id ? '✓' : ''}
              </span>
              <Tooltip
                content={t(`agentMode.descriptions.${each.id}`, { defaultValue: each.description || each.id })}
                position='right'
              >
                <span className='min-w-0 truncate'>{nameOf(each.id, each.label)}</span>
              </Tooltip>
            </div>
          </Menu.Item>
        ))}
      </Menu.ItemGroup>
    </Menu>
  );

  const disabled = held || switching;
  return (
    <Dropdown
      trigger='click'
      popupVisible={visible && !disabled}
      onVisibleChange={(open) => setVisible(open)}
      droplist={menu}
    >
      <span data-testid='native-permission-pill' data-mode={mode ?? ''} className='inline-flex'>
        <RuntimeSelectorPill
          testId='native-permission'
          className='sendbox-model-btn agent-mode-compact-pill'
          label={`${t('agentMode.permission')} · ${current}`}
          leading={<Shield theme='outline' size='14' fill={iconColors.secondary} className='shrink-0' />}
          trailing={<Down size={12} className='text-t-tertiary shrink-0' />}
          loading={switching}
          disabled={disabled}
          onClick={() => setVisible((open) => !open)}
        />
      </span>
    </Dropdown>
  );
};

export default NativePermissionPill;
