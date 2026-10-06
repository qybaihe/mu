import React, { Suspense, useEffect, useRef } from 'react';
import { HashRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Button, Result, Space } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import AppLoader from '@renderer/components/layout/AppLoader';
import DocumentTitle from '@renderer/components/layout/DocumentTitle';
import { preloadablePage, preloadWhenIdle, type PreloadablePage } from '@renderer/components/layout/preloadablePage';
import { useCrossSessionRateLimitNotice } from '@/renderer/hooks/system/useCrossSessionRateLimitNotice';
import StartupGate from '@/renderer/pages/settings/KyrnSettings/StartupGate';
import { WelcomePage } from '@/renderer/pages/welcome/page';
import { useFirstRunWelcome } from '@/renderer/pages/welcome/useFirstRunWelcome';
import { MuSettingsProvider } from '@/renderer/pages/settings/KyrnSettings/useMuSettings';
import {
  DETAIL_AREAS,
  FEATURE_LIST_PAGES,
  MOVED_FEATURE_LISTS,
  MOVED_SETTINGS_TABS,
  NATIVE_REPLACEMENTS,
  RETIRED_SETTINGS_PATHS,
  SETTINGS_HOME,
  SETTINGS_PAGES,
  detailsPageOf,
  movedSettingsTab,
  retiredSettingsTarget,
  type DetailsPageId,
  type SettingsPageId,
} from '@/renderer/pages/settings/settingsNav';
import { useNativeEnabled } from '@/renderer/pages/native/hooks/useNativeConversations';
const Conversation = preloadablePage(() => import('@renderer/pages/conversation'));
const NativeConversation = preloadablePage(() => import('@renderer/pages/native'));
const Guid = preloadablePage(() => import('@renderer/pages/guid'));
const MuSettings = preloadablePage(() => import('@renderer/pages/settings/KyrnSettings'));
const MovedFeatureOptions = preloadablePage(() =>
  import('@renderer/pages/settings/KyrnSettings').then((module) => ({ default: module.MovedFeatureOptions }))
);
const SkillsSettings = preloadablePage(() => import('@renderer/pages/settings/SkillsSettings/SkillsHubSettings'));
const SkillDetailPage = preloadablePage(() => import('@renderer/pages/settings/SkillsSettings/SkillDetailPage'));
const ToolsSettings = preloadablePage(() => import('@renderer/pages/settings/ToolsSettings'));
const MuSkillsSettings = preloadablePage(() => import('@renderer/pages/settings/MuCapabilities/SkillsPage'));
const MuMcpSettings = preloadablePage(() => import('@renderer/pages/settings/MuCapabilities/McpPage'));
const AssistantSettings = preloadablePage(() => import('@renderer/pages/settings/AssistantSettings'));
const AppearanceSettings = preloadablePage(() => import('@renderer/pages/settings/AppearanceSettings'));
const SystemSettings = preloadablePage(() => import('@renderer/pages/settings/SystemSettings'));
const ConversationSettings = preloadablePage(
  () => import('@renderer/pages/settings/SystemSettings/ConversationSettings')
);
const BrowserSettings = preloadablePage(() => import('@renderer/pages/settings/SystemSettings/BrowserSettings'));
const AboutSettings = preloadablePage(() => import('@renderer/pages/settings/SystemSettings/AboutSettings'));
const DeveloperSettings = preloadablePage(() => import('@renderer/pages/settings/SystemSettings/DeveloperSettings'));
const ArchivedSettings = preloadablePage(() => import('@renderer/pages/settings/ArchivedSettings'));
const ExtensionSettingsPage = preloadablePage(() => import('@renderer/pages/settings/ExtensionSettingsPage'));
const ComponentsShowcase = preloadablePage(() => import('@renderer/pages/TestShowcase'));
const ScheduledTasksPage = preloadablePage(() => import('@renderer/pages/cron/ScheduledTasksPage'));
const TaskDetailPage = preloadablePage(() => import('@renderer/pages/cron/ScheduledTasksPage/TaskDetailPage'));

/**
 * The pages loaded ahead while the window is idle after its first page, the likeliest next ones first: a conversation,
 * a new one, the settings pages and the scheduled tasks. The guide, the component showcase and the pages reached from
 * inside a settings page load on their visit.
 */
const PRELOADED: readonly PreloadablePage[] = [
  Conversation,
  Guid,
  MuSettings,
  ScheduledTasksPage,
  AppearanceSettings,
  SystemSettings,
  ConversationSettings,
  AssistantSettings,
  ToolsSettings,
  SkillsSettings,
  MuSkillsSettings,
  MuMcpSettings,
  BrowserSettings,
  AboutSettings,
  ArchivedSettings,
  TaskDetailPage,
];

