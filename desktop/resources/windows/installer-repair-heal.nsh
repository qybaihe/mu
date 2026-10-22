!ifndef MU_INSTALLER_REPAIR_HEAL_NSH
!define MU_INSTALLER_REPAIR_HEAL_NSH

Var /GLOBAL MuRegistryInstallIsValid
Var /GLOBAL MuInnerFailureSummary
Var /GLOBAL MuInnerRootCode
Var /GLOBAL MuInnerFailureReadResult

!macro MU_READ_LAST_INNER_FAILURE
  InitPluginsDir
  StrCpy $MuInnerRootCode ""
  StrCpy $MuInnerFailureSummary "No specific locking process was identified. Close mu, terminals, editors, and file managers opened in the install folder."
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
    $$ErrorActionPreference = 'SilentlyContinue'; \
    $$logPath = '$MuSessionLogPath'; \
    $$summary = 'No specific locking process was identified. Close mu, terminals, editors, and file managers opened in the install folder.'; \
    $$code = ''; \
    if ($$logPath -and (Test-Path -LiteralPath $$logPath)) { \
      $$events = @(Get-Content -LiteralPath $$logPath -ErrorAction SilentlyContinue | ForEach-Object { try { $$_ | ConvertFrom-Json } catch { $$null } } | Where-Object { $$_ }); \
      $$failure = @($$events | Where-Object { $$_.event -eq 'failure' -and $$_.updated -eq $$true } | Select-Object -Last 1)[0]; \
      if (-not $$failure) { $$failure = @($$events | Where-Object { $$_.event -eq 'failure' } | Select-Object -Last 1)[0] }; \
      if ($$failure) { \
        $$code = ([string]$$failure.code).Trim(); \
        $$phase = ([string]$$failure.phase).Trim(); \
        $$path = ([string]$$failure.failedPath).Trim(); \
        $$blocking = ''; \
        $$processes = @($$failure.blockingProcesses); \
        if ($$processes.Count -gt 0) { $$blocking = (@($$processes | ForEach-Object { if ($$_.pid) { [string]$$_.name + '(' + [string]$$_.pid + ')' } else { [string]$$_.name } }) -join ', ') }; \
        if (-not $$blocking) { $$blocking = ([string]$$failure.message).Trim() }; \
        if (-not $$blocking) { $$blocking = 'Windows did not identify a specific locking process. Close terminals, editors, and file managers opened in the install folder.' }; \
        $$parts = @('- Outer installer: previous uninstaller exited with code $R0', ('- Inner failure: ' + $$code + ' phase ' + $$phase)); \
        if ($$path) { $$parts += ('- File or folder: ' + $$path) }; \
        $$parts += ('- Blocking process: ' + $$blocking); \
        $$summary = $$parts -join [Environment]::NewLine; \
      } \
    }; \
    if (-not $$code) { $$code = '-----' }; \
    [Console]::Out.Write($$code + '|' + $$summary) \
  }"`
  Pop $MuInnerFailureReadResult
  Pop $MuInnerFailureReadResult
  StrCpy $MuInnerRootCode $MuInnerFailureReadResult 5
  ${If} $MuInnerRootCode == "-----"
    StrCpy $MuInnerRootCode ""
  ${EndIf}
  StrCpy $MuInnerFailureSummary $MuInnerFailureReadResult 4096 6
!macroend

!macro MU_LOG_UNINSTALLER_REPAIR _PHASE
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
    $$ErrorActionPreference = 'SilentlyContinue'; \
    $$log = '$MuSessionLogPath'; \
    if (-not $$log) { $$log = Join-Path $$env:TEMP '${MU_FALLBACK_LOG}' }; \
    $$path = '$INSTDIR\${UNINSTALL_FILENAME}'; \
    $$item = Get-Item -LiteralPath $$path -ErrorAction SilentlyContinue; \
    $$version = if ($$item) { $$item.VersionInfo.ProductVersion } else { '' }; \
    $$length = if ($$item) { $$item.Length } else { '' }; \
    $$payload = [ordered]@{ schemaVersion = 1; ts = (Get-Date -Format o); session = '$MuSessionId'; version = '${VERSION}'; arch = '${MU_TARGET_ARCH}'; updated = ('$MuIsUpdated' -eq '1'); instDir = '$INSTDIR'; event = 'uninstaller-repair'; phase = '${_PHASE}'; path = $$path; exists = [bool]$$item; productVersion = $$version; length = $$length }; \
    Add-Content -LiteralPath $$log -Encoding UTF8 -Value ($$payload | ConvertTo-Json -Compress -Depth 8) \
  }"`
  Pop $MuRepairLogResult
!macroend

