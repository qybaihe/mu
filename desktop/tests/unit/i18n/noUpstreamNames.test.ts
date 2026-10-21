import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGUAGES } from '@/common/config/i18n';

/**
 * mu is its own app: neither what it shows nor its code and docs name the products the desktop app began from. Text
 * that arrives at run time from the bundled backend is rewritten by `showAsMu` (tests/unit/kyrn/displayName.test.ts).
 * These tests keep the app's own copy clean, and the repository: an upstream name is left only where something outside
 * mu's code reads or writes it, or where the license requires it (docs/contributing/upstream-names.md).
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const monorepoRoot = join(repoRoot, '..');
const localeRoot = join(repoRoot, 'packages/desktop/src/renderer/services/i18n/locales');
const AION = /aion/i;

/** Every string in a locale file, with its key path. Keys are identifiers (`builtinAgentNoProvider`) and stay. */
function localeValues(node: unknown, path = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[path, node]];
  if (Array.isArray(node)) return node.flatMap((item, index) => localeValues(item, `${path}[${index}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, item]) => localeValues(item, path ? `${path}.${key}` : key));
  }
  return [];
}

/**
 * The main-process files that build what the operating system shows: the window, the tray and its menu, the app
 * menu and its About panel, notifications, native dialogs, the app name, the startup-failure and quit paths.
 */
const MAIN_PROCESS_FILES = [
  'packages/desktop/src/index.ts',
  'packages/desktop/src/common/platform/index.ts',
  'packages/desktop/src/common/platform/ElectronPlatformServices.ts',
  'packages/desktop/src/process/bridge/applicationBridgeCore.ts',
  'packages/desktop/src/process/bridge/dialogBridge.ts',
  'packages/desktop/src/process/bridge/notificationBridge.ts',
  'packages/desktop/src/process/services/i18n/index.ts',
  'packages/desktop/src/process/startup/backendStartupFailure.ts',
  'packages/desktop/src/process/startup/quitCleanup.ts',
  'packages/desktop/src/process/startup/recoverCorruptedDatabase.ts',
  'packages/desktop/src/process/startup/windowsAppUserModelId.ts',
  'packages/desktop/src/process/utils/appMenu.ts',
  'packages/desktop/src/process/utils/configureChromium.ts',
  'packages/desktop/src/process/utils/mainWindowLifecycle.ts',
  'packages/desktop/src/process/utils/tray.ts',
];

/**
 * Identifiers that keep an upstream name because data, the backend or older installs depend on them. The names
 * already on people's machines live in common/platform/legacyNames.ts and the backend's in
 * common/platform/backendNames.ts; these files only use them by their constants.
 */
const COMPATIBILITY_IDS = new Map<string, string>();

const TEXT_FILE =
  /\.(?:[cm]?[jt]sx?|json|md|css|html|ya?ml|sh|ps1|nsh|cmd|toml|txt)$|(?:^|\/)(?:\.gitignore|NOTICE|LICENSE[\w-]*|Makefile|justfile|start|acp)$/;
const LOCK_FILE = /(?:^|\/)(?:bun\.lock|package-lock\.json|pnpm-lock\.yaml)$/;
/** Release notes and changelogs record what was true then. */
const HISTORY = /(?:^|\/)CHANGELOG[\w.-]*\.md$/;
const README = /(?:^|\/)README(?:\.[\w-]+)?\.md$/;
/** The one line a README gives the fork's origin: the desktop app began as AionUi, whose files keep its license. */
const CREDIT = /\[AionUi\]\(https:\/\/github\.com\/iOfficeAI\/AionUi\)/;

/**
 * Names the backend or the extensions read and write, which mu speaks but cannot rename: its environment variables and
 * error codes, its stdout markers, the markers it puts in messages, its binary and file names, its cookie and header,
 * the extension manifest and messages, the hub it serves extensions from, its config skill and folders, the folder of
 * its source checkout, and the license header of files that came from AionUi. Also AionLabs, a model maker.
 */
const WIRE_NAMES: RegExp[] = [
  /Copyright 20\d\d AionUi \(aionui\.com\)/g,
  /\bAIONUI_[\w{},…]*/g,
  /\bAIONCORE_(?:READY|LISTENING)\b/g,
  /\[\[\/?AION_\w+\]\]/g,
  /\baioncore(?:\.exe|\.bin)?\b/g,
  /iOfficeAI\/Aion(?:Core|Hub|Ui)\b/g,
  /\baionui-(?:backend\.db|session|assistant)\b/g,
  /\bx-aionui-internal\b/g,
  /_aionui_/g,
  /\baion:[\w-]+/g,
  /\baion-extension(?:-v1)?\.json\b/g,
  /\bengines\.aionui\b/g,
  /\.aionrs\//g,
  /\baion-labs\/aion-[\w.-]+/g,
  /\bAION_[A-Z_]+\b/g,
  /\.?aionui-config(?:-dev)?(?:\.txt)?/g,
  /\.\.\/aionCore\/[\w./-]+/g,
  // What an older version or installer left: the skills folder it injected, the installer's marker and variables.
  /\baionui-skills\b/g,
  /\baionui-installer-active\.marker\b/g,
  /\$AionUiSession\w+/g,
  /\bAionLabs\b(?::\s*Aion [\d.]+(?: Mini)?)?/g,
  /\bAion-[\d.]+(?:-Mini)?\b/g,
];

/**
 * Files that keep upstream names whole, each for its reason (docs/contributing/upstream-names.md says which).
 * Paths are from the repository's root.
 */
const UPSTREAM_FILES = new Map<string, string>([
  ['desktop/NOTICE', 'the license: where the files came from'],
  ['desktop/LICENSE', 'the license: which files are not under it'],
  ['desktop/LICENSE-APACHE', 'the license the files that came from AionUi keep'],
  ['desktop/APACHE-FILES.txt', 'the list of files that came from AionUi'],
  ['desktop/scripts/apacheFiles.mjs', "makes that list from AionUi's sources"],
  ['desktop/kyrn/THIRD_PARTY_NOTICES.md', 'the license of the adapted code editor'],
  ['desktop/docs/contributing/upstream-names.md', 'the record of what keeps an upstream name and why'],
  ['desktop/packages/desktop/src/common/platform/backendNames.ts', "the backend's names, spoken only there"],
  ['desktop/packages/desktop/src/common/platform/legacyNames.ts', "what earlier versions left on people's machines"],
  ['desktop/packages/desktop/src/process/services/database/migrations.ts', 'reads what the first versions wrote'],
  [
    'desktop/packages/desktop/src/common/kyrn/displayName.ts',
    'rewrites upstream names in text that arrives at run time',
  ],
  ['desktop/packages/shared-scripts/src/prepare-backend.js', 'downloads the backend from its repository'],
  ['desktop/tests/unit/i18n/noUpstreamNames.test.ts', 'this test'],
  ['desktop/tests/unit/kyrn/displayName.test.ts', 'tests the rewriting'],
  ['desktop/tests/unit/common-config/legacyNames.dom.test.ts', 'tests the moves from the old names'],
  ['desktop/tests/unit/theme/customCssProcessor.test.ts', 'tests the old class names in a stored theme'],
  ['desktop/tests/unit/settings/backgroundUtils.test.ts', 'tests the old background markers in a stored theme'],
  ['desktop/examples/hello-world-extension/aion-extension.json', 'an extension manifest names the app it runs in'],
  ['.github/workflows/desktop.yml', "adapted from AionUi's build pipeline (Apache License 2.0)"],
  // Text the backend sends at run time, which the app shows as mu's: these tests give it the upstream names.
  ['desktop/tests/unit/common-adapter/httpBridge.test.ts', "upstream names in the backend's errors"],
  ['desktop/tests/unit/common-adapter/ipcBridgeConversation.test.ts', "upstream names in the backend's assistants"],
  ['desktop/tests/unit/common/chatLib.test.ts', "upstream names in the backend's errors"],
  ['desktop/tests/unit/feedback/MessageTipsFeedback.dom.test.tsx', "upstream names in the backend's tips"],
  ['desktop/tests/unit/renderer/usePresetAssistantInfo.dom.test.ts', 'upstream names in stored assistants'],
  ['desktop/tests/unit/renderer/utils/conversationAssistantIdentity.test.ts', 'upstream names in stored assistants'],
  ['packages/kyrn-judge/test/extension.test.ts', 'the rules the backend puts before a first message'],
  ['packages/kyrn-judge/test/frame-feature.test.ts', 'the rules the backend puts before a first message'],
]);

/** Log lines go to the log file, not to the screen: what they say is not checked here (they are tagged `[mu]`). */
function isLogCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression.getText();
  return /^console\.\w+$/.test(callee) || /(^|\.)log(Info|Warn|Error|Debug)?$/.test(callee);
}

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (!ts.isCallExpression(parent)) return false;
  return (
    parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(parent.expression) && parent.expression.text === 'require')
  );
}

/** Each string literal and template piece of a file that says "aion", except in log calls, imports and types. */
function aionLiterals(file: string): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(file, readFileSync(join(repoRoot, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node, inLog: boolean): void => {
    if (ts.isLiteralTypeNode(node)) return;
    const logged = inLog || isLogCall(node);
    const isText =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node);
    if (isText && !logged && !isModuleSpecifier(node) && AION.test(node.text)) {
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: node.text });
    }
    ts.forEachChild(node, (child) => visit(child, logged));
  };
  visit(source, false);
  return found;
}

describe('no upstream names in what mu shows', () => {
  it('has none in any locale value, in each of the 13 languages', () => {
    const languages = readdirSync(localeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
    expect(languages).toEqual([...SUPPORTED_LANGUAGES].toSorted());
    expect(languages).toHaveLength(13);

    const offenders: string[] = [];
    let checked = 0;
    for (const language of languages) {
      const files = readdirSync(join(localeRoot, language)).filter((name) => name.endsWith('.json'));
      for (const file of files) {
        const parsed: unknown = JSON.parse(readFileSync(join(localeRoot, language, file), 'utf8'));
        for (const [key, value] of localeValues(parsed)) {
          checked++;
          if (AION.test(value)) offenders.push(`${language}/${file} ${key}: ${value}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(13 * 1000);
    expect(offenders).toEqual([]);
  });

  it('has none in the strings of the main-process files that build windows, the tray, menus, notifications and dialogs', () => {
    const offenders: string[] = [];
    const used = new Set<string>();
    for (const file of MAIN_PROCESS_FILES) {
      expect(existsSync(join(repoRoot, file)), `${file} moved: update MAIN_PROCESS_FILES`).toBe(true);
      for (const { line, text } of aionLiterals(file)) {
        if (COMPATIBILITY_IDS.has(text)) used.add(text);
        else offenders.push(`${file}:${line} ${JSON.stringify(text)}`);
      }
    }
    expect(offenders).toEqual([]);
    // An identifier nobody uses any more leaves the list, so the list stays a record of what is really kept.
    expect([...COMPATIBILITY_IDS.keys()].filter((id) => !used.has(id))).toEqual([]);
  });

  it('has none in the repository, outside the files and names that must keep them', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: monorepoRoot, encoding: 'utf8', maxBuffer: 1 << 26 })
      .split('\0')
      .filter(Boolean);
    const offenders: string[] = [];
    const readmeCredits = new Map<string, number>();
    const usedFiles = new Set<string>();
    for (const file of files) {
      if (!TEXT_FILE.test(file) || LOCK_FILE.test(file) || !existsSync(join(monorepoRoot, file))) continue;
      const allowed = UPSTREAM_FILES.has(file) || HISTORY.test(file);
      const lines = readFileSync(join(monorepoRoot, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!AION.test(line)) return;
        if (allowed) {
          usedFiles.add(file);
          return;
        }
        if (README.test(file) && CREDIT.test(line)) {
          readmeCredits.set(file, (readmeCredits.get(file) ?? 0) + 1);
          return;
        }
        const rest = WIRE_NAMES.reduce((text, name) => text.replace(name, ''), line);
        if (AION.test(rest)) offenders.push(`${file}:${index + 1} ${line.trim().slice(0, 160)}`);
      });
    }
    expect(offenders).toEqual([]);
    // Each README credits AionUi in one line, and only there.
    expect([...readmeCredits].filter(([, count]) => count !== 1)).toEqual([]);
    expect(readmeCredits.size).toBeGreaterThanOrEqual(1);
    // A file that no longer names them leaves the list, so the list stays a record of what is really kept.
    expect([...UPSTREAM_FILES.keys()].filter((file) => !usedFiles.has(file))).toEqual([]);
  });
});
