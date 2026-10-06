import {
  Book,
  Brain,
  Browser,
  Code,
  Comments,
  Communication,
  Cpu,
  DocDetail,
  Gavel,
  Inbox,
  Info,
  LinkCloud,
  ListNumbers,
  Login,
  MoreApp,
  Peoples,
  PeoplesTwo,
  Platte,
  Protect,
  Refresh,
  SwitchButton,
  System,
  Target,
  Tool,
  Toolkit,
} from '@icon-park/react';

/**
 * The settings rail: six groups of short pages. No page holds more than twelve rows: a list that would run longer is
 * split into entries (the details are a page per area for that). Never one long page, never a collapsed "advanced"
 * part. Every entry is its own route, `/settings/<id>`; pages that used to exist land on the one that holds their
 * settings now (see {@link RETIRED_SETTINGS_PATHS}).
 */
export type SettingsGroupId = 'preferences' | 'models' | 'kernel' | 'details' | 'capabilities' | 'system';

export type SettingsGroup = {
  id: SettingsGroupId;
  /** i18n key of the group's muted header in the rail. */
  labelKey: string;
};

export const SETTINGS_GROUPS = [
  { id: 'preferences', labelKey: 'settings.groups.preferences' },
  { id: 'models', labelKey: 'settings.groups.models' },
  { id: 'kernel', labelKey: 'settings.groups.kernel' },
  { id: 'details', labelKey: 'settings.groups.details' },
  { id: 'capabilities', labelKey: 'settings.groups.capabilities' },
  { id: 'system', labelKey: 'settings.groups.system' },
] as const satisfies readonly SettingsGroup[];

/**
 * The areas of the details: a page each, with every feature that acts there and, under each one, the decision points
 * it asks the judge. Tools and safety are two pages, and the turn's goal and its board a page apart from the rest of
 * the turn, so that none runs past twelve rows; `other` takes every feature that acts at no decision point.
 */
export const DETAIL_AREAS = ['input', 'context', 'memory', 'tools', 'safety', 'turn', 'goal', 'team', 'other'] as const;
export type DetailArea = (typeof DETAIL_AREAS)[number];

export type DetailsPageId = `details-${DetailArea}`;

export type SettingsPageId =
  | 'appearance'
  | 'system'
  | 'conversations'
  | 'providers'
  | 'default-model'
  | 'board-model'
  | 'judges'
  | 'judge-order'
  | 'features'
  | DetailsPageId
  | 'skills'
  | 'tools'
  | 'assistants'
  | 'browser'
  | 'archived'
  | 'developer'
  | 'about';

export type SettingsPage = {
  id: SettingsPageId;
  group: SettingsGroupId;
  /** Route segment under `/settings/`. */
  path: SettingsPageId;
  /** The whole route: `/settings/<path>`. */
  route: `/settings/${SettingsPageId}`;
  /**
   * i18n key of the page's name where it stands alone — its title, the command palette, the phone's row of chips —
   * so it never needs its group to be understood.
   */
  labelKey: string;
  /** i18n key of the shorter label the rail shows under its group's header, when the group already says the rest. */
  railLabelKey?: string;
  Icon: unknown;
  /** A page for the people who build mu: in the rail and the palette of a development build only. */
  devOnly?: boolean;
  /**
   * A page of what the app keeps for the classic mode (MU_NATIVE_HOST=0), which mu does not read: not listed while mu
   * runs inside the app, and its route leads to {@link NATIVE_REPLACEMENTS} then.
   */
  classicOnly?: boolean;
  /** The page's name while mu runs inside the app, when the page then shows something else. */
  nativeLabelKey?: string;
};

const DETAIL_ICONS: Record<DetailArea, unknown> = {
  input: Login,
  context: DocDetail,
  memory: Brain,
  tools: Tool,
  safety: Protect,
  turn: Refresh,
  goal: Target,
  team: PeoplesTwo,
  other: MoreApp,
};

/** The page of one area of the details. */
export const detailsPageOf = (area: DetailArea): DetailsPageId => `details-${area}`;

