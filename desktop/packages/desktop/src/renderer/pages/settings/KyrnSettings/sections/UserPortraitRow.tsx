import React, { useState } from 'react';
import { Button, Input, Message } from '@arco-design/web-react';
import { User } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { supervisorBridge } from '@/common/chat/team/supervisor/supervisorBridge';
import MuModal from '@renderer/components/base/MuModal';
import Row from '../fields/Row';
import { Card } from './SectionShell';

/**
 * The team details page's user-portrait row: the one file
 * (`positions/_shared/USER.md`) every position's and the supervisor's gate
 * embeds as its closing「用户画像」section. The row reads it into a modal's
 * text area and saves it whole through the supervisor bridge; the main
 * process's folder watch then rebuilds every gate that carries it, so open
 * conversations reload without reopening. Not a harness setting — the row
 * sits on the team page because the portrait is the position system's
 * shared memory, not the kernel's.
 */
export default function UserPortraitRow() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const show = async () => {
    setOpen(true);
    setLoaded(false);
    const answer = await supervisorBridge.userPortrait.invoke();
    setText(answer.ok ? (answer.data.portrait ?? '') : '');
    setLoaded(true);
  };

  const save = async () => {
    if (text === undefined) return;
    setSaving(true);
    const answer = await supervisorBridge.saveUserPortrait.invoke({ content: text });
    setSaving(false);
    if (answer.ok) {
      Message.success(t('mu.userPortrait.saved'));
      setOpen(false);
    } else {
      Message.error(t('mu.userPortrait.saveFailed'));
    }
  };

  return (
    <Card testId='mu-user-portrait-row'>
      <Row title={t('mu.userPortrait.title')} help={t('mu.userPortrait.help')}>
        <Button
          size='small'
          type='text'
          data-testid='mu-user-portrait-edit'
          aria-label={t('mu.userPortrait.edit')}
          onClick={() => void show()}
        >
          <span className='rtl-mirror'>
            <User theme='outline' size='14' style={{ marginRight: 4, verticalAlign: '-2px' }} />
            {t('mu.userPortrait.edit')}
          </span>
        </Button>
      </Row>
      {/* The modal mounts only while open: a closed modal is nothing at all. */}
      {open ? (
        <MuModal
          visible={open}
          onCancel={() => setOpen(false)}
          footer={null}
          size='large'
          header={{ title: t('mu.userPortrait.title'), subtitle: t('mu.userPortrait.help') }}
        >
          <div data-testid='mu-user-portrait-modal'>
            <Input.TextArea
              value={text ?? ''}
              placeholder={loaded ? t('mu.userPortrait.placeholder') : t('mu.userPortrait.loading')}
              disabled={!loaded || saving}
              autoSize={{ minRows: 10, maxRows: 20 }}
              style={{ fontFamily: 'var(--font-mono, monospace)', whiteSpace: 'pre' }}
              onChange={(value) => setText(value)}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <Button size='small' onClick={() => setOpen(false)}>
                {t('mu.userPortrait.cancel')}
              </Button>
              <Button
                size='small'
                type='primary'
                loading={saving}
                disabled={!loaded}
                data-testid='mu-user-portrait-save'
                onClick={() => void save()}
              >
                {t('mu.userPortrait.save')}
              </Button>
            </div>
          </div>
        </MuModal>
      ) : null}
    </Card>
  );
}
