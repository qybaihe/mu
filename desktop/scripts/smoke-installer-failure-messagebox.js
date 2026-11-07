#!/usr/bin/env node

const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

const INSTALLER_ERROR_SCENARIOS = [
  {
    id: 'uninstaller-copy-or-rebuild-failed',
    defineName: 'MU_E_UNINSTALLER_COPY_OR_REBUILD_FAILED',
    code: 'E1001',
    message: 'mu could not repair the installed uninstaller.',
    action: 'Close mu, restart Windows if needed, then run this installer again.',
    diagnostics:
      'scenario=uninstaller-copy-or-rebuild-failed phase=uninstaller-repair result=copy-failed-retry-bundled-missing',
  },
  {
    id: 'old-uninstall-failed',
    defineName: 'MU_E_OLD_UNINSTALL_FAILED',
    code: 'E1002',
    message: 'The previous mu uninstaller returned an error.',
    action:
      'Close any program using the install folder, then run this installer again. If no program is listed, restart Windows and run this installer again.',
    diagnostics: 'scenario=old-uninstall-failed phase=old-uninstaller exitCode=2',
  },
  {
    id: 'install-dir-remove-or-locked',
    defineName: 'MU_E_INSTALL_DIR_REMOVE_OR_LOCKED',
    code: 'E1003',
    message: 'mu could not remove or replace the previous installation directory.',
    action: 'Close mu and any program using the install folder, then run this installer again.',
    diagnostics: 'scenario=install-dir-remove-or-locked phase=atomic-failed failedPath=install-dir',
  },
  {
    id: 'extract-failed',
    defineName: 'MU_E_EXTRACT_FAILED',
    code: 'E1010',
    message: 'mu could not extract the application files correctly.',
    action: 'Download a fresh installer and run it again.',
    diagnostics: 'scenario=extract-failed phase=extract method=zip missing=mu.exe',
  },
  {
    id: 'disk-insufficient',
    defineName: 'MU_E_DISK_INSUFFICIENT',
    code: 'E1020',
    message: 'mu cannot continue because the target disk does not have enough free space.',
    action: 'Free disk space on the target drive, then run this installer again.',
    diagnostics: 'scenario=disk-insufficient phase=preflight requiredMb=1024 availableMb=0',
  },
  {
    id: 'bundled-backend-incomplete',
    defineName: 'MU_E_BUNDLED_BACKEND_INCOMPLETE',
    code: 'E1030',
    message: 'mu installed, but the bundled local service resources are incomplete.',
    action: 'Download a fresh installer and run it again.',
    diagnostics: 'scenario=bundled-backend-incomplete phase=verify-bundled-backend runtime=win32-x64 result=1',
  },
  {
    id: 'core-app-files-incomplete',
    defineName: 'MU_E_CORE_APP_FILES_INCOMPLETE',
    code: 'E1031',
    message: 'mu installation is incomplete because a required application file is missing.',
    action: 'Reinstall mu or download a newer installer.',
    diagnostics: 'scenario=core-app-files-incomplete phase=verify-required-file missing=resources/app.asar',
  },
  {
    id: 'arch-mismatch',
    defineName: 'MU_E_ARCH_MISMATCH',
    code: 'E1040',
    message: 'Installation package architecture mismatch.',
    action: 'Download the mu installer that matches this Windows architecture, then run it again.',
    diagnostics: 'scenario=arch-mismatch phase=arch-check target=x64 actual=arm64',
  },
  {
    id: 'active-installer-conflict',
    defineName: 'MU_E_ACTIVE_INSTALLER_CONFLICT',
    code: 'E1050',
    message: 'Another mu installer appears to still be active.',
    action: 'Close the other installer window or wait for it to finish, then run this installer again.',
    diagnostics: 'scenario=active-installer-conflict phase=active-installer-marker state=active',
  },
  {
    id: 'registry-state-invalid',
    defineName: 'MU_E_REGISTRY_STATE_INVALID',
    code: 'E1060',
    message: 'mu found an invalid previous-install registry state.',
    action: 'Uninstall the old mu from Windows Settings, then run this installer again.',
    diagnostics: 'scenario=registry-state-invalid phase=registry-heal installLocation=invalid uninstallString=missing',
  },
  {
    id: 'active-marker-write-failed',
    defineName: 'MU_E_ACTIVE_MARKER_WRITE_FAILED',
    code: 'E1070',
    message: 'mu could not write the active-installer marker.',
    action: 'Restart Windows, then run this installer again.',
    diagnostics: 'scenario=active-marker-write-failed phase=active-installer-marker-write result=failed',
  },
  {
    id: 'invalid-install-path',
    defineName: 'MU_E_INVALID_INSTALL_PATH',
    code: 'E1090',
    message: 'The selected install path is invalid.',
    action: 'Choose a local install path that is writable, then run this installer again.',
    diagnostics: 'scenario=invalid-install-path phase=path-validation installPath=invalid',
  },
];

