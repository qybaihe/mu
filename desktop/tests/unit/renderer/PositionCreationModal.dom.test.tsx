/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The position creation wizard's dom: the picker step (the folder dialog's
 * answer analyzed at once, the deep-AI button exactly when the files said
 * nothing), the review step (the proposal editable, candidates one click
 * away, the identity dot following the id), the overlap gate (a red warning
 * that holds Create until the deliberate confirmation, then lets it through)
 * and the create call itself, whose success closes the wizard and refreshes
 * the roster.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectAnalysis } from '@/common/chat/team/positions/positionBridge';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';

let positions: PositionInfo[];
let pickFolder: ReturnType<typeof vi.fn>;
let analyze: ReturnType<typeof vi.fn>;
let create: ReturnType<typeof vi.fn>;
let refresh: ReturnType<typeof vi.fn>;
let templatesEnsure: ReturnType<typeof vi.fn>;
let templatesSearch: ReturnType<typeof vi.fn>;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined
        ? key
        : `${key}:${Object.entries(params)
            .map(([name, value]) => `${name}=${value}`)
            .join(',')}`,
  }),
}));
// Arco's Message toasts render through a legacy ReactDOM path that jsdom's
// React 19 cannot run; the toast is not what these tests observe.
vi.mock('@arco-design/web-react', async (importOriginal) => ({
  ...(await importOriginal<typeof Record<string, unknown>>()),
  Message: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'light', fontScale: 1 }),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    dialog: {
      showOpen: { invoke: (...args: unknown[]) => pickFolder(...args) },
    },
  },
}));
vi.mock('@/common/chat/team/positions/positionBridge', () => ({
  positionBridge: {
    analyzeProject: { invoke: (...args: unknown[]) => analyze(...args) },
    createPosition: { invoke: (...args: unknown[]) => create(...args) },
    templatesEnsure: { invoke: (...args: unknown[]) => templatesEnsure(...args) },
    templatesSearch: { invoke: (...args: unknown[]) => templatesSearch(...args) },
  },
}));
vi.mock('@renderer/pages/positions/usePositionRoster', () => ({
  usePositionRoster: () => ({ positions, isLoading: false }),
  refreshPositions: () => refresh(),
}));
import PositionCreationModal from '@renderer/pages/positions/PositionCreationModal';

const analysisOf = (over: Partial<ProjectAnalysis['draft']> = {}, aiUsed = false): ProjectAnalysis => ({
  profile: {
    directory: 'E:/Projects/freight-lab',
    projectName: 'freight-lab',
    goal: '报价表自动解析与核价',
    techStack: ['fastify', 'vitest'],
    constraints: ['禁止未脱敏外发客户资料'],
    sources: ['AGENTS.md', 'HANDOFF.md', 'package.json'],
    empty: false,
  },
  draft: {
    id: 'freight-lab',
    displayNameCandidates: ['报价表自动解析', 'freight-lab'],
    description: 'freight-lab 项目常设岗位——报价表自动解析与核价；涉及 freight-lab/fastify/vitest 相关任务时交给它',
    body: '你是「报价表自动解析」岗位的常设负责 Bot。\n\n- 项目根：`E:/Projects/freight-lab`',
    projectRoot: 'E:/Projects/freight-lab',
    ...over,
  },
  aiUsed,
});

const rosterPosition = (over: Partial<PositionInfo>): PositionInfo => ({
  name: 'x',
  displayName: 'x',
  description: '',
  body: '',
  ...over,
});

const openAndPick = async (): Promise<void> => {
  render(<PositionCreationModal open onClose={() => undefined} />);
  fireEvent.click(screen.getByTestId('position-creation-pick'));
  await waitFor(() => {
    expect(screen.getByTestId('position-creation-profile')).toBeDefined();
  });
};

