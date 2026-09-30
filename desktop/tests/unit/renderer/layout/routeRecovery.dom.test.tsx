import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Link, MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { RouteContent } from '@/renderer/components/layout/Router';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/components/layout/AppLoader', () => ({ default: () => <span>Loading</span> }));
vi.mock('@/renderer/components/layout/DocumentTitle', () => ({ default: () => null }));
vi.mock('@/renderer/hooks/system/useCrossSessionRateLimitNotice', () => ({ useCrossSessionRateLimitNotice: () => {} }));
vi.mock('@/renderer/pages/settings/KyrnSettings/StartupGate', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter initialEntries={['/conversation/broken']}>
      <nav>
        Session navigation<Link to='/conversation/working'>Working session</Link>
      </nav>
      <RouteContent>{children}</RouteContent>
    </MemoryRouter>
  );
}

function Page(): React.ReactNode {
  const { pathname } = useLocation();
  if (pathname === '/conversation/broken') throw new Error('fixture render failure');
  return <span>{pathname}</span>;
}

describe('route failure recovery', () => {
  it('contains a failed lazy import instead of unmounting the entire window', async () => {
    const FailedPage = React.lazy(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')));
    render(
      <Shell>
        <FailedPage />
      </Shell>
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('common.error');
    expect(screen.getByRole('navigation')).toHaveTextContent('Session navigation');
    expect(screen.getByRole('button', { name: 'common.reload' })).toBeEnabled();
  });

  it('lets users leave a failed page for the home route', async () => {
    render(
      <Shell>
        <Page />
      </Shell>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'common.back' }));
    expect(await screen.findByText('/guid')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('resets the error boundary when switching to a different session', async () => {
    render(
      <Shell>
        <Page />
      </Shell>
    );
    expect(await screen.findByRole('alert')).toBeVisible();
    fireEvent.click(screen.getByRole('link', { name: 'Working session' }));
    expect(await screen.findByText('/conversation/working')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('a page that moves to a path of its own', () => {
  /** Counts its mounts, and offers both kinds of move: to another page, and to a new path of its own. */
  function Counted({ mounts }: { mounts: string[] }) {
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const [draft, setDraft] = React.useState('');
    React.useEffect(() => {
      mounts.push(pathname);
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per mount
    }, []);
    return (
      <div>
        <span>{pathname}</span>
        <input aria-label='draft' value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button
          type='button'
          onClick={() => void navigate('/conversation/native/s1', { replace: true, state: { samePage: true } })}
        >
          follow
        </button>
        <button type='button' onClick={() => void navigate('/conversation/native/s2')}>
          other
        </button>
      </div>
    );
  }

  it('stays mounted, with what it holds, when the move says it is the same page; any other move starts it afresh', async () => {
    const mounts: string[] = [];
    render(
      <MemoryRouter initialEntries={['/conversation/native/draft-1']}>
        <RouteContent>
          <Counted mounts={mounts} />
        </RouteContent>
      </MemoryRouter>
    );
    fireEvent.change(await screen.findByLabelText('draft'), { target: { value: '/lessons' } });
    fireEvent.click(screen.getByRole('button', { name: 'follow' }));
    expect(await screen.findByText('/conversation/native/s1')).toBeVisible();
    expect(screen.getByLabelText('draft')).toHaveValue('/lessons');
    expect(mounts).toEqual(['/conversation/native/draft-1']);
    // An ordinary move (every conversation of the classic path moves so) mounts the page anew, as before.
    fireEvent.click(screen.getByRole('button', { name: 'other' }));
    expect(await screen.findByText('/conversation/native/s2')).toBeVisible();
    expect(screen.getByLabelText('draft')).toHaveValue('');
    expect(mounts).toEqual(['/conversation/native/draft-1', '/conversation/native/s2']);
  });
});