function nsisQuote(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '$\\"').replace(/\$/g, '$$');
}

function findMakensis() {
  if (process.env.MAKENSIS && existsSync(process.env.MAKENSIS)) {
    return process.env.MAKENSIS;
  }

  const localAppData = process.env.LOCALAPPDATA;
  const cacheRoot = localAppData ? path.join(localAppData, 'electron-builder', 'Cache') : '';
  const candidates = [];

  function walk(dir, depth = 0) {
    if (!dir || depth > 5 || !existsSync(dir)) {
      return;
    }

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase() === 'makensis.exe') {
        candidates.push(full);
      }
    }
  }

  walk(cacheRoot);
  candidates.sort((a, b) => b.localeCompare(a));

  if (candidates[0]) {
    return candidates[0];
  }

  const fromPath = spawnSync('where.exe', ['makensis.exe'], { encoding: 'utf8' });
  if (fromPath.status === 0) {
    const first = fromPath.stdout.split(/\r?\n/).find(Boolean);
    if (first && existsSync(first)) {
      return first;
    }
  }

  throw new Error('makensis.exe not found. Run a Windows build once or set MAKENSIS=C:\\path\\to\\makensis.exe');
}

function copyHarnessProject(projectRoot) {
  const windowsDir = path.join(projectRoot, 'resources', 'windows');
  mkdirSync(windowsDir, { recursive: true });

  for (const file of ['installer-observability.nsh', 'installer-errors.nsh', 'installer-messages.nsh']) {
    copyFileSync(path.join(repoRoot, 'resources', 'windows', file), path.join(windowsDir, file));
  }
}

