/** The fallback's view of mu's releases: GitHub's API, the newest release, and the installer for this system. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLatestRelease, isNewerVersion, pickRecommendedAsset } from '@/process/services/update/githubReleases';

const RELEASES_API = 'https://api.github.com/repos/qybaihe/mu/releases';

const asset = (tag: string, name: string) => ({
  name,
  browser_download_url: `https://github.com/qybaihe/mu/releases/download/${tag}/${name}`,
  size: 100,
});

/** A release as the next tag publishes it: installers, the update feed, the source archive and the checksums. */
const release = (tag: string, extra: Record<string, unknown> = {}) => {
  const v = tag.slice(1);
  return {
    tag_name: tag,
    name: `mu ${tag}`,
    body: `notes for ${tag}`,
    html_url: `https://github.com/qybaihe/mu/releases/tag/${tag}`,
    published_at: '2026-09-23T00:00:00Z',
    prerelease: true,
    draft: false,
    assets: [
      `mu-${v}-mac-arm64.dmg`,
      `mu-${v}-mac-arm64.zip`,
      `mu-${v}-mac-x64.dmg`,
      `mu-${v}-mac-x64.zip`,
      `mu-${v}-win-x64.exe`,
      `mu-${v}-win-arm64.exe`,
      `mu-${v}-linux-amd64.deb`,
      `mu-${v}-linux-arm64.deb`,
      `mu-${v}-mac-arm64.zip.blockmap`,
      'latest-mac.yml',
      'latest.yml',
      'latest-linux.yml',
      `mu-${v}-source.tar.gz`,
      'SHA256SUMS',
    ].map((name) => asset(tag, name)),
    ...extra,
  };
};

/** Only mu's own release list answers; any other request fails the test. */
const stubFetch = (answer: () => Response) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === RELEASES_API) return answer();
    throw new Error(`unexpected fetch: ${String(input)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const onSystem = (platform: NodeJS.Platform, arch: string) => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
};
const realPlatform = process.platform;
const realArch = process.arch;

afterEach(() => {
  vi.unstubAllGlobals();
  onSystem(realPlatform, realArch);
});

describe('fetchLatestRelease', () => {
  it('finds the newest release, pre-releases included, and asks nobody but qybaihe/mu', async () => {
    onSystem('darwin', 'arm64');
    const fetchMock = stubFetch(() =>
      json([
        release('v0.1.2'),
        release('v0.1.3'),
        release('v0.1.4', { draft: true }),
        // Tags of the repository's other packages are no app releases.
        { ...release('v0.1.9'), tag_name: 'mu-agent-v0.1.9' },
        release('nightly'),
      ])
    );
    const latest = await fetchLatestRelease();
    expect(latest).toMatchObject({
      version: '0.1.3',
      prerelease: true,
      htmlUrl: 'https://github.com/qybaihe/mu/releases/tag/v0.1.3',
    });
    // The update feed, the blockmaps, the source archive and the checksums are no installers.
    expect(latest?.assets.map((a) => a.name)).toEqual([
      'mu-0.1.3-mac-arm64.dmg',
      'mu-0.1.3-mac-arm64.zip',
      'mu-0.1.3-mac-x64.dmg',
      'mu-0.1.3-mac-x64.zip',
      'mu-0.1.3-win-x64.exe',
      'mu-0.1.3-win-arm64.exe',
      'mu-0.1.3-linux-amd64.deb',
      'mu-0.1.3-linux-arm64.deb',
    ]);
    expect(latest?.recommendedAsset?.url).toBe(
      'https://github.com/qybaihe/mu/releases/download/v0.1.3/mu-0.1.3-mac-arm64.dmg'
    );
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([RELEASES_API]);
  });

  it('answers null when there is no release yet', async () => {
    stubFetch(() => json([]));
    await expect(fetchLatestRelease()).resolves.toBeNull();
  });

  it('fails with a reason code the app can say in words', async () => {
    stubFetch(() => new Response('nope', { status: 502 }));
    await expect(fetchLatestRelease()).rejects.toMatchObject({ info: { code: 'serverError', status: 502 } });

    stubFetch(() => json({ message: 'Not a list' }));
    await expect(fetchLatestRelease()).rejects.toMatchObject({ info: { code: 'invalidMetadata' } });

    // The release list itself is missing: a server error, not "this version has no automatic update".
    stubFetch(() => new Response('', { status: 404 }));
    await expect(fetchLatestRelease()).rejects.toMatchObject({ info: { code: 'serverError', status: 404 } });
  });

  it('gives up after its timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            )
          )
      )
    );
    await expect(fetchLatestRelease(10)).rejects.toMatchObject({ info: { code: 'timeout' } });
  });
});

describe('pickRecommendedAsset', () => {
  const assets = release('v0.1.3').assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }));
  const pick = (platform: NodeJS.Platform, arch: string) => pickRecommendedAsset(assets, { platform, arch })?.name;

  it('picks the installer of each system and architecture', () => {
    expect(pick('darwin', 'arm64')).toBe('mu-0.1.3-mac-arm64.dmg');
    expect(pick('darwin', 'x64')).toBe('mu-0.1.3-mac-x64.dmg');
    expect(pick('win32', 'x64')).toBe('mu-0.1.3-win-x64.exe');
    expect(pick('win32', 'arm64')).toBe('mu-0.1.3-win-arm64.exe');
    expect(pick('linux', 'x64')).toBe('mu-0.1.3-linux-amd64.deb');
    expect(pick('linux', 'arm64')).toBe('mu-0.1.3-linux-arm64.deb');
  });

  it("never offers another system's installer when this one's is missing", () => {
    const withoutLinux = assets.filter((a) => !a.name.includes('linux'));
    expect(pickRecommendedAsset(withoutLinux, { platform: 'linux', arch: 'x64' })).toBeUndefined();
    const withoutArmExe = assets.filter((a) => a.name !== 'mu-0.1.3-win-arm64.exe');
    expect(pickRecommendedAsset(withoutArmExe, { platform: 'win32', arch: 'arm64' })).toBeUndefined();
  });
});

describe('isNewerVersion', () => {
  it('is strictly greater, loose versions included', () => {
    expect(isNewerVersion('0.1.3', '0.1.2')).toBe(true);
    expect(isNewerVersion('0.1.2', '0.1.2')).toBe(false);
    expect(isNewerVersion('0.1.1', '0.1.2')).toBe(false);
    expect(isNewerVersion('0.2.0', 'v0.1.9-dev')).toBe(true);
  });
});