!macro MU_REPAIR_INSTALLED_UNINSTALLER
  Var /GLOBAL MuInstalledUninstaller
  Var /GLOBAL MuBundledUninstaller
  Var /GLOBAL MuRepairLogResult

  !insertmacro MU_LOG_UNINSTALLER_REPAIR "before"
  StrCpy $MuInstalledUninstaller "$INSTDIR\${UNINSTALL_FILENAME}"

  InitPluginsDir
  StrCpy $MuBundledUninstaller "$PLUGINSDIR\mu-fixed-uninstaller.exe"
  SetOverwrite on
  File "/oname=$PLUGINSDIR\mu-fixed-uninstaller.exe" "${UNINSTALLER_OUT_FILE}"

  ${If} ${FileExists} "$MuInstalledUninstaller"
    ClearErrors
    CopyFiles /SILENT "$MuBundledUninstaller" "$MuInstalledUninstaller"
    ${If} ${Errors}
      !insertmacro MU_LOG_UNINSTALLER_REPAIR "copy-failed-retry"
      !insertmacro MU_STOP_APP_PROCESSES
      Sleep 1000

      ClearErrors
      CopyFiles /SILENT "$MuBundledUninstaller" "$MuInstalledUninstaller"
      ${If} ${Errors}
        ${If} ${FileExists} "$MuBundledUninstaller"
          !insertmacro MU_LOG_UNINSTALLER_REPAIR "copy-failed-using-bundled"
          !insertmacro MU_LOG_EVENT "event=uninstaller-repair phase=copy-failed-using-bundled"
        ${Else}
          !insertmacro MU_FAIL_REPORTABLE_BILINGUAL ${MU_E_UNINSTALLER_COPY_OR_REBUILD_FAILED} "uninstaller-repair copy-failed-retry-bundled-missing" "${MU_MSG_UNINSTALLER_COPY_LOCKED_EN}" "${MU_MSG_UNINSTALLER_COPY_LOCKED_ZH}" "${MU_MSG_UNINSTALLER_REPAIR_ACTION_EN}" "${MU_MSG_UNINSTALLER_REPAIR_ACTION_ZH}"
        ${EndIf}
      ${Else}
        !insertmacro MU_LOG_UNINSTALLER_REPAIR "after-copy-retry"
      ${EndIf}
    ${Else}
      !insertmacro MU_LOG_UNINSTALLER_REPAIR "after-copy"
    ${EndIf}
  ${Else}
    ClearErrors
    CopyFiles /SILENT "$MuBundledUninstaller" "$MuInstalledUninstaller"
    ${If} ${Errors}
      !insertmacro MU_FAIL_REPORTABLE_BILINGUAL ${MU_E_UNINSTALLER_COPY_OR_REBUILD_FAILED} "uninstaller-repair rebuild-failed" "${MU_MSG_UNINSTALLER_REBUILD_FAILED_EN}" "${MU_MSG_UNINSTALLER_REBUILD_FAILED_ZH}" "${MU_MSG_UNINSTALLER_REPAIR_ACTION_EN}" "${MU_MSG_UNINSTALLER_REPAIR_ACTION_ZH}"
    ${EndIf}

    ${IfNot} ${FileExists} "$MuInstalledUninstaller"
      !insertmacro MU_FAIL_REPORTABLE_BILINGUAL ${MU_E_UNINSTALLER_COPY_OR_REBUILD_FAILED} "uninstaller-repair rebuild-missing-after-copy" "${MU_MSG_UNINSTALLER_REBUILD_MISSING_EN}" "${MU_MSG_UNINSTALLER_REBUILD_MISSING_ZH}" "${MU_MSG_UNINSTALLER_REPAIR_ACTION_EN}" "${MU_MSG_UNINSTALLER_REPAIR_ACTION_ZH}"
    ${EndIf}

    !insertmacro MU_LOG_UNINSTALLER_REPAIR "rebuilt"
    !insertmacro MU_LOG_EVENT "event=uninstaller-repair phase=rebuilt"
  ${EndIf}
!macroend

!macro MU_HEAL_INSTALL_REGISTRY
  Var /GLOBAL MuRegInstallLocation
  Var /GLOBAL MuRegUninstallString
  Var /GLOBAL MuRegInstallExe

  StrCpy $MuRegistryInstallIsValid "0"

  ReadRegStr $MuRegInstallLocation SHCTX "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ReadRegStr $MuRegUninstallString SHCTX "${UNINSTALL_REGISTRY_KEY}" "UninstallString"

  ${If} $MuRegInstallLocation == ""
    !insertmacro MU_LOG_EVENT "event=registry-heal phase=missing-install-location uninstallString=$MuRegUninstallString"
    !insertmacro MU_CLEAR_INSTALL_REGISTRY "missing-install-location"
  ${Else}
    StrCpy $MuRegInstallExe "$MuRegInstallLocation\${MU_APP_EXECUTABLE_FILENAME}"
    ${If} ${FileExists} "$MuRegInstallExe"
      StrCpy $INSTDIR "$MuRegInstallLocation"
      StrCpy $MuRegistryInstallIsValid "1"
      !insertmacro MU_LOG_EVENT "event=registry-heal phase=valid-install-location instDir=$INSTDIR uninstallString=$MuRegUninstallString"
    ${Else}
      !insertmacro MU_LOG_EVENT "event=registry-heal phase=stale-install-location installLocation=$MuRegInstallLocation uninstallString=$MuRegUninstallString"
      !insertmacro MU_CLEAR_INSTALL_REGISTRY "stale-install-location"
    ${EndIf}
  ${EndIf}
