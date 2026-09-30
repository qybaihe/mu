const fs = require('fs');
const path = require('path');

/**
 * What the packaged app has to carry of mu (scripts/kyrn/bundle-harness.mjs puts it in resources/harness, which
 * electron-builder copies to <resources>/harness): the npm package mu-agent with the files the app starts and reads,
 * its dependencies installed, and a record of the platform and arch they were installed for. mu runs from there on
 * the app's own binary as Node, so nothing else provides it on the machine the app runs on.
 */
const HARNESS_FILES = [
  // The launcher the adapter and the sign-in start.
  'kyrn/bin/mu.mjs',
  // pi, the judgment layer, and `mu auth` (the subscription sign-in).
  'dist/bundle/cli.js',
  'judge/dist/kyrn-judge.js',
  'judge/dist/auth.js',
  'judge/dist/import.js',
  // What the settings draw their decision points and features from.
  'judge/manifest.json',
];

/** What the launcher exports for the app's native host to run pi in a process of its own. */
const NATIVE_HOST_EXPORTS = ['planHost', 'prepareLaunch'];

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Paths in the result are relative to the resources folder, with forward slashes, like the AionCore check's. */
function verifyBundledHarness({ resourcesDir, electronPlatformName, targetArch }) {
  const root = path.join(resourcesDir, 'harness');
  const checked = [];
  const missing = [];
  const need = (relativePath, ok) => {
    const shown = `harness/${relativePath}`;
    checked.push(shown);
    if (!ok) missing.push(shown);
  };
  const inPackage = (relativePath) => path.join(root, 'mu-agent', ...relativePath.split('/'));

  const manifest = readJson(inPackage('package.json'));
  need('mu-agent/package.json', manifest?.name === 'mu-agent');
  for (const file of HARNESS_FILES) need(`mu-agent/${file}`, isFile(inPackage(file)));
  for (const name of Object.keys(manifest?.dependencies ?? {})) {
    need(`mu-agent/node_modules/${name}/package.json`, isFile(inPackage(`node_modules/${name}/package.json`)));
  }

  // The native host (docs/native-host.md) starts pi with two functions of the launcher. A mu without them would not
  // fail: every conversation of the app would quietly stay on AionCore, so the build says so instead.
  const launcher = readText(inPackage('kyrn/bin/mu.mjs'));
  if (launcher !== null) {
    for (const name of NATIVE_HOST_EXPORTS) {
      if (!new RegExp(`export (?:async )?function ${name}\\b`).test(launcher))
        missing.push(`harness/mu-agent/kyrn/bin/mu.mjs<export:${name}>`);
    }
  }

  const bundle = readJson(path.join(root, 'bundle.json'));
  need('bundle.json', Boolean(bundle));
  if (bundle) {
    if (bundle.platform !== electronPlatformName) missing.push(`harness/bundle.json<platform:${electronPlatformName}>`);
    if (bundle.arch !== targetArch) missing.push(`harness/bundle.json<arch:${targetArch}>`);
    if (manifest && bundle.version !== manifest.version)
      missing.push(`harness/bundle.json<version:${manifest.version}>`);
  }
  return { version: manifest?.version, checked, missing };
}

module.exports = { verifyBundledHarness };
