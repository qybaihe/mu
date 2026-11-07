import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import type { ICronJob } from '@/common/adapter/ipcBridge';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import cron from '@/renderer/services/i18n/locales/en-US/cron.json';

const { jobs } = vi.hoisted(() => ({ jobs: { list: [] as ICronJob[], loading: false } }));
vi.mock('@renderer/pages/cron/useCronJobs', () => ({
  useAllCronJobs: () => ({ jobs: jobs.list, loading: jobs.loading, pauseJob: vi.fn(), resumeJob: vi.fn() }),
}));
vi.mock('@renderer/pages/conversation/hooks/useConversationAssistants', () => ({
  useConversationAssistants: () => ({ presetAssistants: [] }),
}));
vi.mock('@renderer/utils/model/agentLogo', () => ({ useAgentLogos: () => ({}), resolveAgentLogo: () => undefined }));
vi.mock('@/common/config/configService', () => ({ configService: { get: () => false, setLocal: vi.fn() } }));
vi.mock('@/renderer/hooks/context/ThemeContext', () => ({ useThemeContext: () => ({ fontScale: 1 }) }));
vi.mock('@renderer/pages/cron/ScheduledTasksPage/CreateTaskDialog', () => ({ default: () => null }));
// The new-task button's own menu is not what this page test is about: its label is.
vi.mock('@/renderer/components/base/TalkToButlerButton', () => ({
  default: ({ label }: { label: string }) => <span data-testid='new-task'>{label}</span>,
}));

import ScheduledTasksPage from '@/renderer/pages/cron/ScheduledTasksPage';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en-US',
    resources: { 'en-US': { translation: { common, cron } } },
    interpolation: { escapeValue: false },
  });
});
afterEach(() => {
  cleanup();
  jobs.list = [];
  jobs.loading = false;
});

const page = () =>
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <ScheduledTasksPage />
      </MemoryRouter>
    </I18nextProvider>
  );

const job = (name: string): ICronJob =>
  ({
    id: `job-${name}`,
    name,
    description: '',
    enabled: true,
    schedule: { kind: 'cron', expr: '0 10 * * *', timezone: 'UTC', description: '' },
    metadata: { created_at_ms: 1, updated_at_ms: 1, agent_type: 'acp', agent_config: { backend: 'codex', name: 'mu' } },
    target: { execution_mode: 'new_conversation', payload: { text: name } },
    state: { next_run_at_ms: 1, run_count: 0, retry_count: 0, max_retries: 3 },
  }) as unknown as ICronJob;

describe('the scheduled tasks page with nothing to list', () => {
  it('says there are none yet and how to make one, in words, with no picture', () => {
    const { container } = page();
    const empty = screen.getByTestId('scheduled-tasks-empty');
    expect(empty).toHaveTextContent('No scheduled tasks yet.');
    // The hint names the button as the button itself reads.
    expect(screen.getByTestId('new-task')).toHaveTextContent('New task');
    expect(empty).toHaveTextContent('Use "New task" above to make one.');
    expect(container.querySelector('.arco-empty')).toBeNull();
  });

  it('says so in one quiet line when a search finds nothing', () => {
    jobs.list = [job('Morning summary')];
    const { container } = page();
    fireEvent.change(screen.getByPlaceholderText('Search tasks…'), { target: { value: 'nothing like it' } });
    expect(screen.getByText('No matching scheduled tasks.')).toBeInTheDocument();
    expect(screen.queryByTestId('scheduled-tasks-empty')).toBeNull();
    expect(container.querySelector('.arco-empty')).toBeNull();
  });

  it('shows a quiet line while the tasks load', () => {
    jobs.loading = true;
    page();
    expect(screen.getByText(common.loading)).toBeInTheDocument();
    expect(screen.queryByTestId('scheduled-tasks-empty')).toBeNull();
  });
});

describe('the scheduled tasks page switches', () => {
  it('are named: keep awake after its label, a task after its name', () => {
    jobs.list = [job('Morning summary')];
    page();
    expect(screen.getByRole('switch', { name: 'Keep awake' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Morning summary' })).toBeChecked();
  });
});