describe('PositionCreationModal', () => {
  beforeEach(() => {
    positions = [];
    pickFolder = vi.fn(async () => ['E:/Projects/freight-lab']);
    analyze = vi.fn(async () => ({ ok: true, data: analysisOf() }));
    create = vi.fn(async () => ({
      ok: true,
      data: rosterPosition({ name: 'freight-lab', displayName: '货代实验室', description: 'd' }),
    }));
    refresh = vi.fn(async () => undefined);
    templatesEnsure = vi.fn(async () => ({
      ok: true,
      data: { available: true, count: 2, fetchedAt: 1_800_000_000_000, stale: false, errorCode: undefined },
    }));
    templatesSearch = vi.fn(async () => ({
      ok: true,
      data: {
        status: { available: true, count: 2, fetchedAt: 1_800_000_000_000, stale: false, errorCode: undefined },
        results: [
          {
            slug: 'podcast-notes',
            name: 'Podcast Notes',
            summary_zh: '把每期播客切成章节笔记并写好摘要',
            category: 'content-publishing',
            tags: ['podcast'],
            summary: 'Chops each podcast episode into chapter notes',
            import: 'https://x.ai/bot/abc',
          },
        ],
        categories: [
          { category: 'content-publishing', count: 1 },
          { category: 'finance-ops', count: 1 },
        ],
      },
    }));
  });
  afterEach(() => cleanup());

  it('analyses the picked directory at once: profile shown, no AI button when the files spoke', async () => {
    await openAndPick();
    expect(analyze).toHaveBeenCalledWith({ dir: 'E:/Projects/freight-lab', deep: false });
    expect(screen.getByTestId('position-creation-dir').textContent).toContain('E:/Projects/freight-lab');
    expect(screen.getByTestId('position-creation-profile').textContent).toContain('freight-lab');
    expect(screen.getByTestId('position-creation-profile').textContent).toContain('报价表自动解析与核价');
    expect(screen.queryByTestId('position-creation-ai')).toBeNull();
  });

  it('offers the deep AI analysis exactly when the files said nothing, and keeps its answer marked', async () => {
    const empty = analysisOf({
      displayNameCandidates: ['freight-lab'],
      description: 'freight-lab 项目常设岗位',
    });
    empty.profile = {
      directory: 'E:/tmp/scratch',
      projectName: 'scratch',
      goal: '',
      techStack: [],
      constraints: [],
      sources: [],
      empty: true,
    };
    pickFolder = vi.fn(async () => ['E:/tmp/scratch']);
    const deep = analysisOf(
      {
        displayNameCandidates: ['空仓分析岗', 'scratch'],
        description: 'AI 给出的职责描述；涉及 scratch 相关任务时交给它',
      },
      true
    );
    deep.profile = { ...deep.profile, empty: false };
    let deepAsked = false;
    analyze = vi.fn(async () => (deepAsked ? { ok: true, data: deep } : { ok: true, data: empty }));
    await openAndPick();
    expect(screen.getByTestId('position-creation-ai')).toBeDefined();

    deepAsked = true;
    fireEvent.click(screen.getByTestId('position-creation-ai'));
    await waitFor(() => {
      expect(screen.getByTestId('position-creation-profile').textContent).toContain('positions.wizard.aiUsed');
    });
    expect(analyze).toHaveBeenLastCalledWith({ dir: 'E:/tmp/scratch', deep: true });
  });

  it('reviews the proposal: candidates one click, the identity dot following the id', async () => {
    await openAndPick();
    fireEvent.click(screen.getByTestId('position-creation-next'));
    expect(screen.getByTestId('position-creation-id')).toHaveValue('freight-lab');
    expect(screen.getByTestId('position-creation-name')).toHaveValue('报价表自动解析');
    expect(screen.getByTestId('position-creation-color')).toBeDefined();

    fireEvent.click(screen.getByTestId('position-creation-candidate-1'));
    expect(screen.getByTestId('position-creation-name')).toHaveValue('freight-lab');
    expect(screen.queryByTestId('position-creation-overlap')).toBeNull();
  });

  it('blocks creation on an invalid id', async () => {
    await openAndPick();
    fireEvent.click(screen.getByTestId('position-creation-next'));
    fireEvent.change(screen.getByTestId('position-creation-id'), { target: { value: '货代' } });
    expect(screen.getByTestId('position-creation-create')).toBeDisabled();
  });

  it('red-flags a roster overlap and holds Create until the deliberate confirmation', async () => {
    positions = [
      rosterPosition({
        name: 'freight-lab',
        displayName: '报价表自动解析',
        description: '完全不同的描述',
        projectRoot: 'E:/Projects/freight-lab',
      }),
    ];
    await openAndPick();
    fireEvent.click(screen.getByTestId('position-creation-next'));
    const banner = screen.getByTestId('position-creation-overlap');
    expect(banner.textContent).toContain('报价表自动解析'); // the overlapping position named
    expect(screen.getByTestId('position-creation-create')).toBeDisabled();

    fireEvent.click(screen.getByTestId('position-creation-overlap-force'));
    expect(screen.getByTestId('position-creation-create')).not.toBeDisabled();
  });

  it('creates on confirm, refreshes the roster and closes', async () => {
    await openAndPick();
    fireEvent.click(screen.getByTestId('position-creation-next'));
    fireEvent.click(screen.getByTestId('position-creation-create'));
    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(1);
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: 'freight-lab', displayName: '报价表自动解析' }));
    // No taboos typed: the wire carries no anti_job key at all.
    expect(create.mock.calls[0][0]).not.toHaveProperty('antiJob');
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
  });

  it('sends the typed taboos as the anti_job list, one line each, blanks dropped', async () => {
    await openAndPick();
    fireEvent.click(screen.getByTestId('position-creation-next'));
    fireEvent.change(screen.getByTestId('position-creation-antijob'), {
      target: { value: '  严禁私自发帖  \n\n严禁删改用户文件\n' },
    });
    fireEvent.click(screen.getByTestId('position-creation-create'));
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ antiJob: ['严禁私自发帖', '严禁删改用户文件'] }));
    });
  });

  it('carries a picked default thinking level onto the create call, and none when left empty', async () => {
    await openAndPick();
    fireEvent.click(screen.getByTestId('position-creation-next'));
    fireEvent.click(screen.getByTestId('position-creation-thinking-select'));
    // The options are the four levels, localized; the option node carries the raw value.
    const option = await screen.findByRole('option', { name: /low/i });
    fireEvent.click(option);
    fireEvent.click(screen.getByTestId('position-creation-create'));
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: 'low' }));
    });
  });

  it('shows the failure and stays open when the write is refused', async () => {
    create = vi.fn(async () => ({ ok: false, error: 'A library file of that id already exists — pick another id' }));
    await openAndPick();
    fireEvent.click(screen.getByTestId('position-creation-next'));
    fireEvent.click(screen.getByTestId('position-creation-create'));
    await waitFor(() => {
      expect(screen.getByTestId('position-creation-error').textContent).toContain('already exists');
    });
  });

  it('starts from a template: the tab adopts one entry into the review form, then creates', async () => {
    render(<PositionCreationModal open onClose={() => undefined} />);
    // Directory stays the default flavour; the picker only mounts on the template tab.
    expect(screen.queryByTestId('position-template-picker')).toBeNull();
    fireEvent.click(screen.getAllByRole('radio')[1]);
    await waitFor(() => {
      expect(screen.getByTestId('position-template-row-0')).toBeDefined();
    });
    expect(templatesEnsure).toHaveBeenCalledWith({});
    expect(screen.getByTestId('position-template-status').textContent).toContain(
      'positions.wizard.template.statusReady'
    );

    fireEvent.click(screen.getByTestId('position-template-adopt-0'));
    expect(screen.getByTestId('position-creation-id')).toHaveValue('podcast-notes');
    // The category's Chinese label is the first display-name candidate, the template's name the second.
    expect(screen.getByTestId('position-creation-name')).toHaveValue('内容发布');
    expect(screen.getByTestId('position-creation-candidate-1')).toHaveTextContent('Podcast Notes');
    expect(screen.getByTestId('position-creation-desc')).toHaveValue('把每期播客切成章节笔记并写好摘要');
    // The category suggests the taboos; the review form carries them as editable text.
    expect(screen.getByTestId('position-creation-antijob').textContent).toContain('严禁未经用户确认对外发布任何内容');
    expect(screen.getByTestId('position-creation-body').textContent).toContain('Podcast Notes');
    // Back returns to the template tab, not the directory picker.
    fireEvent.click(screen.getByTestId('position-creation-back'));
    expect(screen.getByTestId('position-template-picker')).toBeDefined();
    expect(screen.queryByTestId('position-creation-pick')).toBeNull();

    // The picker remounts on back; wait for its search round before adopting again.
    await waitFor(() => {
      expect(screen.getByTestId('position-template-row-0')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('position-template-adopt-0'));
    fireEvent.click(screen.getByTestId('position-creation-create'));
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        id: 'podcast-notes',
        displayName: '内容发布',
        description: '把每期播客切成章节笔记并写好摘要',
        antiJob: ['严禁未经用户确认对外发布任何内容（发帖/评论/点赞/关注）'],
        body: expect.stringContaining('slug：podcast-notes'),
      });
    });
  });

  it('starts from a description: the tab surfaces the missing-information checklist live and points at the supervisor interview', async () => {
    render(<PositionCreationModal open onClose={() => undefined} />);
    fireEvent.click(screen.getAllByRole('radio')[2]); // the third flavour: I'll describe it
    expect(screen.getByTestId('position-creation-describe')).toBeDefined();
    expect(screen.getByTestId('position-creation-describe-text').textContent).toBe('');
    // The supervisor pointer: the wizard does not interview, the supervisor does.
    expect(screen.getByTestId('position-creation-describe').textContent).toContain(
      'positions.wizard.describeSupervisorHint'
    );
    // A thin description misses all three dimensions — the checklist says so.
    fireEvent.change(screen.getByTestId('position-creation-describe-text'), { target: { value: '帮我弄一下那个' } });
    expect(screen.getByTestId('position-creation-describe-gap-project-root')).toBeDefined();
    expect(screen.getByTestId('position-creation-describe-gap-duty-boundary')).toBeDefined();
    expect(screen.getByTestId('position-creation-describe-gap-acceptance')).toBeDefined();
    // Supplemented text clears its gap from the checklist as the markers arrive.
    fireEvent.change(screen.getByTestId('position-creation-describe-text'), {
      target: { value: '盯 E:/Projects/freight-lab，负责报价表解析与核价，验收是行行对上' },
    });
    expect(screen.queryByTestId('position-creation-describe-gap-project-root')).toBeNull();
    expect(screen.queryByTestId('position-creation-describe-gap-duty-boundary')).toBeNull();
    expect(screen.queryByTestId('position-creation-describe-gap-acceptance')).toBeNull();
    expect(screen.getByTestId('position-creation-describe-gaps').textContent).toContain(
      'positions.wizard.describeGapAllSet'
    );
  });

  it('hands the description to the review step as a draft: first sentence the description, the lifted root in the body', async () => {
    render(<PositionCreationModal open onClose={() => undefined} />);
    fireEvent.click(screen.getAllByRole('radio')[2]);
    fireEvent.change(screen.getByTestId('position-creation-describe-text'), {
      target: { value: '盯 E:/Projects/freight-lab 的报价表。其余随便。' },
    });
    // Next stays disabled until there is text; then it opens the review with the draft.
    fireEvent.change(screen.getByTestId('position-creation-describe-text'), { target: { value: '' } });
    expect(screen.getByTestId('position-creation-describe-next')).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByTestId('position-creation-describe-text'), {
      target: { value: '盯 E:/Projects/freight-lab 的报价表。其余随便。' },
    });
    fireEvent.click(screen.getByTestId('position-creation-describe-next'));
    expect(screen.getByTestId('position-creation-desc')).toHaveValue('盯 E:/Projects/freight-lab 的报价表');
    expect(screen.getByTestId('position-creation-body').textContent).toContain('- 项目根：`E:/Projects/freight-lab`');
    expect(screen.getByTestId('position-creation-body').textContent).toContain('其余随便');
    // Back returns to the describe tab with the text kept, not the directory picker.
    fireEvent.click(screen.getByTestId('position-creation-back'));
    expect(screen.getByTestId('position-creation-describe-text').textContent).toContain('freight-lab');
  });

  it('shows the unavailable catalog as a state with a retry, search disabled', async () => {
    templatesSearch = vi.fn(async () => ({
      ok: true,
      data: {
        status: { available: false, count: 0, fetchedAt: undefined, stale: false, errorCode: undefined },
        results: [],
        categories: [],
      },
    }));
    render(<PositionCreationModal open onClose={() => undefined} />);
    fireEvent.click(screen.getAllByRole('radio')[1]);
    await waitFor(() => {
      expect(screen.getByTestId('position-template-retry')).toBeDefined();
    });
    expect(screen.getByTestId('position-template-status').textContent).toContain(
      'positions.wizard.template.unavailable'
    );
    expect(screen.getByTestId('position-template-search')).toBeDisabled();
  });

  it("maps the catalog's fetch failure code to localized text, never a main-process string", async () => {
    templatesEnsure = vi.fn(async () => ({
      ok: true,
      data: { available: false, count: 0, fetchedAt: undefined, stale: false, errorCode: 'download-failed' },
    }));
    render(<PositionCreationModal open onClose={() => undefined} />);
    fireEvent.click(screen.getAllByRole('radio')[1]);
    await waitFor(() => {
      expect(screen.getByTestId('position-template-retry')).toBeDefined();
    });
    // The test i18n echoes keys, so the key itself proves the renderer localized the code.
    expect(screen.getByTestId('position-template-status').textContent).toContain(
      'positions.wizard.template.errorDownloadFailed'
    );
    expect(screen.getByTestId('position-template-status').textContent).not.toContain('download-failed');
  });
});
