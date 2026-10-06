import type { TFunction } from 'i18next';
import useSWR from 'swr';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { localized, localizedTexts, type HarnessManifest } from '@/common/kyrn/manifest';
import { areaOf, isTerminalOnly, manifestOf, matches, strayAreaOf } from '../KyrnSettings/draft';
import {
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  detailsPageOf,
  isSettingsPageListed,
  type DetailArea,
  type SettingsPageId,
} from '../settingsNav';

/**
 * The texts on each page that are always there, by i18n key: the rows' titles and the sentences under them, what the
 * rail's search finds a page by besides its own name and description. What the harness describes (every feature and
 * decision point) is found from its manifest instead.
 */
const PAGE_TEXTS: Partial<Record<SettingsPageId, string[]>> = {
  appearance: [
    'settings.appearanceDescription',
    'settings.language',
    'settings.theme',
    'settings.fonts',
    'settings.scale',
  ],
  system: [
    'settings.systemDescription',
    'settings.startOnBoot',
    'settings.closeToTray',
    'settings.closeToMenuBar',
    'settings.hardwareAcceleration',
    'settings.notification',
    'settings.cronNotificationEnabled',
    'settings.workDir',
    'settings.logDir',
    'mu.importChats.title',
  ],
  conversations: [
    'settings.conversationsDescription',
    'settings.promptTimeout',
    'settings.agentIdleTimeout',
    'settings.previewTextSizeLimit',
    'settings.saveUploadToWorkspace',
    'settings.crossSessionMessage',
  ],
  providers: ['mu.providers.lead'],
  'default-model': ['mu.defaults.summary', 'mu.defaults.provider', 'mu.defaults.model', 'mu.defaults.level'],
  'board-model': ['mu.boardModel.summary', 'mu.boardModel.pick', 'mu.boardModel.session'],
  judges: [
    'mu.judges.mode',
    'mu.judges.modeHelp',
    'mu.judges.service',
    'mu.judges.choices.jev.title',
    'mu.judges.choices.laya.title',
    'mu.judges.choices.clm.title',
  ],
  'judge-order': ['mu.judges.tiersHelp', 'mu.judges.order', 'mu.judges.model'],
  features: ['mu.features.lead'],
  'details-context': ['mu.context.lead', 'mu.context.auto', 'mu.context.limit'],
  skills: ['settings.skillsHub.description'],
  tools: ['settings.toolsDescription'],
  browser: [
    'settings.browserData.description',
    'settings.browserData.agentControlLabel',
    'settings.browserData.clearLabel',
  ],
  archived: ['settings.archived.description'],
  developer: ['settings.developer.description', 'settings.devTools', 'settings.cdp.title'],
  about: ['settings.aboutDescription'],
};

/** One thing the rail's search finds: a page, or a feature or decision point on a page of the details. */
export type SettingsHit = {
  key: string;
  label: string;
  /** Where it is: the group of a page, the page of a feature, the page and feature of a decision point. */
  where: string;
  /** The route it opens, with `?feature=` for a row of the details. */
  path: string;
};

const pageName = (t: TFunction, area: DetailArea): string => t(`mu.pages.details.${area}`);

/**
 * Everything whose texts hold every word of the query, in the rail's order: the pages first (by their name, the group
 * they are in and the texts on them), then the features (in every language the harness has, so an English word finds
 * its entry in a Chinese screen too) and the decision points whose names are not their feature's.
 */
export function searchSettings(
  query: string,
  t: TFunction,
  language: string,
  manifest: HarnessManifest | undefined
): SettingsHit[] {
  if (!query.trim()) return [];
  const groups = new Map<string, string>(SETTINGS_GROUPS.map((group) => [group.id, t(group.labelKey)]));
  const pages = SETTINGS_PAGES.filter(isSettingsPageListed).flatMap((page): SettingsHit[] => {
    const label = t(page.labelKey);
    const rail = 'railLabelKey' in page ? t(page.railLabelKey) : '';
    const group = groups.get(page.group) ?? '';
    const texts = (PAGE_TEXTS[page.id] ?? []).map((key) => t(key));
    return matches(query, label, rail, group, ...texts)
      ? [{ key: `page:${page.id}`, label, where: group, path: page.route }]
      : [];
  });
  if (!manifest) return pages;

  const say = (text: Parameters<typeof localized>[0]) => localized(text, language);
  const features = new Map(manifest.features.map((feature) => [feature.name, feature]));
  const rows = manifest.features
    .filter((feature) => !isTerminalOnly(feature.name))
    .flatMap((feature): SettingsHit[] => {
      const area = areaOf(manifest, feature);
      return matches(query, feature.name, ...localizedTexts(feature.title), ...localizedTexts(feature.summary))
        ? [
            {
              key: `feature:${feature.name}`,
              label: say(feature.title),
              where: pageName(t, area),
              path: `/settings/${detailsPageOf(area)}?feature=${encodeURIComponent(feature.name)}`,
            },
          ]
        : [];
    });
  const points = manifest.decisions.flatMap((decision): SettingsHit[] => {
    const feature = features.get(decision.feature);
    const label = say(decision.title);
    // A point named as its feature is found as the feature: its row is there, under it.
    if (feature && say(feature.title) === label) return [];
    if (!matches(query, decision.id, ...localizedTexts(decision.title), ...localizedTexts(decision.summary))) return [];
    const area = feature ? areaOf(manifest, feature) : strayAreaOf(decision);
    const page = pageName(t, area);
    return [
      {
        key: `decision:${decision.id}`,
        label,
        where: feature ? `${page} · ${say(feature.title)}` : page,
        path: feature
          ? `/settings/${detailsPageOf(area)}?feature=${encodeURIComponent(feature.name)}`
          : `/settings/${detailsPageOf(area)}`,
      },
    ];
  });
  return [...pages, ...rows, ...points];
}

/** The harness's manifest for the search, read once something is searched; nothing when the settings cannot be read. */
async function readManifest(): Promise<HarnessManifest | undefined> {
  try {
    return manifestOf(unwrap(await kyrnBridge.settings.invoke()));
  } catch {
    return undefined;
  }
}

export function useSearchManifest(active: boolean): HarnessManifest | undefined {
  const { data } = useSWR(active ? 'mu.settingsSearchManifest' : null, readManifest, { revalidateOnFocus: false });
  return data;
}