const RouteFailure = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div role='alert' className='flex flex-1 items-center justify-center min-h-0'>
      <Result
        status='error'
        title={t('common.error')}
        extra={
          <Space>
            <Button type='primary' onClick={() => window.location.reload()}>
              {t('common.reload')}
            </Button>
            <Button onClick={() => void navigate('/guid')}>{t('common.back')}</Button>
          </Space>
        }
      />
    </div>
  );
};

class RouteErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Route] Page failed to load or render', error, info.componentStack);
  }

  render() {
    return this.state.failed ? <RouteFailure /> : this.props.children;
  }
}

/**
 * A navigation whose state says `samePage: true` moves a page to a path of its own without leaving it: a native
 * conversation whose draft id gave way to its session's id. The page stays mounted, with what the person was typing.
 */
const isSamePage = (state: unknown): boolean =>
  typeof state === 'object' && state !== null && (state as { samePage?: unknown }).samePage === true;

/** Keep page failures inside the route, preserving navigation and running agents. */
export const RouteContent: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { pathname, state } = useLocation();
  // Any other move to another path starts the page afresh, and a failed page with it.
  const page = useRef(pathname);
  if (!isSamePage(state)) page.current = pathname;
  return (
    <RouteErrorBoundary key={page.current}>
      <Suspense fallback={<AppLoader />}>{children}</Suspense>
    </RouteErrorBoundary>
  );
};

const withRouteFallback = (Component: React.ComponentType) => (
  <RouteContent>
    <Component />
  </RouteContent>
);

/** The page each entry of the settings rail opens: mu's own sections are one area, routed by the path. */
const SETTINGS_PAGE_ELEMENTS: Record<SettingsPageId, PreloadablePage> = {
  appearance: AppearanceSettings,
  system: SystemSettings,
  conversations: ConversationSettings,
  providers: MuSettings,
  'default-model': MuSettings,
  'board-model': MuSettings,
  judges: MuSettings,
  'judge-order': MuSettings,
  features: MuSettings,
  ...(Object.fromEntries(DETAIL_AREAS.map((area) => [detailsPageOf(area), MuSettings])) as Record<
    DetailsPageId,
    PreloadablePage
  >),
  skills: SkillsSettings,
  tools: ToolsSettings,
  assistants: AssistantSettings,
  browser: BrowserSettings,
  archived: ArchivedSettings,
  developer: DeveloperSettings,
  about: AboutSettings,
};

/**
 * The pages that show what mu itself uses while it runs inside the app, in place of the app's own storage, which mu
 * does not read: its skills, and its MCP servers in place of the tools (MCP servers and the image generation).
 */
const NATIVE_PAGE_ELEMENTS: Partial<Record<SettingsPageId, PreloadablePage>> = {
  skills: MuSkillsSettings,
  tools: MuMcpSettings,
};

/**
 * A page that depends on whether mu runs inside the app: there, its native page, or for a page of the classic mode
 * alone the page it leads to; otherwise the classic page. Nothing is drawn until the main process said which, so
 * neither page starts reading for the other.
 */
export const ByMode: React.FC<{ classic: PreloadablePage; native?: PreloadablePage; elsewhere?: string }> = ({
  classic,
  native,
  elsewhere,
}) => {
  const { state } = useLocation();
  const on = useNativeEnabled();
  if (on === undefined) return null;
  if (on && elsewhere) return <Navigate to={elsewhere} replace state={state} />;
  return withRouteFallback(on && native ? native : classic);
};

/** The element of a settings entry: by mode when the native mode changes it, the page itself otherwise. */
const settingsPageElement = (id: SettingsPageId): React.ReactElement =>
  NATIVE_PAGE_ELEMENTS[id] || NATIVE_REPLACEMENTS[id] ? (
    <ByMode
      classic={SETTINGS_PAGE_ELEMENTS[id]}
      native={NATIVE_PAGE_ELEMENTS[id]}
      elsewhere={NATIVE_REPLACEMENTS[id]}
    />
  ) : (
    withRouteFallback(SETTINGS_PAGE_ELEMENTS[id])
  );

/**
 * Around every settings page: the one draft of mu's settings they all edit. A route change draws the page afresh, so
 * the draft lives here, above the pages: a change typed on one page is still there, unsaved, on the next, until the
 * settings are left.
 */
const SettingsScope: React.FC = () => (
  <MuSettingsProvider>
    <Outlet />
  </MuSettingsProvider>
);

/**
 * A settings route that no longer exists (a key of `RETIRED_SETTINGS_PATHS`), sent to the page that took it over.
 * Whatever the old link carried travels with it: its query string (`?highlight=`, `?view=`), so a deep link still
 * arrives at the thing it named, and its navigation state (an assistant to open).
 */