const detailsEntry = (area: DetailArea): SettingsPage => ({
  id: detailsPageOf(area),
  group: 'details',
  path: detailsPageOf(area),
  route: `/settings/${detailsPageOf(area)}`,
  labelKey: `mu.pages.details.${area}`,
  railLabelKey: `mu.details.areas.${area}`,
  Icon: DETAIL_ICONS[area],
});

/** Every entry of the rail, flat and in display order; `group` says which header it sits under. */
export const SETTINGS_PAGES = [
  {
    id: 'appearance',
    group: 'preferences',
    path: 'appearance',
    route: '/settings/appearance',
    labelKey: 'settings.appearancePanel',
    Icon: Platte,
  },
  {
    id: 'system',
    group: 'preferences',
    path: 'system',
    route: '/settings/system',
    labelKey: 'settings.system',
    Icon: System,
  },
  {
    id: 'conversations',
    group: 'preferences',
    path: 'conversations',
    route: '/settings/conversations',
    labelKey: 'settings.conversations',
    Icon: Comments,
  },
  {
    id: 'providers',
    group: 'models',
    path: 'providers',
    route: '/settings/providers',
    labelKey: 'mu.sections.providers',
    Icon: LinkCloud,
  },
  {
    id: 'default-model',
    group: 'models',
    path: 'default-model',
    route: '/settings/default-model',
    labelKey: 'mu.sections.defaultModel',
    Icon: Cpu,
  },
  // The model that writes the plain-language board.
  {
    id: 'board-model',
    group: 'models',
    path: 'board-model',
    route: '/settings/board-model',
    labelKey: 'mu.sections.boardModel',
    Icon: Communication,
  },
  // Whether the judge's verdicts take effect, and the judge to ask; then the order of several judges and their fields.
  {
    id: 'judges',
    group: 'kernel',
    path: 'judges',
    route: '/settings/judges',
    labelKey: 'mu.sections.judges',
    Icon: Gavel,
  },
  {
    id: 'judge-order',
    group: 'kernel',
    path: 'judge-order',
    route: '/settings/judge-order',
    labelKey: 'mu.sections.judgeOrder',
    Icon: ListNumbers,
  },
  // The switches that say what mu is; each leads to its row among the details.
  {
    id: 'features',
    group: 'kernel',
    path: 'features',
    route: '/settings/features',
    labelKey: 'mu.sections.coreFeatures',
    Icon: SwitchButton,
  },
  // The context page holds the compaction settings too: one page for context.
  ...DETAIL_AREAS.map(detailsEntry),
  {
    id: 'skills',
    group: 'capabilities',
    path: 'skills',
    route: '/settings/skills',
    labelKey: 'settings.skills',
    Icon: Book,
  },
  // While mu runs inside the app, the tools are the MCP servers mu uses: it does not use the image generation.
  // Both labels stay apart from the details' tools page in the rail.
  {
    id: 'tools',
    group: 'capabilities',
    path: 'tools',
    route: '/settings/tools',
    labelKey: 'mu.capabilities.toolsClassic',
    nativeLabelKey: 'mu.capabilities.mcp.title',
    Icon: Toolkit,
  },
  // The assistants are the classic mode's: mu running inside the app has none.
  {
    id: 'assistants',
    group: 'capabilities',
    path: 'assistants',
    route: '/settings/assistants',
    labelKey: 'settings.assistants',
    Icon: Peoples,
    classicOnly: true,
  },
  {
    id: 'browser',
    group: 'capabilities',
    path: 'browser',
    route: '/settings/browser',
    labelKey: 'settings.browserData.title',
    Icon: Browser,
  },
  {
    id: 'archived',
    group: 'system',
    path: 'archived',
    route: '/settings/archived',
    labelKey: 'settings.archived.navLabel',
    Icon: Inbox,
  },
  // DevTools and the in-app browser's debugging port, for the people who build mu.
  {
    id: 'developer',
    group: 'system',
    path: 'developer',
    route: '/settings/developer',
    labelKey: 'settings.developer.title',
    Icon: Code,
    devOnly: true,
  },
  { id: 'about', group: 'system', path: 'about', route: '/settings/about', labelKey: 'settings.about', Icon: Info },
] as const satisfies readonly SettingsPage[];

