import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { MuMcpServer, MuMcpServers, MuSkill, MuSkills } from '@/common/kyrn/capabilities';
import type { KyrnResult } from '@/common/kyrn/errors';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import enSettings from '@/renderer/services/i18n/locales/en-US/settings.json';
import MuMcpPage from '@/renderer/pages/settings/MuCapabilities/McpPage';
import MuSkillsPage from '@/renderer/pages/settings/MuCapabilities/SkillsPage';

const bridge = vi.hoisted(() => ({
  skills: vi.fn(),
  skillAdd: vi.fn(),
  skillRemove: vi.fn(),
  mcpServers: vi.fn(),
  mcpAdd: vi.fn(),
  mcpRemove: vi.fn(),
  mcpSwitch: vi.fn(),
  capabilityReveal: vi.fn(),
  showOpen: vi.fn(),
}));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: {
    skills: { invoke: bridge.skills },
    skillAdd: { invoke: bridge.skillAdd },
    skillRemove: { invoke: bridge.skillRemove },
    mcpServers: { invoke: bridge.mcpServers },
    mcpAdd: { invoke: bridge.mcpAdd },
    mcpRemove: { invoke: bridge.mcpRemove },
    mcpSwitch: { invoke: bridge.mcpSwitch },
    capabilityReveal: { invoke: bridge.capabilityReveal },
  },
  // As the real one: a failure keeps the code and params the main process gave it.
  unwrap: <T,>(result: KyrnResult<T>) => {
    if (!result.ok) throw Object.assign(new Error(result.error), result);
    return result.data;
  },
}));
vi.mock('@/common', () => ({ ipcBridge: { dialog: { showOpen: { invoke: bridge.showOpen } } } }));
// The routed page's frame (the settings rail's phone navigation, the scroll box) is not what is tested here.
vi.mock('@/renderer/pages/settings/components/SettingsPageWrapper', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const i18n = createInstance();
beforeAll(async () => {
  // The form's grid follows the window's width, which jsdom does not have.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  await i18n.init({
    lng: 'en-US',
    resources: { 'en-US': { translation: { common: enCommon, mu: enMu, settings: enSettings } } },
    interpolation: { escapeValue: false },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ok = <T,>(data: T): KyrnResult<T> => ({ ok: true, data });
const failed = (code: string, params: Record<string, unknown> = {}) => ({ ok: false, error: 'raw', code, params });
const draw = (page: React.ReactElement) => render(<I18nextProvider i18n={i18n}>{page}</I18nextProvider>);

const FOLDER = '/home/me/.mu/agent/skills';
const skill = (name: string, source: MuSkill['source'], file = `${FOLDER}/${name}/SKILL.md`): MuSkill => ({
  name,
  description: `What ${name} does.`,
  file,
  source,
  removable: source === 'mu',
});
const SKILLS: MuSkills = {
  folder: FOLDER,
  skills: [
    skill('review', 'mu'),
    skill('release-notes', 'mu'),
    skill('shared-notes', 'agents', '/home/me/.agents/skills/shared-notes/SKILL.md'),
    skill('mu-browser', 'builtin', '/opt/mu/skills/mu-browser/SKILL.md'),
    skill('pdf', 'claude', '/home/me/.claude/skills/pdf/SKILL.md'),
  ],
};

describe('mu’s skills while mu runs inside the app', () => {
  it('lists every skill under where it comes from, in the order mu loads them, and only mu’s own can be removed', async () => {
    bridge.skills.mockResolvedValue(ok(SKILLS));
    draw(<MuSkillsPage />);
    const own = await screen.findByTestId('mu-skills-mu');
    const groups = [...document.querySelectorAll('[data-testid^="mu-skills-"]')].map((group) =>
      group.getAttribute('data-testid')
    );
    expect(groups).toEqual(['mu-skills-mu', 'mu-skills-agents', 'mu-skills-builtin', 'mu-skills-claude']);
    expect(own).toHaveTextContent('mu’s skills');
    expect(own).toHaveTextContent(`In ${FOLDER}.`);
    expect(within(own).getByTestId('mu-skill-review')).toHaveTextContent('What review does.');
    expect(within(own).getByRole('button', { name: 'review: Remove' })).toBeInTheDocument();
    const inherited = screen.getByTestId('mu-skills-claude');
    expect(inherited).toHaveTextContent('From Claude Code');
    expect(inherited).toHaveTextContent('From ~/.claude/skills.');
    for (const id of ['mu-skills-agents', 'mu-skills-builtin', 'mu-skills-claude'])
      expect(within(screen.getByTestId(id)).queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    // A project's own skills are not mu's to list here: the page says so.
    expect(screen.getByText(/load only in that project’s conversations/)).toBeInTheDocument();
  });

  it('finds a skill by its name or what it does, group by group', async () => {
    bridge.skills.mockResolvedValue(ok(SKILLS));
    draw(<MuSkillsPage />);
    await screen.findByTestId('mu-skills-mu');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search skills' }), { target: { value: 'NOTES' } });
    expect(screen.getByTestId('mu-skill-release-notes')).toBeInTheDocument();
    expect(screen.getByTestId('mu-skill-shared-notes')).toBeInTheDocument();
    expect(screen.queryByTestId('mu-skill-review')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('mu-skills-claude')).getByText('No skill matches.')).toBeInTheDocument();
  });

  it('shows five skills of a long group, the rest on 显示全部, and all that match a search', async () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      skill(`shared-${index + 1}`, 'agents', `/home/me/.agents/skills/shared-${index + 1}/SKILL.md`)
    );
    bridge.skills.mockResolvedValue(ok({ folder: FOLDER, skills: [skill('review', 'mu'), ...many] }));
    draw(<MuSkillsPage />);
    const shared = await screen.findByTestId('mu-skills-agents');
    const rows = () => within(shared).queryAllByTestId(/^mu-skill-shared-/);
    expect(rows()).toHaveLength(5);
    expect(shared).toHaveTextContent('8');
    fireEvent.click(screen.getByTestId('mu-skill-group-toggle-agents'));
    expect(rows()).toHaveLength(8);
    fireEvent.click(screen.getByTestId('mu-skill-group-toggle-agents'));
    expect(rows()).toHaveLength(5);
    // A search is never cut short.
    fireEvent.change(screen.getByRole('textbox', { name: 'Search skills' }), { target: { value: 'shared' } });
    expect(rows()).toHaveLength(8);
    expect(screen.queryByTestId('mu-skill-group-toggle-agents')).not.toBeInTheDocument();
    // A short group has nothing to open.
    expect(screen.queryByTestId('mu-skill-group-toggle-mu')).not.toBeInTheDocument();
  });

  it('adds the folder picked, says which skill was added, and words why one could not be', async () => {
    bridge.skills.mockResolvedValue(ok(SKILLS));
    draw(<MuSkillsPage />);
    await screen.findByTestId('mu-skills-mu');
    bridge.showOpen.mockResolvedValue(['/home/me/Downloads/translate']);
    bridge.skillAdd.mockResolvedValue(ok({ ...SKILLS, skills: [skill('translate', 'mu'), ...SKILLS.skills] }));
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
    expect(await screen.findByText('Added translate. New conversations can use it.')).toBeInTheDocument();
    expect(bridge.showOpen).toHaveBeenCalledWith({ properties: ['openDirectory'] });
    expect(bridge.skillAdd).toHaveBeenCalledWith({ path: '/home/me/Downloads/translate' });
    expect(screen.getByTestId('mu-skill-translate')).toBeInTheDocument();

    bridge.skillAdd.mockResolvedValue(failed('skillExists', { name: 'review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
    expect(await screen.findByText('mu already has a skill named review.')).toBeInTheDocument();
    // Nothing picked: nothing is added.
    bridge.showOpen.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
    await waitFor(() => expect(bridge.showOpen).toHaveBeenCalledTimes(3));
    expect(bridge.skillAdd).toHaveBeenCalledTimes(2);
  });

  it('asks before it moves one of mu’s skills to the trash', async () => {
    bridge.skills.mockResolvedValue(ok(SKILLS));
    draw(<MuSkillsPage />);
    await screen.findByTestId('mu-skills-mu');
    fireEvent.click(screen.getByRole('button', { name: 'review: Remove' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Remove the skill review?');
    expect(bridge.skillRemove).not.toHaveBeenCalled();
    bridge.skillRemove.mockResolvedValue(ok({ ...SKILLS, skills: SKILLS.skills.slice(1) }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Moved review to the trash.')).toBeInTheDocument();
    expect(bridge.skillRemove).toHaveBeenCalledWith({ name: 'review' });
    expect(screen.queryByTestId('mu-skill-review')).not.toBeInTheDocument();
  });

  it('opens mu’s skills folder, and says when the skills could not be read', async () => {
    bridge.skills.mockResolvedValue(failed('unreadable', { file: FOLDER }));
    bridge.capabilityReveal.mockResolvedValue(ok(undefined));
    draw(<MuSkillsPage />);
    expect(await screen.findByText('mu’s skills could not be read.')).toBeInTheDocument();
    expect(screen.getByText(`${FOLDER} could not be read.`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(bridge.capabilityReveal).toHaveBeenCalledWith({ what: 'skills' });
  });
});

const MCP_FILE = '/home/me/.mu/agent/mcp.json';
const server = (patch: Partial<MuMcpServer> & Pick<MuMcpServer, 'name'>): MuMcpServer => ({
  source: 'mu',
  file: MCP_FILE,
  transport: 'stdio',
  target: `npx -y ${patch.name}`,
  on: true,
  removable: true,
  ...patch,
});
const SERVERS: MuMcpServers = {
  file: MCP_FILE,
  feature: true,
  unreadable: [],
  servers: [
    server({ name: 'filesystem' }),
    server({ name: 'github', transport: 'http', target: 'https://api.example.com/mcp' }),
    server({ name: 'sentry', source: 'claude', file: '/home/me/.claude.json', removable: false }),
    server({
      name: 'linear',
      source: 'cursor',
      file: '/home/me/.cursor/mcp.json',
      removable: false,
      on: false,
      lock: 'offInSource',
    }),
    server({
      name: 'legacy',
      source: 'codex',
      file: '/home/me/.codex/config.toml',
      removable: false,
      on: false,
      lock: 'unsupported',
    }),
  ],
};

describe('mu’s MCP servers while mu runs inside the app', () => {
  it('lists every server under where it is set up, with what it runs, its switch, or why it has none', async () => {
    bridge.mcpServers.mockResolvedValue(ok(SERVERS));
    draw(<MuMcpPage />);
    const own = await screen.findByTestId('mu-mcp-mu');
    expect(screen.getByRole('heading', { name: 'MCP servers' })).toBeInTheDocument();
    expect(own).toHaveTextContent(`Added servers go into ${MCP_FILE}`);
    expect(within(own).getByTestId('mu-mcp-filesystem')).toHaveTextContent('npx -y filesystem');
    expect(within(own).getByTestId('mu-mcp-github')).toHaveTextContent('https://api.example.com/mcp');
    expect(within(own).getByRole('switch', { name: 'Use github' })).toBeChecked();
    expect(within(own).getByRole('button', { name: 'github: Remove' })).toBeInTheDocument();
    // Taken over from Claude Code: a switch, nothing to remove.
    const claude = screen.getByTestId('mu-mcp-claude');
    expect(claude).toHaveTextContent('From ~/.claude.json.');
    expect(within(claude).getByRole('switch', { name: 'Use sentry' })).toBeInTheDocument();
    expect(within(claude).queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    // Off in Cursor's own file, or of a kind mu cannot speak to: it says so, with no switch.
    expect(screen.getByTestId('mu-mcp-lock-linear')).toHaveTextContent('Off at its source');
    expect(screen.getByTestId('mu-mcp-lock-legacy')).toHaveTextContent('Not supported');
    expect(screen.queryByRole('switch', { name: 'Use linear' })).not.toBeInTheDocument();
    expect(screen.getByText(/are used only in that project’s conversations/)).toBeInTheDocument();
  });

  it('switches a server off and shows the list the main process answered with', async () => {
    bridge.mcpServers.mockResolvedValue(ok(SERVERS));
    draw(<MuMcpPage />);
    await screen.findByTestId('mu-mcp-claude');
    const after = SERVERS.servers.map((entry) => (entry.name === 'sentry' ? { ...entry, on: false } : entry));
    bridge.mcpSwitch.mockResolvedValue(ok({ ...SERVERS, servers: after }));
    fireEvent.click(screen.getByRole('switch', { name: 'Use sentry' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Use sentry' })).not.toBeChecked());
    expect(bridge.mcpSwitch).toHaveBeenCalledWith({ name: 'sentry', on: false });

    bridge.mcpSwitch.mockResolvedValue(failed('unwritable', { file: '/home/me/.mu/agent/mu.json' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Use filesystem' }));
    expect(await screen.findByText('/home/me/.mu/agent/mu.json could not be written.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Use filesystem' })).toBeChecked();
  });

  it('asks before it removes one of mu’s own servers, naming the file', async () => {
    bridge.mcpServers.mockResolvedValue(ok(SERVERS));
    draw(<MuMcpPage />);
    await screen.findByTestId('mu-mcp-mu');
    fireEvent.click(screen.getByRole('button', { name: 'github: Remove' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(`Its entry is deleted from ${MCP_FILE}.`);
    bridge.mcpRemove.mockResolvedValue(ok({ ...SERVERS, servers: SERVERS.servers.filter((e) => e.name !== 'github') }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Removed github.')).toBeInTheDocument();
    expect(bridge.mcpRemove).toHaveBeenCalledWith({ name: 'github' });
    expect(screen.queryByTestId('mu-mcp-github')).not.toBeInTheDocument();
  });

  it('says when the MCP feature is off and which files could not be read', async () => {
    bridge.mcpServers.mockResolvedValue(
      ok({ ...SERVERS, feature: false, unreadable: ['/home/me/.claude.json'], servers: [] })
    );
    draw(<MuMcpPage />);
    expect(await screen.findByText(/The MCP feature is off in mu.json/)).toBeInTheDocument();
    expect(screen.getByText(/so their servers are missing: \/home\/me\/.claude.json/)).toBeInTheDocument();
    expect(screen.getByText('mu uses no MCP servers yet.')).toBeInTheDocument();
  });
});

describe('adding an MCP server', () => {
  async function open() {
    bridge.mcpServers.mockResolvedValue(ok(SERVERS));
    draw(<MuMcpPage />);
    await screen.findByTestId('mu-mcp-mu');
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    return screen.findByRole('dialog');
  }
  const type = (dialog: HTMLElement, label: string, value: string) =>
    fireEvent.change(within(dialog).getByRole('textbox', { name: label }), { target: { value } });
  const submit = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

  it('says what is missing or wrong before anything is written', async () => {
    const dialog = await open();
    submit(dialog);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter a name.');
    type(dialog, 'Name', 'my server');
    submit(dialog);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('“my server” cannot name a server');
    type(dialog, 'Name', 'files');
    submit(dialog);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter a command.');
    type(dialog, 'Command', 'node "server.js');
    submit(dialog);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('A quote in the command is not closed.');
    type(dialog, 'Command', 'node server.js');
    type(dialog, 'Environment variables', 'TOKEN=1\nnot a pair');
    submit(dialog);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Line 2 is not in the right form.');
    expect(bridge.mcpAdd).not.toHaveBeenCalled();
  });

  it('writes a command with its arguments and variables, and a server elsewhere with its headers', async () => {
    let dialog = await open();
    type(dialog, 'Name', 'files');
    type(dialog, 'Command', 'npx -y @modelcontextprotocol/server-filesystem "/Users/me/My Documents"');
    type(dialog, 'Environment variables', 'ROOT=/tmp\n');
    const added = { ...SERVERS, servers: [server({ name: 'files' }), ...SERVERS.servers] };
    bridge.mcpAdd.mockResolvedValue(ok(added));
    submit(dialog);
    expect(await screen.findByText('Added files. New conversations can use it.')).toBeInTheDocument();
    expect(bridge.mcpAdd).toHaveBeenCalledWith({
      name: 'files',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/My Documents'],
      env: { ROOT: '/tmp' },
    });
    expect(screen.getByTestId('mu-mcp-files')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    dialog = await screen.findByRole('dialog');
    // Every opening starts empty.
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue('');
    fireEvent.click(within(dialog).getByText('URL'));
    type(dialog, 'Name', 'remote');
    type(dialog, 'URL', ' https://mcp.example.com/mcp ');
    type(dialog, 'Headers', 'Authorization: Bearer abc');
    bridge.mcpAdd.mockResolvedValue(failed('mcpExists', { name: 'remote' }));
    submit(dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('mu already has a server named remote.');
    expect(bridge.mcpAdd).toHaveBeenLastCalledWith({
      name: 'remote',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer abc' },
    });
  });
});