!macroend

!macro MU_LOG_UNINSTALL_RESULT _ROOT_KEY _HAD_ERRORS
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
    $$ErrorActionPreference = 'SilentlyContinue'; \
    $$log = '$MuSessionLogPath'; \
    if (-not $$log) { $$log = Join-Path $$env:TEMP '${MU_FALLBACK_LOG}' }; \
    $$payload = [ordered]@{ schemaVersion = 1; ts = (Get-Date -Format o); session = '$MuSessionId'; version = '${VERSION}'; arch = '${MU_TARGET_ARCH}'; updated = ('$MuIsUpdated' -eq '1'); instDir = '$INSTDIR'; event = 'uninstall-result'; root = '${_ROOT_KEY}'; launchErrors = '${_HAD_ERRORS}'; exitCode = '$R0' }; \
    Add-Content -LiteralPath $$log -Encoding UTF8 -Value ($$payload | ConvertTo-Json -Compress -Depth 8) \
  }"`
  Pop $MuUninstallLogResult
!macroend

!macro MU_HANDLE_UNINSTALL_RESULT _ROOT_KEY _LABEL_PREFIX
  ${If} ${Errors}
    StrCpy $MuUninstallHadErrors "1"
  ${Else}
    StrCpy $MuUninstallHadErrors "0"
  ${EndIf}

  !insertmacro MU_LOG_UNINSTALL_RESULT "${_ROOT_KEY}" "$MuUninstallHadErrors"

  ${If} $MuUninstallHadErrors == "1"
    DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
    Return
  ${EndIf}

  ${If} $R0 != 0
      DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
      !insertmacro MU_READ_LAST_INNER_FAILURE
      ${If} $MuLockerList != ""
        StrCpy $MuInnerFailureSummary "- Failure: previous uninstaller failed with exit code $R0$\r$\n- File or folder: $INSTDIR$\r$\n- Blocking process: $MuLockerList"
      ${EndIf}
      !insertmacro MU_LOG_EVENT "event=old-uninstaller-failed action=report exitCode=$R0 lockers=$MuLockerList uninstallerDetail=$MuInnerFailureSummary"
      ${If} $MuInnerRootCode != ""
        !insertmacro MU_FAIL_REPORTABLE_ROOTED_BILINGUAL_DIAGNOSTICS "$MuInnerRootCode" ${MU_E_OLD_UNINSTALL_FAILED} "old-uninstaller exitCode=$R0 lockers=$MuLockerList uninstallerDetail=$MuInnerFailureSummary" "${MU_MSG_OLD_UNINSTALL_FAILED_EN}" "${MU_MSG_OLD_UNINSTALL_FAILED_ZH}" "${MU_MSG_OLD_UNINSTALL_ACTION_EN}" "${MU_MSG_OLD_UNINSTALL_ACTION_ZH}" "$MuInnerFailureSummary" "$MuInnerFailureSummary"
      ${Else}
        !insertmacro MU_FAIL_REPORTABLE_BILINGUAL_DIAGNOSTICS ${MU_E_OLD_UNINSTALL_FAILED} "old-uninstaller exitCode=$R0 lockers=$MuLockerList uninstallerDetail=$MuInnerFailureSummary" "${MU_MSG_OLD_UNINSTALL_FAILED_EN}" "${MU_MSG_OLD_UNINSTALL_FAILED_ZH}" "${MU_MSG_OLD_UNINSTALL_ACTION_EN}" "${MU_MSG_OLD_UNINSTALL_ACTION_ZH}" "$MuInnerFailureSummary" "$MuInnerFailureSummary"
      ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  !insertmacro MU_HEAL_INSTALL_REGISTRY
  ${If} $MuRegistryInstallIsValid == "1"
    !insertmacro MU_REPAIR_INSTALLED_UNINSTALLER
  ${EndIf}
!macroend

!macro customUnInstallCheck
  !insertmacro MU_HANDLE_UNINSTALL_RESULT "SHELL_CONTEXT" "shctx"
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro MU_HANDLE_UNINSTALL_RESULT "HKEY_CURRENT_USER" "hkcu"
!macroend

!endif
