import React, { useMemo, useState } from 'react';
import { Alert, Button, Input, Message, Modal, Spin } from '@arco-design/web-react';
import { Search } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { SKILL_SOURCES, type MuSkill, type SkillSource } from '@/common/kyrn/capabilities';
import OneLine from '@/renderer/components/settings/OneLine';
import SettingsPageWrapper from '../components/SettingsPageWrapper';
import MuErrorMessage from '../KyrnSettings/fields/MuErrorMessage';
import { muErrorText, toMuError } from '../KyrnSettings/fields/muError';
import SectionShell, { Card } from '../KyrnSettings/sections/SectionShell';
import styles from '../KyrnSettings/sections/sections.module.css';
import Count from './Count';
import { useMuList } from './useMuList';

/** Rows a group shows before 显示全部: a page is a few short groups, not every skill on the computer at once. */
const GROUP_PREVIEW = 5;

/** Whether a skill is found by the words typed: in its name or its description, any case. */
const found = (skill: MuSkill, query: string): boolean => {
  const words = query.trim().toLowerCase();
  return !words || `${skill.name}\n${skill.description}`.toLowerCase().includes(words);
};

/**
 * The skills page while mu runs inside the app: the skills mu loads in every conversation, a group for each place they
 * come from (mu's folder, the folder agents share, mu itself, Claude Code, Codex), in the order mu loads them. A skill
 * is added by copying its folder into mu's folder; only one of mu's folder can be removed, to the trash. A skill from
 * anywhere else says where it comes from instead: mu does not change the other tools' files.
 */
export default function MuSkillsPage() {
  const { t, i18n } = useTranslation();
  const [message, messageHolder] = Message.useMessage();
  const [modal, modalHolder] = Modal.useModal();
  const list = useMuList(() => kyrnBridge.skills.invoke());
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  // Groups opened in full; a search shows every match anyway.
  const [opened, setOpened] = useState<ReadonlySet<SkillSource>>(new Set());
  const fail = (cause: unknown) => message.error?.(muErrorText(t, i18n.language, toMuError(cause)).text);

  const add = async () => {
    const picked = await ipcBridge.dialog.showOpen.invoke({ properties: ['openDirectory'] });
    const path = picked?.[0];
    if (!path) return;
    const before = new Set(list.data?.skills.map((skill) => skill.file));
    setBusy(true);
    try {
      const after = unwrap(await kyrnBridge.skillAdd.invoke({ path }));
      list.set(after);
      const added = after.skills.find((skill) => skill.source === 'mu' && !before.has(skill.file));
      message.success?.(t('mu.capabilities.skills.added', { name: added?.name ?? '' }));
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const remove = (skill: MuSkill) =>
    modal.confirm?.({
      title: t('mu.capabilities.skills.removeTitle', { name: skill.name }),
      content: t('mu.capabilities.skills.removeContent'),
      okText: t('mu.capabilities.remove'),
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        try {
          list.set(unwrap(await kyrnBridge.skillRemove.invoke({ name: skill.name })));
          message.success?.(t('mu.capabilities.skills.removed', { name: skill.name }));
        } catch (cause) {
          fail(cause);
        }
      },
    });

  const reveal = async () => {
    try {
      unwrap(await kyrnBridge.capabilityReveal.invoke({ what: 'skills' }));
    } catch (cause) {
      fail(cause);
    }
  };

  const groups = useMemo(() => {
    const skills = list.data?.skills ?? [];
    return SKILL_SOURCES.map((source) => ({
      source,
      all: skills.filter((skill) => skill.source === source),
      shown: skills.filter((skill) => skill.source === source && found(skill, query)),
    })).filter((group) => group.all.length > 0);
  }, [list.data, query]);

  const help = (source: SkillSource): string =>
    t(`mu.capabilities.skills.groups.${source}.help`, { folder: list.data?.folder ?? '' });

  return (
    <SettingsPageWrapper>
      {messageHolder}
      {modalHolder}
      <SectionShell
        id='mu-skills'
        title={t('settings.skills')}
        description={t('mu.capabilities.skills.lead')}
        actions={
          <>
            <Input
              size='small'
              allowClear
              className={styles.wide}
              prefix={<Search theme='outline' size='14' />}
              aria-label={t('mu.capabilities.skills.search')}
              placeholder={t('mu.capabilities.skills.search')}
              value={query}
              onChange={setQuery}
            />
            <Button size='small' onClick={() => void reveal()}>
              {t('mu.capabilities.skills.open')}
            </Button>
            <Button size='small' type='primary' loading={busy} onClick={() => void add()}>
              {t('mu.capabilities.skills.add')}
            </Button>
          </>
        }
      >
        {list.error && !list.data ? (
          <Alert
            type='error'
            title={t('mu.capabilities.skills.failed')}
            content={<MuErrorMessage error={list.error} />}
          />
        ) : !list.data ? (
          <Spin />
        ) : groups.length === 0 ? (
          <div className={styles.empty}>{t('mu.capabilities.skills.empty')}</div>
        ) : (
          groups.map(({ source, all, shown }) => {
            const cut = !query.trim() && !opened.has(source) && shown.length > GROUP_PREVIEW;
            const rows = cut ? shown.slice(0, GROUP_PREVIEW) : shown;
            const toggle = () =>
              setOpened((now) => {
                const next = new Set(now);
                if (!next.delete(source)) next.add(source);
                return next;
              });
            return (
              <Card
                key={source}
                testId={`mu-skills-${source}`}
                title={t(`mu.capabilities.skills.groups.${source}.title`)}
                badges={<Count value={all.length} />}
                summary={<OneLine text={help(source)} />}
              >
                {shown.length === 0 ? (
                  <div className={styles.empty}>{t('mu.capabilities.skills.noMatch')}</div>
                ) : (
                  rows.map((skill) => (
                    <div key={skill.file} className={styles.plainRow} data-testid={`mu-skill-${skill.name}`}>
                      <div className={styles.plainMain}>
                        <div className={styles.plainText}>
                          <div className={styles.plainTitle} title={skill.file}>
                            <span>{skill.name}</span>
                          </div>
                          <OneLine text={skill.description} />
                        </div>
                        {skill.removable ? (
                          <div className={styles.featureControls}>
                            <Button
                              size='small'
                              type='text'
                              aria-label={`${skill.name}: ${t('mu.capabilities.remove')}`}
                              onClick={() => remove(skill)}
                            >
                              {t('mu.capabilities.remove')}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
                {!query.trim() && shown.length > GROUP_PREVIEW ? (
                  <Button
                    size='mini'
                    type='text'
                    className='mt-4px'
                    data-testid={`mu-skill-group-toggle-${source}`}
                    aria-expanded={!cut}
                    onClick={toggle}
                  >
                    {cut ? t('mu.capabilities.showAll', { count: shown.length }) : t('mu.capabilities.showFewer')}
                  </Button>
                ) : null}
              </Card>
            );
          })
        )}
        {list.data ? <div className={styles.meta}>{t('mu.capabilities.skills.project')}</div> : null}
      </SectionShell>
    </SettingsPageWrapper>
  );
}
