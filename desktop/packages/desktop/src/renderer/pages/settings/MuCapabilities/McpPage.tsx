import React, { useState } from 'react';
import { Alert, Button, Message, Modal, Spin, Switch, Tooltip } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { MCP_SOURCES, type MuMcpServer, type MuMcpServers } from '@/common/kyrn/capabilities';
import type { KyrnResult } from '@/common/kyrn/errors';
import OneLine from '@/renderer/components/settings/OneLine';
import SettingsPageWrapper from '../components/SettingsPageWrapper';
import MuErrorMessage from '../KyrnSettings/fields/MuErrorMessage';
import { muErrorText, toMuError } from '../KyrnSettings/fields/muError';
import SectionShell, { Card } from '../KyrnSettings/sections/SectionShell';
import styles from '../KyrnSettings/sections/sections.module.css';
import { useSharedMuSettings } from '../KyrnSettings/useMuSettings';
import AddMcpServerModal from './AddMcpServerModal';
import Count from './Count';
import { useMuList } from './useMuList';

/**
 * The MCP page while mu runs inside the app (the tools page of the rail): the servers mu uses in every conversation, a
 * group for each place they are defined (mu's own configuration, Claude Code, Cursor, Codex), each with its switch.
 * A server is added to mu's `mcp.json` as `mu mcp add` adds it; one of mu's own can be removed. A server taken over is
 * switched off in mu.json, never in the other tool's file; one switched off in that file, or one mu cannot speak to,
 * says so instead of offering a switch. Nothing is started from here: a change applies to the next conversation.
 */
export default function MuMcpPage() {
  const { t, i18n } = useTranslation();
  const [message, messageHolder] = Message.useMessage();
  const [modal, modalHolder] = Modal.useModal();
  const list = useMuList(() => kyrnBridge.mcpServers.invoke());
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<string>();
  // The settings pages keep a draft of mu.json: once a switch wrote it, a draft without changes is read again, so a
  // later save does not find the file changed under it.
  const shared = useSharedMuSettings();
  const fail = (cause: unknown) => message.error?.(muErrorText(t, i18n.language, toMuError(cause)).text);

  /** A change that answers with the list after it. */
  const change = async (server: MuMcpServer, work: () => Promise<KyrnResult<MuMcpServers>>, done?: string) => {
    setPending(server.name);
    try {
      list.set(unwrap(await work()));
      if (shared && !shared.dirty.size && server.file !== list.data?.file) shared.reload();
      if (done) message.success?.(done);
    } catch (cause) {
      fail(cause);
    } finally {
      setPending(undefined);
    }
  };

  const remove = (server: MuMcpServer) =>
    modal.confirm?.({
      title: t('mu.capabilities.mcp.removeTitle', { name: server.name }),
      content: t('mu.capabilities.mcp.removeContent', { file: server.file }),
      okText: t('mu.capabilities.remove'),
      okButtonProps: { status: 'danger' },
      onOk: () =>
        change(
          server,
          () => kyrnBridge.mcpRemove.invoke({ name: server.name }),
          t('mu.capabilities.mcp.removed', { name: server.name })
        ),
    });

  const reveal = async () => {
    try {
      unwrap(await kyrnBridge.capabilityReveal.invoke({ what: 'mcp' }));
    } catch (cause) {
      fail(cause);
    }
  };

  const servers = list.data?.servers ?? [];
  const groups = MCP_SOURCES.map((source) => ({
    source,
    servers: servers.filter((server) => server.source === source),
  })).filter((group) => group.servers.length > 0);

  const control = (server: MuMcpServer) => {
    const name = t('mu.capabilities.mcp.use', { name: server.name });
    if (server.lock)
      return (
        <Tooltip content={t(`mu.capabilities.mcp.locked.${server.lock}.help`)}>
          <span className={styles.featureOpen} data-testid={`mu-mcp-lock-${server.name}`}>
            {t(`mu.capabilities.mcp.locked.${server.lock}.label`)}
          </span>
        </Tooltip>
      );
    return (
      <>
        {server.removable ? (
          <Button
            size='small'
            type='text'
            aria-label={`${server.name}: ${t('mu.capabilities.remove')}`}
            disabled={pending === server.name}
            onClick={() => remove(server)}
          >
            {t('mu.capabilities.remove')}
          </Button>
        ) : null}
        <Switch
          size='small'
          aria-label={name}
          checked={server.on}
          loading={pending === server.name}
          onChange={(on) => void change(server, () => kyrnBridge.mcpSwitch.invoke({ name: server.name, on }))}
        />
      </>
    );
  };

  return (
    <SettingsPageWrapper>
      {messageHolder}
      {modalHolder}
      {adding ? (
        <AddMcpServerModal
          onCancel={() => setAdding(false)}
          onAdded={(after, name) => {
            list.set(after);
            setAdding(false);
            message.success?.(t('mu.capabilities.mcp.added', { name }));
          }}
        />
      ) : null}
      <SectionShell
        id='mu-mcp'
        title={t('mu.capabilities.mcp.title')}
        description={t('mu.capabilities.mcp.lead')}
        actions={
          <>
            <Button size='small' onClick={() => void reveal()}>
              {t('mu.capabilities.mcp.open')}
            </Button>
            <Button size='small' type='primary' onClick={() => setAdding(true)}>
              {t('mu.capabilities.mcp.add')}
            </Button>
          </>
        }
      >
        {list.data && !list.data.feature ? <Alert type='info' content={t('mu.capabilities.mcp.featureOff')} /> : null}
        {list.data?.unreadable.length ? (
          <Alert
            type='warning'
            content={t('mu.capabilities.mcp.unreadable', { files: list.data.unreadable.join(', ') })}
          />
        ) : null}
        {list.error && !list.data ? (
          <Alert type='error' title={t('mu.capabilities.mcp.failed')} content={<MuErrorMessage error={list.error} />} />
        ) : !list.data ? (
          <Spin />
        ) : groups.length === 0 ? (
          <div className={styles.empty}>{t('mu.capabilities.mcp.empty')}</div>
        ) : (
          groups.map(({ source, servers: shown }) => (
            <Card
              key={source}
              testId={`mu-mcp-${source}`}
              title={t(`mu.capabilities.mcp.groups.${source}.title`)}
              badges={<Count value={shown.length} />}
              summary={<OneLine text={t(`mu.capabilities.mcp.groups.${source}.help`, { file: list.data?.file })} />}
            >
              {shown.map((server) => (
                <div
                  key={`${server.file}:${server.name}`}
                  className={styles.plainRow}
                  data-testid={`mu-mcp-${server.name}`}
                >
                  <div className={styles.plainMain}>
                    <div className={styles.plainText}>
                      <div className={styles.plainTitle} title={server.file}>
                        <span>{server.name}</span>
                      </div>
                      {/* A command line or an address: cut at the end of the line, whole in its tooltip. */}
                      <div
                        className='mt-2px truncate font-mono text-12px leading-18px text-t-secondary'
                        dir='ltr'
                        title={server.target}
                      >
                        {server.target}
                      </div>
                    </div>
                    <div className={styles.featureControls}>{control(server)}</div>
                  </div>
                </div>
              ))}
            </Card>
          ))
        )}
        {list.data ? <div className={styles.meta}>{t('mu.capabilities.mcp.project')}</div> : null}
      </SectionShell>
    </SettingsPageWrapper>
  );
}