/** Where the settings open from the sidebar: the first page of the models group, what a new user sets up first. */
export const SETTINGS_HOME = '/settings/providers';

/**
 * The options of the permission modes feature, which hold the mode a new conversation starts in. The feature acts at
 * the safety decision points, so its row is on the safety page of the details.
 */
const PERMISSION_MODE_PAGE = '/settings/details-safety/permissions';

/**
 * Every settings route that no longer exists, and the page that took it over. Old links — a deep link, a button
 * elsewhere in the app, the pages of the previous settings — land here with their query string kept.
 */
export const RETIRED_SETTINGS_PATHS: Record<string, string> = {
  // The six pages before the rail had groups.
  '/settings/models': '/settings/providers',
  '/settings/kernel': '/settings/judges',
  // The decision points and the other features were one page each, then a group of pages each; now both are the
  // details, a page per area, where each feature's decision points sit under it.
  '/settings/decisions': '/settings/details-input',
  '/settings/more-features': '/settings/details-input',
  '/settings/decisions-input': '/settings/details-input',
  '/settings/decisions-context': '/settings/details-context',
  '/settings/decisions-memory': '/settings/details-memory',
  '/settings/decisions-tools': '/settings/details-tools',
  '/settings/decisions-turn': '/settings/details-turn',
  '/settings/decisions-team': '/settings/details-team',
  '/settings/more-features-input': '/settings/details-input',
  '/settings/more-features-context': '/settings/details-context',
  '/settings/more-features-tools': '/settings/details-tools',
  '/settings/more-features-turn': '/settings/details-turn',
  '/settings/more-features-other': '/settings/details-other',
  // mu's own sections when they lived under /settings/kyrn.
  '/settings/kyrn': '/settings/providers',
  '/settings/kyrn/models': '/settings/providers',
  '/settings/kyrn/permissions': PERMISSION_MODE_PAGE,
  '/settings/kyrn/judges': '/settings/judges',
  '/settings/kyrn/decisions': '/settings/details-input',
  '/settings/kyrn/features': '/settings/features',
  '/settings/kyrn/context': '/settings/details-context',
  '/settings/kyrn/:section': '/settings/providers',
  '/settings/model': '/settings/providers',
  // Runtime agents and the top-level assistants page: the assistants.
  '/settings/agent': '/settings/assistants',
  '/settings/agent/:id/repair': '/settings/assistants',
  '/assistants': '/settings/assistants',
  '/settings/skills-hub': '/settings/skills',
  '/settings/capabilities': '/settings/skills',
  '/settings/capabilities/skills/import-history': '/settings/skills/import-history',
  '/settings/display': '/settings/appearance',
  // Pages folded into others: the judge tiers are the judge order, the compaction settings are on the context page,
  // and the mode of a new conversation is an option of the permission modes feature.
  '/settings/judge-tiers': '/settings/judge-order',
  '/settings/context': '/settings/details-context',
  '/settings/permissions': PERMISSION_MODE_PAGE,
  // The web server mu no longer runs, the voice input and the desktop pet it no longer has: the page each sat next to.
  '/settings/webui': '/settings/system',
  '/settings/voice': '/settings/system',
  '/settings/pet': '/settings/appearance',
};

/**
 * The lists a feature's options were opened from before the details: `<list>/<feature>` and `/<part>` after it. Where
 * a feature is now depends on the harness's manifest, so these are sent on once the settings are read.
 */
export const MOVED_FEATURE_LISTS: readonly string[] = [
  '/settings/features',
  '/settings/more-features',
  '/settings/more-features-input',
  '/settings/more-features-context',
  '/settings/more-features-tools',
  '/settings/more-features-turn',
  '/settings/more-features-other',
];

/**
 * Pages that used to hold other pages as tabs: `?tab=` names the page that holds that tab now. The skills page is
 * still a page of its own, so its link without a tab stays where it is.
 */
export const MOVED_SETTINGS_TABS: Record<string, Record<string, string>> = {
  '/settings/skills': { skills: '/settings/skills', tools: '/settings/tools', agents: '/settings/assistants' },
  '/settings/capabilities': { skills: '/settings/skills', tools: '/settings/tools' },
};