function getArg(name, fallback) {
  const prefix = `${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function readInstallerErrorDefinitions() {
  const source = readFileSync(path.join(repoRoot, 'resources', 'windows', 'installer-errors.nsh'), 'utf8');
  const definitions = Array.from(source.matchAll(/!define\s+(MU_E_[A-Z0-9_]+)\s+"(E\d{4})"/g), (match) => ({
    defineName: match[1],
    code: match[2],
  }));
  if (definitions.length === 0) {
    throw new Error('No MU_E_* installer error codes found.');
  }
  return definitions;
}

function getInstallerErrorScenarioMatrix() {
  const definitions = readInstallerErrorDefinitions();
  const codes = definitions.map((definition) => definition.code);
  const defineNames = definitions.map((definition) => definition.defineName);
  const scenarioCodes = INSTALLER_ERROR_SCENARIOS.map((scenario) => scenario.code);
  const scenarioDefineNames = INSTALLER_ERROR_SCENARIOS.map((scenario) => scenario.defineName);
  const scenarioIds = INSTALLER_ERROR_SCENARIOS.map((scenario) => scenario.id);

  if (definitions.length !== 12) {
    throw new Error(`Expected 12 installer error code definitions, found ${definitions.length}: ${codes.join(', ')}`);
  }
  if (new Set(codes).size !== definitions.length) {
    throw new Error(`Duplicate installer error codes in NSIS definitions: ${codes.join(', ')}`);
  }
  if (new Set(defineNames).size !== definitions.length) {
    throw new Error(`Duplicate installer error define names in NSIS definitions: ${defineNames.join(', ')}`);
  }
  if (INSTALLER_ERROR_SCENARIOS.length !== definitions.length) {
    throw new Error(
      `Expected ${definitions.length} installer error scenarios, found ${INSTALLER_ERROR_SCENARIOS.length}`
    );
  }
  if (new Set(scenarioIds).size !== INSTALLER_ERROR_SCENARIOS.length) {
    throw new Error(`Duplicate installer error scenario ids: ${scenarioIds.join(', ')}`);
  }
  if (new Set(scenarioCodes).size !== INSTALLER_ERROR_SCENARIOS.length) {
    throw new Error(`Duplicate installer error scenario codes: ${scenarioCodes.join(', ')}`);
  }

  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index];
    const scenario = INSTALLER_ERROR_SCENARIOS[index];
    if (scenario.defineName !== definition.defineName || scenario.code !== definition.code) {
      throw new Error(
        `Installer error scenario ${index + 1} does not match NSIS definition: expected ${definition.defineName}=${definition.code}, got ${scenario.defineName}=${scenario.code}`
      );
    }
  }

  return { definitions, scenarios: INSTALLER_ERROR_SCENARIOS };
}

function findInstallerErrorScenario(code) {
  const { scenarios } = getInstallerErrorScenarioMatrix();
  const scenario = scenarios.find((entry) => entry.code === code);
  if (!scenario) {
    throw new Error(`Unknown installer error code: ${code}`);
  }
  return scenario;
}

function writeAutoCloseScript(scriptPath) {
  writeFileSync(
    scriptPath,
    `
param(
  [string]$ExePath,
  [string]$Code,
  [string]$ScenarioId,
  [string]$LogPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Get-WindowText([System.Windows.Automation.AutomationElement]$Window) {
  $texts = New-Object System.Collections.Generic.List[string]
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($Window)
  while ($queue.Count -gt 0) {
    $item = [System.Windows.Automation.AutomationElement]$queue.Dequeue()
    $name = $item.Current.Name
    if ($name -and -not $texts.Contains($name)) { $texts.Add($name) }
    $child = $walker.GetFirstChild($item)
    while ($child) {
      $queue.Enqueue($child)
      $child = $walker.GetNextSibling($child)
    }
  }
  return ($texts -join "\`n")
}

function Try-ClickWindowButton([System.Windows.Automation.AutomationElement]$Window, [string[]]$ButtonNames) {
  $buttonCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )
  $buttons = $Window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCond)
  foreach ($button in $buttons) {
    foreach ($name in $ButtonNames) {
      if ($button.Current.Name -eq $name -or $button.Current.Name -like "*$name*") {
        if (-not $button.Current.IsEnabled) { continue }
        $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke()
        return $true
      }
    }
  }
  return $false
}

function Find-FailureWindow([string]$Code, [int]$TimeoutSec = 90) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $windowCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Window
  )

  do {
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $windowCond)
    foreach ($window in $windows) {
      $text = Get-WindowText $window
      if ($text -like "*mu installation failed ($Code)*") {
        return [ordered]@{ window = $window; text = $text; title = $window.Current.Name }
      }
    }
    Start-Sleep -Milliseconds 300
  } while ((Get-Date) -lt $deadline)

  throw "Failure window not found for $Code"
}

