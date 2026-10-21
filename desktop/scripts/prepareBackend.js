/**
 * CLI wrapper for prepare-backend.
 *
 * Reads environment variables and invokes the shared module.
 *
 * Version resolution order:
 *  1. MU_BACKEND_RUN_ID env (download from AionCore Manual Build artifact)
 *  2. MU_BACKEND_VERSION env (for ad-hoc release overrides)
 *  3. "backendVersion" field in repo-root package.json (the pin)
 *  4. 'latest' (fallback; not recommended for reproducible builds)
 *
 * Environment variables:
 *  - MU_BACKEND_RUN_ID: AionCore Manual Build workflow run id
 *  - MU_BACKEND_VERSION: override the pinned version
 *  - MU_BACKEND_ARCH: target architecture (default: process.arch)
 *  - GH_TOKEN / GITHUB_TOKEN: GitHub API token (for rate limiting)
 */

const path = require('path');
const { prepareBackend } = require('../packages/shared-scripts/src/prepare-backend.js');
const { resolveBackendVersion } = require('./resolveBackendVersion.js');

const projectRoot = path.resolve(__dirname, '..');
const platform = process.platform;
// Support cross-compilation: MU_BACKEND_ARCH > npm_config_target_arch > process.arch
const arch = process.env.MU_BACKEND_ARCH || process.env.npm_config_target_arch || process.arch;
const version = resolveBackendVersion(projectRoot);

try {
  prepareBackend({ projectRoot, platform, arch, version });
} catch (error) {
  console.error('❌ prepareBackend failed:', error.message);
  process.exit(1);
}

module.exports = function () {
  try {
    return prepareBackend({ projectRoot, platform, arch, version });
  } catch (error) {
    console.error('❌ prepareBackend failed:', error.message);
    throw error;
  }
};
