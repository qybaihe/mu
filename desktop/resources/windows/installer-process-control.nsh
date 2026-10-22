!ifndef MU_INSTALLER_PROCESS_CONTROL_NSH
!define MU_INSTALLER_PROCESS_CONTROL_NSH

Var /GLOBAL MuStopResult
Var /GLOBAL MuLockerResult
Var /GLOBAL MuLockerList
Var /GLOBAL MuLockerListZh
Var /GLOBAL MuLockerListEn
Var /GLOBAL MuLockerListFile
Var /GLOBAL MuCurrentOutDir

!macro MU_FIND_APP_PROCESS _RETURN
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
    $$ErrorActionPreference = 'SilentlyContinue'; \
    $$log = '$MuSessionLogPath'; \
    if (-not $$log) { $$log = Join-Path $$env:TEMP '${MU_FALLBACK_LOG}' }; \
    $$instDir = [System.IO.Path]::GetFullPath('$INSTDIR'); \
    $$ownedPrefix = $$instDir.TrimEnd('\') + '\'; \
    $$psProc = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ProcessId -eq $$PID })[0]; \
    $$installerPid = $$psProc.ParentProcessId; \
    function Test-MuOwnedProcess($$proc) { \
      $$path = $$proc.ExecutablePath; \
      if (-not $$path) { $$path = $$proc.Path } \
      if (-not $$path) { return $$false } \
      try { $$full = [System.IO.Path]::GetFullPath($$path) } catch { return $$false } \
      return $$proc.ProcessId -ne $$installerPid -and $$full.StartsWith($$ownedPrefix, [System.StringComparison]::CurrentCultureIgnoreCase) \
    } \
    $$hits = @(Get-CimInstance -ClassName Win32_Process | Where-Object { Test-MuOwnedProcess $$_ }); \
    $$payload = [ordered]@{ schemaVersion = 1; ts = (Get-Date -Format o); session = '$MuSessionId'; version = '${VERSION}'; arch = '${MU_TARGET_ARCH}'; updated = ('$MuIsUpdated' -eq '1'); instDir = '$INSTDIR'; event = 'process-find'; ownedPrefix = $$ownedPrefix; installerPid = $$installerPid; hits = $$hits.Count; owned = ($$hits.Count -gt 0) }; \
    Add-Content -LiteralPath $$log -Encoding UTF8 -Value ($$payload | ConvertTo-Json -Compress -Depth 8); \
    if ($$hits.Count -gt 0) { $$hitPayload = [ordered]@{ schemaVersion = 1; ts = (Get-Date -Format o); session = '$MuSessionId'; version = '${VERSION}'; arch = '${MU_TARGET_ARCH}'; updated = ('$MuIsUpdated' -eq '1'); instDir = '$INSTDIR'; event = 'process-find-hits'; processes = @($$hits | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,Path,CommandLine) }; Add-Content -LiteralPath $$log -Encoding UTF8 -Value ($$hitPayload | ConvertTo-Json -Compress -Depth 10); exit 0 } \
    exit 1 \
  }"`
  Pop ${_RETURN}
!macroend

!macro MU_STOP_APP_PROCESSES
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
    $$ErrorActionPreference = 'SilentlyContinue'; \
    $$log = '$MuSessionLogPath'; \
    if (-not $$log) { $$log = Join-Path $$env:TEMP '${MU_FALLBACK_LOG}' }; \
    $$instDir = [System.IO.Path]::GetFullPath('$INSTDIR'); \
    $$ownedPrefix = $$instDir.TrimEnd('\') + '\'; \
    $$psProc = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ProcessId -eq $$PID })[0]; \
    $$installerPid = $$psProc.ParentProcessId; \
    function Test-MuOwnedProcess($$proc) { \
      $$path = $$proc.ExecutablePath; \
      if (-not $$path) { $$path = $$proc.Path } \
      if (-not $$path) { return $$false } \
      try { $$full = [System.IO.Path]::GetFullPath($$path) } catch { return $$false } \
      return $$proc.ProcessId -ne $$installerPid -and $$full.StartsWith($$ownedPrefix, [System.StringComparison]::CurrentCultureIgnoreCase) \
    } \
    $$all = @(Get-CimInstance -ClassName Win32_Process); \
    $$owned = @($$all | Where-Object { Test-MuOwnedProcess $$_ }); \
    $$ids = @($$owned | ForEach-Object { [int]$$_.ProcessId }); \
    $$frontier = @($$ids); \
    while ($$frontier.Count -gt 0) { \
      $$children = @($$all | Where-Object { $$frontier -contains [int]$$_.ParentProcessId -and [int]$$_.ProcessId -ne [int]$$installerPid } | Where-Object { Test-MuOwnedProcess $$_ }); \
      $$childIds = @($$children | ForEach-Object { [int]$$_.ProcessId }); \
      $$ids = @($$ids + $$childIds | Select-Object -Unique); \
      $$frontier = $$childIds; \
    } \
    $$payload = [ordered]@{ schemaVersion = 1; ts = (Get-Date -Format o); session = '$MuSessionId'; version = '${VERSION}'; arch = '${MU_TARGET_ARCH}'; updated = ('$MuIsUpdated' -eq '1'); instDir = '$INSTDIR'; event = 'process-stop'; ids = @($$ids); result = 'start' }; \
    Add-Content -LiteralPath $$log -Encoding UTF8 -Value ($$payload | ConvertTo-Json -Compress -Depth 8); \
    foreach ($$id in ($$ids | Sort-Object -Descending)) { Stop-Process -Id $$id -Force -ErrorAction SilentlyContinue } \
    $$payload = [ordered]@{ schemaVersion = 1; ts = (Get-Date -Format o); session = '$MuSessionId'; version = '${VERSION}'; arch = '${MU_TARGET_ARCH}'; updated = ('$MuIsUpdated' -eq '1'); instDir = '$INSTDIR'; event = 'process-stop'; ids = @($$ids); result = 'done' }; \
    Add-Content -LiteralPath $$log -Encoding UTF8 -Value ($$payload | ConvertTo-Json -Compress -Depth 8); \
    exit 0 \
  }"`
  Pop $MuStopResult
!macroend

!macro MU_QUERY_LOCKERS_INLINE_LEGACY _TARGET_PATH _RETURN
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
    $$ErrorActionPreference = 'SilentlyContinue'; \
    $$log = '$MuSessionLogPath'; \
    if (-not $$log) { $$log = Join-Path $$env:TEMP '${MU_FALLBACK_LOG}' }; \
    $$instDir = [System.IO.Path]::GetFullPath('$INSTDIR'); \
    $$targetPath = '${_TARGET_PATH}'; \
    $$currentOutDir = '$MuCurrentOutDir'; \
    $$lockerListPath = '$PLUGINSDIR\mu-rm-lockers.txt'; \
    [System.IO.File]::WriteAllText($$lockerListPath, '', (New-Object System.Text.UTF8Encoding $$false)); \
    try { \
    function Test-MuSamePath($$left, $$right) { \
      if ([string]::IsNullOrWhiteSpace($$left) -or [string]::IsNullOrWhiteSpace($$right)) { return $$false }; \
      try { \
        $$leftFull = [System.IO.Path]::GetFullPath($$left).TrimEnd('\'); \
        $$rightFull = [System.IO.Path]::GetFullPath($$right).TrimEnd('\'); \
        return [string]::Equals($$leftFull, $$rightFull, [System.StringComparison]::CurrentCultureIgnoreCase) \
      } catch { return $$false } \
    } \
    $$psProc = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ProcessId -eq $$PID })[0]; \
    $$installerPid = if ($$psProc) { [int]$$psProc.ParentProcessId } else { 0 }; \
    $$installerSelfLock = (Test-MuSamePath $$currentOutDir $$targetPath) -or (Test-MuSamePath $$currentOutDir $$instDir); \
      $$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('dXNpbmcgU3lzdGVtOyB1c2luZyBTeXN0ZW0uVGV4dDsgdXNpbmcgU3lzdGVtLlJ1bnRpbWUuSW50ZXJvcFNlcnZpY2VzOyBuYW1lc3BhY2UgTXUuUmVzdGFydE1hbmFnZXIgeyBwdWJsaWMgZW51bSBSTV9BUFBfVFlQRSB7IFJtVW5rbm93bkFwcCA9IDAsIFJtTWFpbldpbmRvdyA9IDEsIFJtT3RoZXJXaW5kb3cgPSAyLCBSbVNlcnZpY2UgPSAzLCBSbUV4cGxvcmVyID0gNCwgUm1Db25zb2xlID0gNSwgUm1Dcml0aWNhbCA9IDEwMDAgfSBbU3RydWN0TGF5b3V0KExheW91dEtpbmQuU2VxdWVudGlhbCldIHB1YmxpYyBzdHJ1Y3QgUk1fVU5JUVVFX1BST0NFU1MgeyBwdWJsaWMgaW50IGR3UHJvY2Vzc0lkOyBwdWJsaWMgU3lzdGVtLlJ1bnRpbWUuSW50ZXJvcFNlcnZpY2VzLkNvbVR5cGVzLkZJTEVUSU1FIFByb2Nlc3NTdGFydFRpbWU7IH0gW1N0cnVjdExheW91dChMYXlvdXRLaW5kLlNlcXVlbnRpYWwsIENoYXJTZXQgPSBDaGFyU2V0LlVuaWNvZGUpXSBwdWJsaWMgc3RydWN0IFJNX1BST0NFU1NfSU5GTyB7IHB1YmxpYyBSTV9VTklRVUVfUFJPQ0VTUyBQcm9jZXNzOyBbTWFyc2hhbEFzKFVubWFuYWdlZFR5cGUuQnlWYWxUU3RyLCBTaXplQ29uc3QgPSAyNTYpXSBwdWJsaWMgc3RyaW5nIHN0ckFwcE5hbWU7IFtNYXJzaGFsQXMoVW5tYW5hZ2VkVHlwZS5CeVZhbFRTdHIsIFNpemVDb25zdCA9IDY0KV0gcHVibGljIHN0cmluZyBzdHJTZXJ2aWNlU2hvcnROYW1lOyBwdWJsaWMgUk1fQVBQX1RZUEUgQXBwbGljYXRpb25UeXBlOyBwdWJsaWMgdWludCBBcHBTdGF0dXM7IHB1YmxpYyB1aW50IFRTU2Vzc2lvbklkOyBbTWFyc2hhbEFzKFVubWFuYWdlZFR5cGUuQm9vbCldIHB1YmxpYyBib29sIGJSZXN0YXJ0YWJsZTsgfSBwdWJsaWMgc3RhdGljIGNsYXNzIE5hdGl2ZSB7IFtEbGxJbXBvcnQoInJzdHJ0bWdyLmRsbCIsIENoYXJTZXQ9Q2hhclNldC5Vbmljb2RlKV0gcHVibGljIHN0YXRpYyBleHRlcm4gaW50IFJtU3RhcnRTZXNzaW9uKG91dCB1aW50IHBTZXNzaW9uSGFuZGxlLCBpbnQgZHdTZXNzaW9uRmxhZ3MsIFN0cmluZ0J1aWxkZXIgc3RyU2Vzc2lvbktleSk7IFtEbGxJbXBvcnQoInJzdHJ0bWdyLmRsbCIsIENoYXJTZXQ9Q2hhclNldC5Vbmljb2RlKV0gcHVibGljIHN0YXRpYyBleHRlcm4gaW50IFJtUmVnaXN0ZXJSZXNvdXJjZXModWludCBkd1Nlc3Npb25IYW5kbGUsIFVJbnQzMiBuRmlsZXMsIHN0cmluZ1tdIHJnc0ZpbGVuYW1lcywgVUludDMyIG5BcHBsaWNhdGlvbnMsIEludFB0ciByZ0FwcGxpY2F0aW9ucywgVUludDMyIG5TZXJ2aWNlcywgc3RyaW5nW10gcmdzU2VydmljZU5hbWVzKTsgW0RsbEltcG9ydCgicnN0cnRtZ3IuZGxsIildIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIGludCBSbUdldExpc3QodWludCBkd1Nlc3Npb25IYW5kbGUsIG91dCB1aW50IHBuUHJvY0luZm9OZWVkZWQsIHJlZiB1aW50IHBuUHJvY0luZm8sIFtJbiwgT3V0XSBSTV9QUk9DRVNTX0lORk9bXSByZ0FmZmVjdGVkQXBwcywgcmVmIHVpbnQgbHBkd1JlYm9vdFJlYXNvbnMpOyBbRGxsSW1wb3J0KCJyc3RydG1nci5kbGwiKV0gcHVibGljIHN0YXRpYyBleHRlcm4gaW50IFJtRW5kU2Vzc2lvbih1aW50IHBTZXNzaW9uSGFuZGxlKTsgfSB9')); \
      Add-Type -TypeDefinition $$source -ErrorAction Stop; \
      $$session = [uint32]0; $$key = New-Object System.Text.StringBuilder 64; \
      $$result = [Mu.RestartManager.Native]::RmStartSession([ref]$$session, 0, $$key); \
      if ($$result -ne 0) { throw \"RmStartSession=$$result\" } \
      try { \
        $$ERROR_MORE_DATA = 234; \
        $$ERROR_ACCESS_DENIED = 5; \
        $$resources = @(); \
        if ($$targetPath -and (Test-Path -LiteralPath $$targetPath -PathType Leaf)) { \
          $$resources = @([System.IO.Path]::GetFullPath($$targetPath)); \
        } elseif ($$targetPath -and (Test-Path -LiteralPath $$targetPath -PathType Container)) { \
          $$root = [System.IO.Path]::GetFullPath($$targetPath); \
          $$topLevel = @(Get-ChildItem -LiteralPath $$root -Force -File -ErrorAction SilentlyContinue | ForEach-Object { $$_.FullName }); \
          $$knownRelative = @('${MU_APP_EXECUTABLE_FILENAME}', '${UNINSTALL_FILENAME}', 'resources\app.asar', 'resources\app-update.yml', 'resources\bundled-backend\win32-x64\aioncore.exe', 'resources\bundled-aioncore\win32-x64\aioncore.exe'); \
          $$known = @($$knownRelative | ForEach-Object { Join-Path $$root $$_ } | Where-Object { Test-Path -LiteralPath $$_ -PathType Leaf }); \
          $$resources = @($$topLevel + $$known | Where-Object { $$_ -and $$_.Trim().Length -gt 0 } | Select-Object -Unique | Select-Object -First 512); \
        } \
        $$payload = [ordered]@{ schemaVersion = 1; ts = (Get-Date -Format o); session = '$MuSessionId'; version = '${VERSION}'; arch = '${MU_TARGET_ARCH}'; updated = ('$MuIsUpdated' -eq '1'); instDir = '$INSTDIR'; event = 'rm-query-start'; target = $$targetPath; resources = $$resources.Count; outerInstallerPid = $$installerPid; currentOutDir = $$currentOutDir; installerSelfLock = $$installerSelfLock }; \
        Add-Content -LiteralPath $$log -Encoding UTF8 -Value ($$payload | ConvertTo-Json -Compress -Depth 8); \
        if ($$resources.Count -eq 0) { \
          if ($$installerSelfLock -and $$installerPid -gt 0) { \
            $$lockerText = 'mu installer(' + $$installerPid + ')'; \
            [System.IO.File]::WriteAllText($$lockerListPath, $$lockerText, (New-Object System.Text.UTF8Encoding $$false)); \
            $$selfLockers = @([pscustomobject]@{ name = 'mu installer'; pid = [int]$$installerPid }); \
            $$payload = [ordered]@{ schemaVersion = 1; ts = (Get-Date -Format o); session = '$MuSessionId'; version = '${VERSION}'; arch = '${MU_TARGET_ARCH}'; updated = ('$MuIsUpdated' -eq '1'); instDir = '$INSTDIR'; event = 'rm-lockers'; target = $$targetPath; resources = 0; count = 1; blockingProcesses = @($$selfLockers); fallbackReason = 'installer-self-lock'; message = 'The installer process is using the install directory as its current output directory.'; outerInstallerPid = $$installerPid; currentOutDir = $$currentOutDir; installerSelfLock = $$true }; \
            Add-Content -LiteralPath $$log -Encoding UTF8 -Value ($$payload | ConvertTo-Json -Compress -Depth 10); \
            exit 0 \
          }; \
          $$payload = [ordered]@{ schemaVersion = 1; ts = (Get-Date -Format o); session = '$MuSessionId'; version = '${VERSION}'; arch = '${MU_TARGET_ARCH}'; updated = ('$MuIsUpdated' -eq '1'); instDir = '$INSTDIR'; event = 'rm-lockers'; target = $$targetPath; resources = 0; count = 0; blockingProcesses = @(); fallbackReason = 'restart-manager-no-resources'; message = 'Restart Manager had no existing files to query for this path.'; outerInstallerPid = $$installerPid; currentOutDir = $$currentOutDir; installerSelfLock = $$installerSelfLock }; \
          Add-Content -LiteralPath $$log -Encoding UTF8 -Value ($$payload | ConvertTo-Json -Compress -Depth 8); \
          exit 1 \
        } \
        for ($$i = 0; $$i -lt $$resources.Count; $$i += 256) { \
          $$end = [Math]::Min($$i + 255, $$resources.Count - 1); \
          $$chunk = [string[]]$$resources[$$i..$$end]; \
          $$result = [Mu.RestartManager.Native]::RmRegisterResources($$session, [uint32]$$chunk.Count, $$chunk, 0, [IntPtr]::Zero, 0, $$null); \
          if ($$result -ne 0) { throw \"RmRegisterResources=$$result\" } \
        } \
        $$needed = [uint32]0; $$count = [uint32]0; $$reasons = [uint32]0; \
        for ($$attempt = 0; $$attempt -lt 6; $$attempt++) { \
          if ($$attempt -gt 0) { Start-Sleep -Milliseconds (50 * $$attempt) } \
          $$needed = [uint32]0; $$count = [uint32]0; $$reasons = [uint32]0; \
          $$result = [Mu.RestartManager.Native]::RmGetList($$session, [ref]$$needed, [ref]$$count, $$null, [ref]$$reasons); \
          if ($$result -ne $$ERROR_ACCESS_DENIED) { break } \
        } \
        if ($$result -ne 0 -and $$result -ne 234) { throw \"RmGetList=$$result\" } \
        $$lockers = @(); \
        if ($$result -eq $$ERROR_MORE_DATA -or $$needed -gt 0) { \
          for ($$attempt = 0; $$attempt -lt 6; $$attempt++) { \
            if ($$attempt -gt 0) { Start-Sleep -Milliseconds (50 * $$attempt) } \
            $$count = $$needed; \
            $$apps = New-Object 'Mu.RestartManager.RM_PROCESS_INFO[]' $$count; \
            $$result = [Mu.RestartManager.Native]::RmGetList($$session, [ref]$$needed, [ref]$$count, $$apps, [ref]$$reasons); \
            if ($$result -ne $$ERROR_ACCESS_DENIED -and $$result -ne $$ERROR_MORE_DATA) { break } \
          } \
          if ($$result -ne 0) { throw \"RmGetList=$$result\" } \
          $$lockers = @($$apps | Select-Object -First $$count | Where-Object { $$_.Process.dwProcessId -gt 0 } | ForEach-Object { \
            $$name = $$_.strAppName; \
            if (-not $$name) { $$proc = Get-Process -Id $$_.Process.dwProcessId -ErrorAction SilentlyContinue; if ($$proc) { $$name = $$proc.ProcessName } } \
            if (-not $$name) { $$name = 'unknown' } \
            [pscustomobject]@{ name = $$name; pid = [int]$$_.Process.dwProcessId } \
          }); \
        } \
        if ($$lockers.Count -eq 0 -and $$installerSelfLock -and $$installerPid -gt 0) { $$lockers = @([pscustomobject]@{ name = 'mu installer'; pid = [int]$$installerPid }) }; \
        $$lockerText = @($$lockers | ForEach-Object { $$_.name + '(' + $$_.pid + ')' }) -join ', '; \
        [System.IO.File]::WriteAllText($$lockerListPath, $$lockerText, (New-Object System.Text.UTF8Encoding $$false)); \
        $$payload = [ordered]@{ schemaVersion = 1; ts = (Get-Date -Format o); session = '$MuSessionId'; version = '${VERSION}'; arch = '${MU_TARGET_ARCH}'; updated = ('$MuIsUpdated' -eq '1'); instDir = '$INSTDIR'; event = 'rm-lockers'; target = $$targetPath; resources = $$resources.Count; count = $$needed; blockingProcesses = @($$lockers); fallbackReason = ''; message = ''; outerInstallerPid = $$installerPid; currentOutDir = $$currentOutDir; installerSelfLock = $$installerSelfLock }; \
        if ($$installerSelfLock -and $$lockers.Count -gt 0) { $$payload.fallbackReason = 'installer-self-lock'; $$payload.message = 'The installer process is using the install directory as its current output directory.' } elseif ($$lockers.Count -eq 0) { $$payload.fallbackReason = 'restart-manager-no-process'; $$payload.message = 'Windows did not identify a specific locking process. Close terminals, editors, and file managers opened in the install folder.' }; \
        Add-Content -LiteralPath $$log -Encoding UTF8 -Value ($$payload | ConvertTo-Json -Compress -Depth 10); \
        if ($$lockers.Count -gt 0) { exit 0 } else { exit 1 } \
      } finally { [void][Mu.RestartManager.Native]::RmEndSession($$session) } \
    } catch { \
      $$payload = [ordered]@{ schemaVersion = 1; ts = (Get-Date -Format o); session = '$MuSessionId'; version = '${VERSION}'; arch = '${MU_TARGET_ARCH}'; updated = ('$MuIsUpdated' -eq '1'); instDir = '$INSTDIR'; event = 'rm-error'; target = $$targetPath; error = $$_.Exception.Message }; \
      Add-Content -LiteralPath $$log -Encoding UTF8 -Value ($$payload | ConvertTo-Json -Compress -Depth 8); \
      exit 1 \
    } \
  }"`
  Pop ${_RETURN}
!macroend

!macro MU_QUERY_LOCKERS _TARGET_PATH _RETURN
  InitPluginsDir
  File /oname=$PLUGINSDIR\mu-query-lockers.ps1 "${PROJECT_DIR}\resources\windows\support\query-lockers.ps1"
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\mu-query-lockers.ps1" -LogPath "$MuSessionLogPath" -InstDir "$INSTDIR" -TargetPath "${_TARGET_PATH}" -LockerListPath "$PLUGINSDIR\mu-rm-lockers.txt" -Session "$MuSessionId" -Version "${VERSION}" -Arch "${MU_TARGET_ARCH}" -Updated "$MuIsUpdated" -CurrentOutDir "$MuCurrentOutDir"`
  Pop ${_RETURN}
!macroend

!macro MU_CAPTURE_FAILED_PATH_LOCKERS _FAILED_PATH
  !insertmacro MU_QUERY_LOCKERS "${_FAILED_PATH}" $MuLockerResult
  StrCpy $MuLockerList ""
  ClearErrors
  SetDetailsPrint none
  FileOpen $MuLockerListFile "$PLUGINSDIR\mu-rm-lockers.txt" r
  ${IfNot} ${Errors}
    FileRead $MuLockerListFile $MuLockerList
    FileClose $MuLockerListFile
  ${EndIf}
  SetDetailsPrint lastused
  ${If} $MuLockerList == ""
    ${If} $MuLockerResult == 0
      StrCpy $MuLockerList "${MU_MSG_UNKNOWN_PROCESS_EN}"
      StrCpy $MuLockerListZh "${MU_MSG_UNKNOWN_PROCESS_ZH}"
      StrCpy $MuLockerListEn "${MU_MSG_UNKNOWN_PROCESS_EN}"
    ${Else}
      StrCpy $MuLockerList "${MU_MSG_LOCKER_UNKNOWN_EN}"
      StrCpy $MuLockerListZh "${MU_MSG_LOCKER_UNKNOWN_ZH}"
      StrCpy $MuLockerListEn "${MU_MSG_LOCKER_UNKNOWN_EN}"
    ${EndIf}
  ${Else}
    StrCpy $MuLockerListZh "$MuLockerList"
    StrCpy $MuLockerListEn "$MuLockerList"
  ${EndIf}
!macroend

!macro MU_PROMPT_FAILED_PATH_LOCKERS _FAILED_PATH _PHASE _RETRY_LABEL _CANCEL_LABEL _CONTINUE_LABEL
  !insertmacro MU_CAPTURE_FAILED_PATH_LOCKERS "${_FAILED_PATH}"
  ${If} $MuLockerResult == 0
    ${IfNot} ${Silent}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${MU_MSG_FILE_OR_FOLDER_IN_USE_ZH}$\r$\n${_FAILED_PATH}$\r$\n$\r$\n${MU_MSG_APPLICATION_USING_IT_ZH}$\r$\n$MuLockerListZh$\r$\n$\r$\n${MU_MSG_CLOSE_LISTED_RETRY_ZH}$\r$\n$\r$\n${MU_MSG_INSTALLER_LOG_ZH}:$\r$\n$MuSessionLogPath$\r$\n$\r$\n${MU_MSG_BLOCK_SEPARATOR}$\r$\n$\r$\n${MU_MSG_FILE_OR_FOLDER_IN_USE_EN}$\r$\n${_FAILED_PATH}$\r$\n$\r$\n${MU_MSG_APPLICATION_USING_IT_EN}$\r$\n$MuLockerListEn$\r$\n$\r$\n${MU_MSG_CLOSE_LISTED_RETRY_EN}$\r$\n$\r$\n${MU_MSG_INSTALLER_LOG_EN}:$\r$\n$MuSessionLogPath" /SD IDCANCEL IDRETRY ${_RETRY_LABEL} IDCANCEL ${_CANCEL_LABEL}
    ${EndIf}
  ${EndIf}
  Goto ${_CONTINUE_LABEL}
!macroend

!macro MU_WRITE_INSTALLER_LAST_FAILURE_MARKER
  Push $9
  ${If} $MuIsUpdated == "1"
    ${If} ${Silent}
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
        $$ErrorActionPreference = 'Stop'; \
        $$appDir = Join-Path $$env:APPDATA 'mu'; \
        $$marker = Join-Path $$appDir 'installer-last-failure.json'; \
        $$log = '$MuSessionLogPath'; \
        if (-not $$log) { $$log = Join-Path $$env:TEMP '${MU_FALLBACK_LOG}' }; \
        try { \
          New-Item -ItemType Directory -Path $$appDir -Force | Out-Null; \
          $$payload = [ordered]@{ \
            schemaVersion = 1; \
            kind = 'app-cannot-be-closed'; \
            phase = 'customCheckAppRunning'; \
            silent = $$true; \
            updated = $$true; \
            retryCount = 3; \
            instDir = '$INSTDIR'; \
            logPath = $$log; \
            at = (Get-Date -Format o) \
          }; \
          $$json = $$payload | ConvertTo-Json -Compress -Depth 4; \
          [System.IO.File]::WriteAllText($$marker, $$json, (New-Object System.Text.UTF8Encoding $$false)); \
          $$logPayload = [ordered]@{ schemaVersion = 1; ts = (Get-Date -Format o); session = '$MuSessionId'; version = '${VERSION}'; arch = '${MU_TARGET_ARCH}'; updated = ('$MuIsUpdated' -eq '1'); instDir = '$INSTDIR'; event = 'marker-write'; result = 'ok'; path = $$marker; marker = $$payload }; \
          Add-Content -LiteralPath $$log -Encoding UTF8 -Value ($$logPayload | ConvertTo-Json -Compress -Depth 8) \
        } catch { \
          $$logPayload = [ordered]@{ schemaVersion = 1; ts = (Get-Date -Format o); session = '$MuSessionId'; version = '${VERSION}'; arch = '${MU_TARGET_ARCH}'; updated = ('$MuIsUpdated' -eq '1'); instDir = '$INSTDIR'; event = 'marker-write'; result = 'failed'; path = $$marker; error = $$_.Exception.Message }; \
          Add-Content -LiteralPath $$log -Encoding UTF8 -Value ($$logPayload | ConvertTo-Json -Compress -Depth 8) \
        } \
      }"`
      Pop $9
    ${EndIf}
  ${EndIf}
  Pop $9
!macroend

!macro customCheckAppRunning
  Var /GLOBAL MuCheckResult
  Var /GLOBAL MuCloseRetries
  InitPluginsDir
  !insertmacro MU_SESSION_BEGIN

  !insertmacro MU_WAIT_FOR_UPDATED_APP_EXIT
  !insertmacro MU_FIND_APP_PROCESS $MuCheckResult
  ${If} $MuCheckResult == 0
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK mu_do_stop_process
    !insertmacro MU_CLEAR_ACTIVE_INSTALLER_MARKER
    Quit

    mu_do_stop_process:
      DetailPrint "$(appClosing)"
      !insertmacro MU_STOP_APP_PROCESSES
      StrCpy $MuCloseRetries 0

    mu_wait_for_close:
      Sleep 1000
      !insertmacro MU_FIND_APP_PROCESS $MuCheckResult
      ${If} $MuCheckResult == 0
        IntOp $MuCloseRetries $MuCloseRetries + 1
        ${If} $MuCloseRetries > 10
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${MU_MSG_CLOSE_OR_REMOVE_PREVIOUS_ZH}$\r$\n$\r$\n${MU_MSG_MAY_USE_INSTALL_DIR_ZH}$\r$\n$INSTDIR$\r$\n$\r$\n${MU_MSG_RETRY_AFTER_CLOSING_DIR_ZH}$\r$\n$\r$\n${MU_MSG_BLOCK_SEPARATOR}$\r$\n$\r$\n${MU_MSG_CLOSE_OR_REMOVE_PREVIOUS_EN}$\r$\n$\r$\n${MU_MSG_MAY_USE_INSTALL_DIR_EN}$\r$\n$INSTDIR$\r$\n$\r$\n${MU_MSG_RETRY_AFTER_CLOSING_DIR_EN}" /SD IDCANCEL IDRETRY mu_wait_for_close
          !insertmacro MU_WRITE_INSTALLER_LAST_FAILURE_MARKER
          !insertmacro MU_FAIL_REPORTABLE_BILINGUAL_DIAGNOSTICS ${MU_E_INSTALL_DIR_REMOVE_OR_LOCKED} "event=session-end result=fail code=${MU_E_INSTALL_DIR_REMOVE_OR_LOCKED} phase=app-cannot-be-closed retryCount=$MuCloseRetries instDir=$INSTDIR" "${MU_MSG_CLOSE_OR_REMOVE_PREVIOUS_EN}" "${MU_MSG_CLOSE_OR_REMOVE_PREVIOUS_ZH}" "${MU_MSG_CLOSE_INSTALL_DIR_ACTION_EN}" "${MU_MSG_CLOSE_INSTALL_DIR_ACTION_ZH}" "app-cannot-be-closed retryCount=$MuCloseRetries instDir=$INSTDIR" "app-cannot-be-closed retryCount=$MuCloseRetries instDir=$INSTDIR"
        ${Else}
          !insertmacro MU_STOP_APP_PROCESSES
          Goto mu_wait_for_close
        ${EndIf}
      ${EndIf}
  ${EndIf}

!macroend

!endif