$proc = Start-Process -FilePath $ExePath -PassThru
try {
  $failure = Find-FailureWindow $Code
  foreach ($required in @(
    "mu installation failed ($Code)",
    "scenario=$ScenarioId",
    'Suggested action:',
    'Diagnostics:',
    'Installer log:'
  )) {
    if ($failure.text -notlike "*$required*") {
      throw "Failure dialog for $Code is missing: $required"
    }
  }
  $logFileName = Split-Path -Leaf $LogPath
  if ($failure.text -notlike "*$LogPath*" -and $failure.text -notlike "*$logFileName*") {
    throw "Failure dialog for $Code does not include the installer log file name."
  }
  if ($failure.text -like '*Blocking diagnostics:*') {
    throw "Failure dialog for $Code still uses the old Blocking diagnostics label."
  }
  $okZh = [string][char]30830 + [string][char]23450
  $buttons = @('OK', $okZh)
  if (-not (Try-ClickWindowButton $failure.window $buttons)) {
    throw "OK button not found for $Code failure dialog."
  }

  if (-not $proc.WaitForExit(60000)) {
    throw "Harness did not exit after closing the failure dialog for $Code."
  }
  if ($proc.ExitCode -ne 2) {
    throw "Harness exited with $($proc.ExitCode) for $Code; expected 2."
  }

  [pscustomobject]@{ code = $Code; exitCode = $proc.ExitCode; title = $failure.title; logPath = $LogPath } |
    ConvertTo-Json -Compress
} finally {
  if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  }
}
`,
    'utf8'
  );
}

function createHarnessNsi({ exePath, logPath, projectRoot, scenario }) {
  const detail = `${scenario.diagnostics} smoke=messagebox`;
  return `
Unicode true
Name "mu Failure MessageBox Smoke"
OutFile "${nsisQuote(exePath)}"
RequestExecutionLevel user
SilentInstall normal
!define PROJECT_DIR "${nsisQuote(projectRoot)}"
!define VERSION "0.0.0-smoke"
!define MU_TARGET_ARCH "x64"
!define MU_RUNTIME_KEY "win32-x64"
!include LogicLib.nsh
!include nsDialogs.nsh
!include "${nsisQuote(path.join(projectRoot, 'resources', 'windows', 'installer-observability.nsh'))}"
!macro MU_CLEAR_ACTIVE_INSTALLER_MARKER
!macroend
!include "${nsisQuote(path.join(projectRoot, 'resources', 'windows', 'installer-errors.nsh'))}"

Section
  StrCpy $INSTDIR "$TEMP\\mu-messagebox-smoke"
  StrCpy $MuSessionId "smokembox-${nsisQuote(scenario.code)}"
  StrCpy $MuIsUpdated "1"
  StrCpy $MuSessionLogPath "${nsisQuote(logPath)}"
  BringToFront
  !insertmacro MU_FAIL_UX \
    "${nsisQuote(scenario.code)}" \
    "${nsisQuote(detail)}" \
    "${nsisQuote(scenario.message)}" \
    "${nsisQuote(scenario.message)}" \
    "${nsisQuote(scenario.action)}" \
    "${nsisQuote(scenario.action)}" \
    "${nsisQuote(detail)}" \
    "${nsisQuote(detail)}"
