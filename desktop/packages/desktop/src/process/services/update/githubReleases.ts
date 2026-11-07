/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GitHubReleaseAsset, UpdateReleaseInfo } from '@/common/update/updateTypes';
import { UpdateError } from '@/common/update/updateErrors';
import * as path from 'path';
import semver from 'semver';

/**
 * mu's builds are the releases of its own repository, and it asks no other update server: the server or repository of
 * the app it was forked from would offer that app's installer as an update of mu.
 */
export const MU_REPO = 'qybaihe/mu';
export const MU_RELEASES_URL = `https://github.com/${MU_REPO}/releases`;
export const USER_AGENT = 'mu';

const RELEASES_API_URL = `https://api.github.com/repos/${MU_REPO}/releases`;
const REQUEST_TIMEOUT_MS = 30_000;
const INSTALLER_EXTS = new Set(['.exe', '.msi', '.dmg', '.zip', '.deb', '.rpm']);

type GitHubReleaseApiAsset = {
  name: string;
  browser_download_url: string;
  size: number;
  content_type?: string;
};

export type GitHubReleaseApi = {
  tag_name: string;
  name?: string;
  body?: string;
  html_url: string;
  published_at?: string;
  prerelease: boolean;
  draft: boolean;
  assets?: GitHubReleaseApiAsset[];
};

type RuntimePlatformInfo = {
  platform: NodeJS.Platform;
  arch: string;
};

type CanonicalArch = 'x64' | 'arm64' | 'ia32';

/** The version of a release tag: `v0.1.3` is 0.1.3; the tags of the other packages here (`mu-agent-v0.1.3`) are none. */
const tagVersion = (tag: string): string | null => {
  const trimmed = tag.trim();
  const withoutV = trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
  if (!/^\d+\.\d+\.\d+/.test(withoutV)) return null;
  return semver.valid(withoutV);
};

const normalizeArch = (arch: string): CanonicalArch => {
  if (arch === 'arm64') return 'arm64';
  if (arch === 'ia32' || arch === 'x32') return 'ia32';
  return 'x64';
};

const detectAssetArchs = (nameLower: string): Set<CanonicalArch> => {
  const detected = new Set<CanonicalArch>();

  if (/\b(arm64|aarch64)\b/.test(nameLower)) detected.add('arm64');
  if (/\b(x64|x86_64|amd64)\b/.test(nameLower)) detected.add('x64');

  const hasX86Token = /\bx86\b/.test(nameLower) && !/\bx86[_-]?64\b/.test(nameLower);
  if (/\b(ia32|x32|32bit)\b/.test(nameLower) || hasX86Token) detected.add('ia32');

  return detected;
};

const getPlatformHints = (runtime: RuntimePlatformInfo = { platform: process.platform, arch: process.arch }) => {
  const platform = runtime.platform;
  const normalizedArch = normalizeArch(runtime.arch);

  const archHints =
    normalizedArch === 'arm64'
      ? ['arm64', 'aarch64']
      : normalizedArch === 'ia32'
        ? ['ia32', 'x86', 'x32', '32bit']
        : ['x64', 'x86_64', 'amd64'];

  // electron-builder artifact names often include one of these
  const platformHints =
    platform === 'win32' ? ['win', 'win32', 'windows'] : platform === 'darwin' ? ['mac', 'darwin', 'osx'] : ['linux'];

  return { platform, normalizedArch, archHints, platformHints };
};

