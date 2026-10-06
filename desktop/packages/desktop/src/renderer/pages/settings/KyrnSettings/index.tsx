import React from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import SettingsPageWrapper from '../components/SettingsPageWrapper';
import { detailsPageOf } from '../settingsNav';
import { areaOf, manifestOf } from './draft';
import SettingsArea, { isMuPage, type AreaView } from './SettingsArea';
import { useSharedMuSettings } from './useMuSettings';

/** Navigation state of a feature's page opened from its list: the way back is then one step back. */
type FromList = { fromList?: boolean };

/**
 * The view a settings route names: `/settings/<page>` is a page of the rail, `/settings/<page>/<feature>` one
 * feature's options on a page of the details, and `/<part>` after it a further page of them. `?feature=` names the row
 * a page of the details scrolls to. Anything else opens on the providers.
 */
export function viewOf(pathname: string, search = ''): AreaView {
  const [, , page = '', feature, part] = pathname.split('/');
  const focus = new URLSearchParams(search).get('feature');
  const view: AreaView = { page: isMuPage(page) ? page : 'providers', ...(focus ? { focus } : {}) };
  if (!feature) return view;
  const number = Number(part);
  return {
    page: view.page,
    feature: decodeURIComponent(feature),
    ...(Number.isInteger(number) && number > 1 ? { part: number } : {}),
  };
}

/** The route of a view: the rail's entry, then the feature and the page of its options, or the row to scroll to. */
export function routeOf({ page, feature, part, focus }: AreaView): string {
  if (feature) return `/settings/${page}/${encodeURIComponent(feature)}${part && part > 1 ? `/${part}` : ''}`;
  return focus ? `/settings/${page}?feature=${encodeURIComponent(focus)}` : `/settings/${page}`;
}

/**
 * mu's own settings pages — the providers, the models, the kernel's and the details — are one area on as many routes.
 * They share the draft of {@link MuSettingsProvider} around the settings routes: moving between them keeps whatever was
 * typed and not yet saved.
 */
export default function MuSettingsPage() {
  const { pathname, search, state } = useLocation();
  const navigate = useNavigate();
  const view = viewOf(pathname, search);
  const onView = (next: AreaView) => {
    const fromList = (state as FromList | null)?.fromList;
    // Back from a feature opened from its list is the step back; otherwise (a deep link) the list replaces it.
    if (!next.feature && view.feature && fromList) void navigate(-1);
    // Another page of the same feature's options takes this one's place, so the way back still leads to the list.
    else if (next.feature && next.feature === view.feature) void navigate(routeOf(next), { replace: true, state });
    // A feature's options, or another page (a core feature's row among the details): a step the way back returns from.
    else if (next.feature || next.page !== view.page)
      void navigate(routeOf(next), next.feature ? { state: { fromList: true } satisfies FromList } : undefined);
    else void navigate(routeOf(next), { replace: true });
  };
  return (
    <SettingsPageWrapper>
      <SettingsArea page={view.page} feature={view.feature} part={view.part} focus={view.focus} onView={onView} />
    </SettingsPageWrapper>
  );
}

/**
 * A feature's options at a list that no longer exists (`/settings/features/<feature>`, the more-features pages): the
 * options of that feature on the page of the details its row is on now, found in the manifest once the settings are
 * read. One the harness no longer has leads to the first page of the details.
 */
export function MovedFeatureOptions() {
  const { feature = '', part } = useParams();
  const { search, state } = useLocation();
  const mu = useSharedMuSettings();
  if (mu && !mu.base && !mu.error) return null;
  const manifest = manifestOf(mu?.base);
  const known = manifest?.features.find((each) => each.name === feature);
  const number = Number(part);
  const target = known
    ? routeOf({
        page: detailsPageOf(areaOf(manifest, known)),
        feature: known.name,
        part: Number.isInteger(number) ? number : undefined,
      })
    : routeOf({ page: 'details-input' });
  return <Navigate to={`${target}${search}`} replace state={state} />;
}