SectionEnd
`;
}

function verifyFailureLog(logPath, scenario) {
  const { code, id } = scenario;
  if (!existsSync(logPath)) {
    throw new Error(`installer log was not written for ${code}: ${logPath}`);
  }

  const events = readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line.replace(/^\uFEFF/, '')));
  const hasSessionFailure = events.some(
    (event) =>
      event.event === 'session-end' &&
      typeof event.message === 'string' &&
      event.message.includes(`code=${code}`) &&
      event.message.includes(`scenario=${id}`)
  );

  if (!hasSessionFailure) {
    throw new Error(`session-end failure event missing code or scenario id for ${code} (${id}): ${logPath}`);
  }
}

function runHarness({ autoClose, compileOnly, makensis, scenario }) {
  const { code } = scenario;
  const root = mkdtempSync(path.join(tmpdir(), `mu-failure-messagebox-${code}-`));
  const projectRoot = path.join(root, 'project');
  const nsiPath = path.join(root, 'mu-failure-messagebox-smoke.nsi');
  const exePath = path.join(root, 'mu-failure-messagebox-smoke.exe');
  const logPath = path.join(
    process.env.TEMP || tmpdir(),
    `mu-installer-messagebox-smoke-${code}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')}-log.jsonl`
  );
  const automationPath = path.join(root, 'auto-close.ps1');

  copyHarnessProject(projectRoot);
  writeAutoCloseScript(automationPath);
  writeFileSync(nsiPath, createHarnessNsi({ exePath, logPath, projectRoot, scenario }), 'utf8');

  try {
    console.log(`[failure-messagebox] ${code}: compiling harness...`);
    const compile = spawnSync(makensis, [nsiPath], { encoding: 'utf8' });
    if (compile.status !== 0) {
      process.stdout.write(compile.stdout || '');
      process.stderr.write(compile.stderr || '');
      throw new Error(`makensis failed with exit ${compile.status}`);
    }

    if (compileOnly) {
      console.log(`[failure-messagebox] ${code}: compile-only ok: ${exePath}`);
      return { code, exePath, logPath, mode: 'compile-only' };
    }

    if (autoClose) {
      console.log(`[failure-messagebox] ${code}: launching harness and closing the failure dialog...`);
      const run = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', automationPath, exePath, code, scenario.id, logPath],
        { encoding: 'utf8' }
      );
      if (run.status !== 0) {
        process.stdout.write(run.stdout || '');
        process.stderr.write(run.stderr || '');
        throw new Error(`auto-close harness failed for ${code} with exit ${run.status}`);
      }
      verifyFailureLog(logPath, scenario);
      console.log(`[failure-messagebox] ${code}: e2e ok: ${logPath}`);
      return { code, exePath, logPath, mode: 'auto' };
    }

    console.log('[failure-messagebox] launching harness. Click OK to close the failure dialog.');
    const run = spawnSync(exePath, [], { stdio: 'inherit' });
    if (run.status !== 2) {
      throw new Error(`harness exited with ${run.status}; expected installer failure exit code 2`);
    }
    verifyFailureLog(logPath, scenario);
    return { code, exePath, logPath, mode: 'manual' };
  } finally {
    if (compileOnly || autoClose || process.argv.includes('--cleanup')) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function main() {
  if (process.argv.includes('--list-codes-json')) {
    const { definitions, scenarios } = getInstallerErrorScenarioMatrix();
    console.log(
      JSON.stringify({
        codes: definitions.map((definition) => definition.code),
        scenarios: scenarios.map(({ id, defineName, code, message, action, diagnostics }) => ({
          id,
          defineName,
          code,
          message,
          action,
          diagnostics,
        })),
      })
    );
    return;
  }

  if (process.platform !== 'win32') {
    throw new Error('This smoke test only runs on Windows.');
  }

  const allScenarios = process.argv.includes('--all-scenarios') || process.argv.includes('--all-codes');
  const autoClose = process.argv.includes('--auto');
  const compileOnly = process.argv.includes('--compile-only');
  const { scenarios } = getInstallerErrorScenarioMatrix();
  const selectedScenarios = allScenarios ? scenarios : [findInstallerErrorScenario(getArg('--code', 'E1003'))];
  const makensis = findMakensis();
  const results = [];

  console.log(`[failure-messagebox] makensis: ${makensis}`);
  for (const scenario of selectedScenarios) {
    results.push(
      runHarness({
        autoClose,
        compileOnly,
        makensis,
        scenario,
      })
    );
  }

  if (allScenarios) {
    console.log(
      JSON.stringify(
        {
          coveredCodes: results.map((result) => result.code),
          coveredScenarios: selectedScenarios.map((scenario) => scenario.id),
          count: results.length,
          mode: compileOnly ? 'compile-only' : autoClose ? 'auto' : 'manual',
        },
        null,
        2
      )
    );
  }
}

try {
  main();
} catch (err) {
  console.error(`[failure-messagebox] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