const scoreAsset = (asset: GitHubReleaseAsset, runtime?: RuntimePlatformInfo): number => {
  const { platform, normalizedArch, archHints, platformHints } = getPlatformHints(runtime);
  const nameLower = asset.name.toLowerCase();
  const ext = path.extname(asset.name);

  const detectedArchs = detectAssetArchs(nameLower);
  if (detectedArchs.size > 0 && !detectedArchs.has(normalizedArch)) {
    return -1;
  }
  // Another system's installer is never this one's, even when this system's is missing from the release.
  if (!platformHints.some((hint) => nameLower.includes(hint))) {
    return -1;
  }

  let score = 0;

  if (archHints.some((hint) => nameLower.includes(hint))) score += 10;
  if (detectedArchs.has(normalizedArch)) score += 15;

  // Prefer installer formats per platform
  if (platform === 'win32') {
    if (ext === '.exe') score += 100;
    if (ext === '.msi') score += 90;
    if (ext === '.zip') score += 50;
  } else if (platform === 'darwin') {
    if (ext === '.dmg') score += 100;
    if (ext === '.zip') score += 70;
  } else {
    if (ext === '.deb') score += 100;
    if (ext === '.rpm') score += 80;
    if (ext === '.zip') score += 40;
  }

  return score;
};

/** The installer for this system (or `runtime`) among a release's files, if there is one. */
export const pickRecommendedAsset = (
  assets: GitHubReleaseAsset[],
  runtime?: RuntimePlatformInfo
): GitHubReleaseAsset | undefined => {
  const scored = assets
    .map((asset) => ({ asset, score: scoreAsset(asset, runtime) }))
    .filter((item) => item.score >= 0)
    .toSorted((a, b) => b.score - a.score);

  return scored[0]?.asset;
};

/**
 * The newest of mu's releases, with its installers: the highest version tag among the releases that are not drafts.
 * Every mu build is a preview for now, published as a GitHub pre-release, so pre-releases count.
 */
export const latestRelease = (releases: GitHubReleaseApi[]): UpdateReleaseInfo | null => {
  let newest: { release: GitHubReleaseApi; version: string } | null = null;
  for (const release of releases) {
    if (!release || release.draft) continue;
    const version = tagVersion(release.tag_name);
    if (version && (!newest || semver.gt(version, newest.version))) newest = { release, version };
  }
  if (!newest) return null;
  const { release, version } = newest;
  // The update feed (latest*.yml, .blockmap) and the source archive are no installers.
  const assets: GitHubReleaseAsset[] = (release.assets ?? [])
    .filter((asset) => asset && INSTALLER_EXTS.has(path.extname(asset.name)))
    .map((asset) => {
      const installer: GitHubReleaseAsset = {
        name: asset.name,
        url: asset.browser_download_url,
        size: asset.size ?? 0,
      };
      if (asset.content_type) installer.contentType = asset.content_type;
      return installer;
    });
  return {
    tagName: release.tag_name,
    version,
    name: release.name,
    body: release.body,
    htmlUrl: release.html_url,
    publishedAt: release.published_at,
    prerelease: release.prerelease,
    assets,
    recommendedAsset: pickRecommendedAsset(assets),
  };
};

/** The newest release of github.com/qybaihe/mu, asked from GitHub's API; null when there is none. */
export const fetchLatestRelease = async (timeoutMs = REQUEST_TIMEOUT_MS): Promise<UpdateReleaseInfo | null> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(RELEASES_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new UpdateError(
        { code: 'serverError', status: res.status },
        `GitHub API request failed (${res.status}): ${RELEASES_API_URL}`
      );
    }

    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) {
      throw new UpdateError(
        { code: 'invalidMetadata' },
        `GitHub API response is not a release list: ${RELEASES_API_URL}`
      );
    }
    return latestRelease(json as GitHubReleaseApi[]);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new UpdateError({ code: 'timeout' }, `GitHub API request timed out after ${timeoutMs} ms`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};

/** Whether `candidate` is a strictly higher version than `current` (loose versions are coerced). */
export const isNewerVersion = (candidate: string, current: string): boolean => {
  const currentSemver = semver.valid(current) || semver.coerce(current)?.version;
  const candidateSemver = semver.valid(candidate) || semver.coerce(candidate)?.version;
  return Boolean(currentSemver && candidateSemver && semver.gt(candidateSemver, currentSemver));
};