export const RetiredSettingsPath: React.FC<{ from: string }> = ({ from }) => {
  const { search, state } = useLocation();
  return <Navigate to={retiredSettingsTarget(from, search)} replace state={state} />;
};

/**
 * A page that used to hold other pages as tabs (the skills page held tools and assistants): a link naming one of those
 * tabs (`?tab=tools`) goes to the page that holds it now, with the rest of its query. Any other link draws the page.
 */
export const WithMovedTabs: React.FC<{ path: string; children: React.ReactElement }> = ({ path, children }) => {
  const { search, state } = useLocation();
  const moved = movedSettingsTab(path, search);
  return moved ? <Navigate to={moved} replace state={state} /> : children;
};

const AppLayout: React.FC<{ layout: React.ReactElement }> = ({ layout }) => {
  const location = useLocation();
  // Mounted once for every route: the loop warning has to reach the user even
  // when they are looking at a THIRD conversation, which is the whole reason it
  // is a broadcast rather than an in-conversation banner. The hook asks the
  // backend who this client is on its own.
  useCrossSessionRateLimitNotice();
  // Here, not on the home page: the check runs while the start screen is up, and a first start opens on the guide.
  useFirstRunWelcome();

  // Do not obstruct an existing task while the main process is being upgraded: a conversation passes the gate. The
  // gate stays in the tree on every page, open on a conversation. Leaving it out there would give the layout another
  // parent, and React would mount the whole layout afresh on every step between a conversation and any other page:
  // the sidebar forgot the conversation "back to chat" returns to, and the work panel reloaded its pages.
  return <StartupGate open={location.pathname.startsWith('/conversation/')}>{React.cloneElement(layout)}</StartupGate>;
};

const PanelRoute: React.FC<{ layout: React.ReactElement }> = ({ layout }) => {
  useEffect(() => preloadWhenIdle(PRELOADED), []);
  return (
    <HashRouter>
      <DocumentTitle />
      <Routes>
        <Route element={<AppLayout layout={layout} />}>
          <Route index element={<Navigate to='/guid' replace />} />
          <Route path='/guid' element={withRouteFallback(Guid)} />
          <Route path='/welcome' element={withRouteFallback(WelcomePage)} />
          <Route path='/conversation/:id' element={withRouteFallback(Conversation)} />
          {/* A conversation on the native host: the page goes home unless the main process runs it (not with MU_NATIVE_HOST=0). */}
          <Route path='/conversation/native/:id' element={withRouteFallback(NativeConversation)} />
          <Route path='/team/:id' element={<Navigate to='/guid' replace />} />
          {/* The settings rail: one route per entry, all under one draft of mu's settings. */}
          <Route element={<SettingsScope />}>
            {SETTINGS_PAGES.map(({ id, route }) => (
              <Route
                key={id}
                path={route}
                element={
                  route in MOVED_SETTINGS_TABS ? (
                    <WithMovedTabs path={route}>{settingsPageElement(id)}</WithMovedTabs>
                  ) : (
                    settingsPageElement(id)
                  )
                }
              />
            ))}
            {/* One feature's options, opened from its list, and the pages after the first when they fill more. */}
            {FEATURE_LIST_PAGES.map((id) => (
              <Route key={id} path={`/settings/${id}/:feature/:part?`} element={withRouteFallback(MuSettings)} />
            ))}
            {/* A feature's options at a list that no longer exists: the page of the details its row is on now. */}
            {MOVED_FEATURE_LISTS.map((list) => (
              <Route key={list} path={`${list}/:feature/:part?`} element={withRouteFallback(MovedFeatureOptions)} />
            ))}
            {/* The app's own skills' history and details: while mu runs inside the app, its skills page. */}
            <Route path='/settings/skills/import-history' element={settingsPageElement('skills')} />
            <Route
              path='/settings/skills/detail/:skillName'
              element={<ByMode classic={SkillDetailPage} elsewhere='/settings/skills' />}
            />
            <Route path='/settings/ext/:tabId' element={withRouteFallback(ExtensionSettingsPage)} />
          </Route>

          {/* Retired destinations — old deep links keep working. */}
          {Object.keys(RETIRED_SETTINGS_PATHS).map((from) => (
            <Route key={from} path={from} element={<RetiredSettingsPath from={from} />} />
          ))}
          <Route path='/settings' element={<Navigate to={SETTINGS_HOME} replace />} />
          <Route path='/test/components' element={withRouteFallback(ComponentsShowcase)} />
          <Route path='/scheduled' element={withRouteFallback(ScheduledTasksPage)} />
          <Route path='/scheduled/:job_id' element={withRouteFallback(TaskDetailPage)} />
        </Route>
        <Route path='*' element={<Navigate to='/guid' replace />} />
      </Routes>
    </HashRouter>
  );
};

export default PanelRoute;
