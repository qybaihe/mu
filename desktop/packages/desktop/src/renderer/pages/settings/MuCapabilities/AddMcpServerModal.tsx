import React, { useState } from 'react';
import { Form, Input, Modal, Radio } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { MCP_SERVER_NAME, type McpServerInput, type MuMcpServers } from '@/common/kyrn/capabilities';
import fieldStyles from '../KyrnSettings/fields/fields.module.css';
import { muErrorText, toMuError } from '../KyrnSettings/fields/muError';
import { readPairLines, splitCommandLine } from './commandLine';

type AddMcpServerModalProps = {
  onCancel: () => void;
  /** The server was written: the list after it, and its name. */
  onAdded: (list: MuMcpServers, name: string) => void;
};

/**
 * A new MCP server in mu's `mcp.json`, as `mu mcp add` writes it: a name, then either the command mu starts (one line,
 * as in a terminal) with its environment variables, or the address of a server that runs elsewhere with its headers.
 * Shown while it is open, so every opening starts empty.
 */
export default function AddMcpServerModal({ onCancel, onAdded }: AddMcpServerModalProps) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'command' | 'url'>('command');
  const [command, setCommand] = useState('');
  const [env, setEnv] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  const form = (key: string, options?: Record<string, unknown>) => t(`mu.capabilities.mcp.form.${key}`, options);

  /** What was typed as the bridge takes it, or what is wrong with it. */
  const read = (): McpServerInput | string => {
    const trimmed = name.trim();
    if (!trimmed) return form('needName');
    if (!MCP_SERVER_NAME.test(trimmed)) return t('mu.errors.mcpName', { name: trimmed });
    if (kind === 'url') {
      if (!url.trim()) return form('needUrl');
      const lines = readPairLines(headers, ':');
      if ('badLine' in lines) return form('badLine', { line: lines.badLine });
      return { name: trimmed, url: url.trim(), headers: lines.pairs };
    }
    const words = splitCommandLine(command);
    if (!words) return form('openQuote');
    if (!words.length) return form('needCommand');
    const lines = readPairLines(env, '=');
    if ('badLine' in lines) return form('badLine', { line: lines.badLine });
    return { name: trimmed, command: words[0], args: words.slice(1), env: lines.pairs };
  };

  const submit = async () => {
    const input = read();
    if (typeof input === 'string') {
      setProblem(input);
      return;
    }
    setProblem('');
    setSaving(true);
    try {
      onAdded(unwrap(await kyrnBridge.mcpAdd.invoke(input)), input.name);
    } catch (cause) {
      setProblem(muErrorText(t, i18n.language, toMuError(cause)).text);
      setSaving(false);
    }
  };

  return (
    <Modal
      visible
      title={form('title')}
      okText={form('submit')}
      confirmLoading={saving}
      onOk={() => void submit()}
      onCancel={onCancel}
      unmountOnExit
    >
      <Form layout='vertical' data-testid='mu-mcp-add'>
        <Form.Item label={form('name')} extra={form('nameHelp')}>
          <Input value={name} onChange={setName} placeholder='filesystem' aria-label={form('name')} />
        </Form.Item>
        <Form.Item label={form('kind')}>
          <Radio.Group type='button' value={kind} onChange={setKind}>
            <Radio value='command'>{form('command')}</Radio>
            <Radio value='url'>{form('url')}</Radio>
          </Radio.Group>
        </Form.Item>
        {kind === 'command' ? (
          <>
            <Form.Item label={form('command')} extra={form('commandHelp')}>
              <Input
                value={command}
                onChange={setCommand}
                placeholder='npx -y @modelcontextprotocol/server-filesystem ~/Documents'
                aria-label={form('command')}
              />
            </Form.Item>
            <Form.Item label={form('env')}>
              <Input.TextArea
                value={env}
                onChange={setEnv}
                autoSize={{ minRows: 2, maxRows: 6 }}
                placeholder={form('envPlaceholder')}
                aria-label={form('env')}
              />
            </Form.Item>
          </>
        ) : (
          <>
            <Form.Item label={form('url')}>
              <Input value={url} onChange={setUrl} placeholder='https://example.com/mcp' aria-label={form('url')} />
            </Form.Item>
            <Form.Item label={form('headers')}>
              <Input.TextArea
                value={headers}
                onChange={setHeaders}
                autoSize={{ minRows: 2, maxRows: 6 }}
                placeholder={form('headersPlaceholder')}
                aria-label={form('headers')}
              />
            </Form.Item>
          </>
        )}
        {problem ? (
          <div role='alert' className={fieldStyles.problem}>
            {problem}
          </div>
        ) : null}
      </Form>
    </Modal>
  );
}