/** `target` with the query of the old link merged in: the old link's own parameters win over the target's. */
function withQuery(target: string, params: URLSearchParams): string {
  const [path, query] = target.split('?');
  const merged = new URLSearchParams(query);
  for (const [key, value] of params) merged.set(key, value);
  const text = merged.toString();
  return text ? `${path}?${text}` : path;
}

/**
 * Where a link to a page that took its tabs apart goes: the page that holds the named tab now, with every other
 * parameter kept. Undefined when the link names no tab that moved.
 */
export function movedSettingsTab(path: string, search: string): string | undefined {
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  const target = tab ? MOVED_SETTINGS_TABS[path]?.[tab] : undefined;
  if (!target) return undefined;
  params.delete('tab');
  return withQuery(target, params);
}

/** Where a retired settings route (a key of {@link RETIRED_SETTINGS_PATHS}) sends a link, query string included. */
export function retiredSettingsTarget(from: string, search: string): string {
  return (
    movedSettingsTab(from, search) ??
    withQuery(RETIRED_SETTINGS_PATHS[from] ?? SETTINGS_HOME, new URLSearchParams(search))
  );
}

/**
 * The settings entry an extension anchored itself to, resolved to a page that exists now. An extension that names a
 * page that never existed keeps its own name and ends up unanchored, as before.
 */
export const SETTINGS_ANCHOR_REMAP: Record<string, SettingsPageId> = {
  models: 'providers',
  kernel: 'judges',
  decisions: 'details-input',
  'more-features': 'details-input',
  'decisions-input': 'details-input',
  'decisions-context': 'details-context',
  'decisions-memory': 'details-memory',
  'decisions-tools': 'details-tools',
  'decisions-turn': 'details-turn',
  'decisions-team': 'details-team',
  'more-features-input': 'details-input',
  'more-features-context': 'details-context',
  'more-features-tools': 'details-tools',
  'more-features-turn': 'details-turn',
  'more-features-other': 'details-other',
  'mu-models': 'providers',
  'mu-permissions': 'details-safety',
  'mu-judges': 'judges',
  'mu-decisions': 'details-input',
  'mu-features': 'features',
  'mu-context': 'details-context',
  'judge-tiers': 'judge-order',
  context: 'details-context',
  permissions: 'details-safety',
  kyrn: 'providers',
  model: 'providers',
  agent: 'assistants',
  'skills-hub': 'skills',
  capabilities: 'skills',
  display: 'appearance',
  webui: 'system',
  voice: 'system',
  pet: 'appearance',
};

/** The entries whose sub-pages are one feature's options each: `<route>/<feature>`, and `/<part>` past the first. */
export const FEATURE_LIST_PAGES: readonly SettingsPageId[] = DETAIL_AREAS.map(detailsPageOf);

/** A development build: one run from its sources, where the pages for the people who build mu are listed. */
const DEVELOPMENT_BUILD = process.env.NODE_ENV !== 'production';

/**
 * Whether a page is listed in the rail, the phone's row of chips and the palette of this build; `native`: while mu runs
 * inside the app.
 */
export const isSettingsPageListed = (page: SettingsPage, native = false): boolean =>
  (!page.devOnly || DEVELOPMENT_BUILD) && !(native && page.classicOnly);

/** A page's name where it stands alone, while mu runs inside the app (`native`) or not. */
export const settingsPageLabelKey = (page: SettingsPage, native = false): string =>
  (native && page.nativeLabelKey) || page.labelKey;

/** The rail's shorter name of a page, while mu runs inside the app (`native`) or not. */
export const settingsPageRailLabelKey = (page: SettingsPage, native = false): string =>
  (native && page.nativeLabelKey) || page.railLabelKey || page.labelKey;

/**
 * Where the route of a classic-only page leads while mu runs inside the app: the assistants to the skills, the page
 * next to them, where what mu brings to a task is.
 */
export const NATIVE_REPLACEMENTS: Partial<Record<SettingsPageId, string>> = {
  assistants: '/settings/skills',
};

/** Whether `pathname` is the page at `route` or one of its own sub-pages (a skill's detail, a feature's options). */
export const isSettingsRouteActive = (pathname: string, route: string): boolean =>
  pathname === route || pathname.startsWith(`${route}/`);
