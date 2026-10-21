import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGUAGES } from '@/common/config/i18n';

/**
 * mu is its own app: no text it shows names AionUi, AionCore, BuiltinAgent or Aion CLI. Text that arrives at run time
 * from the bundled backend is rewritten by `showAsMu` (tests/unit/kyrn/displayName.test.ts); these tests keep the
 * app's own copy clean, so the rewriter has nothing to do for it.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
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
 * Identifiers that keep an upstream name because data, the local service or older installs depend on them. The
 * names already on people's machines live in common/platform/legacyNames.ts and AionCore's in
 * common/platform/backendNames.ts; these files only use them by their constants.
 */
const COMPATIBILITY_IDS = new Map<string, string>([['bundled-aioncore/', 'the folder the local service ships in']]);

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

describe('no Aion words in what mu shows', () => {
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
});
