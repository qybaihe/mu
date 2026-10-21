!ifndef MU_INSTALLER_UPDATE_VERIFY_NSH
!define MU_INSTALLER_UPDATE_VERIFY_NSH

Var /GLOBAL MuUninstallHadErrors
Var /GLOBAL MuUninstallLogResult
Var /GLOBAL MuVerifyResourceResult
Var /GLOBAL MuUpdatedAppExitWaitResult
Var /GLOBAL MuActiveMarkerExecResult
Var /GLOBAL MuActiveMarkerResult

!define MU_ACTIVE_INSTALLER_MARKER "mu-installer-active.marker"
; Legacy name: installers from before the rename to mu kept this marker in %TEMP% under
; the name below, and one that was killed mid-install leaves it there.
; MU_RECORD_ACTIVE_INSTALLER_MARKER still reads it when the new marker is missing, and
; MU_WRITE_ACTIVE_INSTALLER_MARKER removes it, as it used to overwrite the one shared
; marker. Nothing writes this name any more.
!define MU_LEGACY_ACTIVE_INSTALLER_MARKER "aionui-installer-active.marker"

!macro MU_BRING_UPDATED_INSTALLER_TO_FRONT
  ${If} ${isUpdated}
    BringToFront
    !insertmacro MU_SLOG "event=updated-installer-foreground action=bring-to-front"
  ${EndIf}
!macroend

!macro MU_WAIT_FOR_UPDATED_APP_EXIT
  ${If} ${isUpdated}
    !insertmacro MU_SLOG "event=updated-app-exit-wait phase=start"
    StrCpy $MuUpdatedAppExitWaitResult "0"

    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
      $$ErrorActionPreference = 'SilentlyContinue'; \
      $$deadline = (Get-Date).AddSeconds(10); \
      $$target = [System.IO.Path]::GetFullPath((Join-Path '$INSTDIR' '${MU_APP_EXECUTABLE_FILENAME}')); \
      do { \
        $$hits = @(Get-CimInstance -ClassName Win32_Process | Where-Object { \
          $$path = $$_.ExecutablePath; \
          if (-not $$path) { $$path = $$_.Path } \
          $$_.Name -ieq '${MU_APP_EXECUTABLE_FILENAME}' -and $$path -and \
          [string]::Equals([System.IO.Path]::GetFullPath($$path), $$target, [System.StringComparison]::CurrentCultureIgnoreCase) \
        }); \
        if ($$hits.Count -eq 0) { exit 0 }; \
        Start-Sleep -Milliseconds 500; \
      } while ((Get-Date) -lt $$deadline); \
      exit 1 \
    }"`
    Pop $MuUpdatedAppExitWaitResult

    ${If} $MuUpdatedAppExitWaitResult != 0
      !insertmacro MU_SLOG "event=updated-app-exit-wait phase=timeout action=stop"
      !insertmacro MU_STOP_APP_PROCESSES
    ${EndIf}

    !insertmacro MU_SLOG "event=updated-app-exit-wait phase=done result=$MuUpdatedAppExitWaitResult"
  ${EndIf}
!macroend

!macro MU_RECORD_ACTIVE_INSTALLER_MARKER
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
    $$ErrorActionPreference = 'SilentlyContinue'; \
    $$marker = Join-Path $$env:TEMP '${MU_ACTIVE_INSTALLER_MARKER}'; \
    if (-not (Test-Path -LiteralPath $$marker)) { $$marker = Join-Path $$env:TEMP '${MU_LEGACY_ACTIVE_INSTALLER_MARKER}' }; \
    if (-not (Test-Path -LiteralPath $$marker)) { Write-Output 'missing'; exit 0 }; \
    $$item = Get-Item -LiteralPath $$marker; \
    if ($$item.LastWriteTime -lt (Get-Date).AddHours(-2)) { Write-Output 'stale'; exit 0 }; \
    Write-Output 'active' \
  }"`
  Pop $MuActiveMarkerExecResult
  Pop $MuActiveMarkerResult
  ${If} $MuActiveMarkerResult == "active"
    !insertmacro MU_SLOG "event=installer-active-marker state=active"
  ${ElseIf} $MuActiveMarkerResult == "stale"
    !insertmacro MU_SLOG "event=installer-active-marker state=stale"
  ${Else}
    !insertmacro MU_SLOG "event=installer-active-marker state=missing"
  ${EndIf}
!macroend

!macro MU_WRITE_ACTIVE_INSTALLER_MARKER
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
    $$ErrorActionPreference = 'SilentlyContinue'; \
    Remove-Item -LiteralPath (Join-Path $$env:TEMP '${MU_LEGACY_ACTIVE_INSTALLER_MARKER}') -Force; \
    $$marker = Join-Path $$env:TEMP '${MU_ACTIVE_INSTALLER_MARKER}'; \
    Set-Content -LiteralPath $$marker -Encoding UTF8 -Value ('pid=' + $$PID + ';session=$MuSessionId;started=' + (Get-Date -Format o)) \
  }"`
  Pop $MuActiveMarkerResult
!macroend

!macro MU_CLEAR_ACTIVE_INSTALLER_MARKER
  !ifndef BUILD_UNINSTALLER
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
      $$ErrorActionPreference = 'SilentlyContinue'; \
      Remove-Item -LiteralPath (Join-Path $$env:TEMP '${MU_ACTIVE_INSTALLER_MARKER}') -Force \
    }"`
    Pop $MuActiveMarkerResult
  !endif
!macroend

!macro MU_OVERRIDE_SINGLE_INSTANCE
!macroend

!macro MU_OVERRIDE_APP_CANNOT_BE_CLOSED_MESSAGE
  !pragma warning disable 6030
  ; One language per LangString: English (1033) and Simplified Chinese (2052) installers each show their own.
  LangString appCannotBeClosed 1033 "${MU_MSG_APP_CANNOT_BE_CLOSED_EN}"
  LangString appCannotBeClosed 2052 "${MU_MSG_APP_CANNOT_BE_CLOSED_ZH}"
  !pragma warning default 6030
!macroend

!macro MU_INSTALLER_CUSTOM_HEADER
  !insertmacro MU_OVERRIDE_SINGLE_INSTANCE
  !insertmacro MU_OVERRIDE_APP_CANNOT_BE_CLOSED_MESSAGE
!macroend

!macro MU_RELEASE_INSTALL_DIR_OUTDIR
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  StrCpy $MuCurrentOutDir "$PLUGINSDIR"
!macroend

; Resolve the machine's real native architecture (arm64 / x64 / x86) for diagnostics.
; Backed by IsWow64Process2 (via x64.nsh), so it reports the true hardware arch even when
; the installer runs under x86/x64 emulation. Replaces the old hardcoded "non-arm64" detail.
!macro MU_DETECT_NATIVE_ARCH _OUT
  ${If} ${IsNativeARM64}
    StrCpy ${_OUT} "arm64"
  ${ElseIf} ${RunningX64}
    StrCpy ${_OUT} "x64"
  ${Else}
    StrCpy ${_OUT} "x86"
  ${EndIf}
!macroend

!macro MU_INSTALLER_PREINIT
  !ifdef BUILD_UNINSTALLER
    StrCpy $MuSessionId ""
    StrCpy $MuIsUpdated "0"
    StrCpy $MuSessionLogResult ""
    StrCpy $MuSessionLogPath "$TEMP\${MU_FALLBACK_LOG}"
    StrCpy $MuUninstallHadErrors "0"
    StrCpy $MuUninstallLogResult ""
    StrCpy $MuVerifyResourceResult ""
    StrCpy $MuUpdatedAppExitWaitResult ""
    StrCpy $MuActiveMarkerExecResult ""
    StrCpy $MuActiveMarkerResult ""
    StrCpy $MuStopResult ""
    StrCpy $MuLockerListZh ""
    StrCpy $MuLockerListEn ""
  !else
    !insertmacro MU_RELEASE_INSTALL_DIR_OUTDIR
    !insertmacro MU_SESSION_BEGIN
    !insertmacro MU_SLOG "event=installer-outdir-release outDir=$MuCurrentOutDir instDir=$INSTDIR"
    ; Guard target/machine architecture as early as possible: this runs before customInit's
    ; registry heal/clear/repair, so a wrong-arch installer aborts without mutating an existing
    ; correct-arch install's registry or uninstaller state. (Sentry ELECTRON-3BX / code E1040)
    !insertmacro MU_ASSERT_TARGET_ARCH
    !insertmacro MU_BRING_UPDATED_INSTALLER_TO_FRONT
    !insertmacro MU_RECORD_ACTIVE_INSTALLER_MARKER
    !insertmacro MU_WRITE_ACTIVE_INSTALLER_MARKER
  !endif
!macroend

!macro MU_VERIFY_REQUIRED_FILE _PATH _LABEL
  ${IfNot} ${FileExists} "${_PATH}"
    !insertmacro MU_LOG_EVENT "verify-required-file missing label=${_LABEL} path=${_PATH}"
    !insertmacro MU_FAIL_UX \
      "${MU_E_CORE_APP_FILES_INCOMPLETE}" \
      "verify-required-file missing label=${_LABEL} path=${_PATH}" \
      "${MU_MSG_VERIFY_REQUIRED_FILE_ZH} ${_LABEL}" \
      "${MU_MSG_VERIFY_REQUIRED_FILE_EN} ${_LABEL}" \
      "${MU_MSG_VERIFY_REQUIRED_FILE_ACTION_ZH}" \
      "${MU_MSG_VERIFY_REQUIRED_FILE_ACTION_EN}" \
      "verify-required-file missing label=${_LABEL} path=${_PATH}" \
      "verify-required-file missing label=${_LABEL} path=${_PATH}"
  ${Else}
    !insertmacro MU_LOG_EVENT "verify-required-file ok label=${_LABEL} path=${_PATH}"
  ${EndIf}
!macroend

!macro MU_VERIFY_CORE_APP_FILES
  !insertmacro MU_LOG_EVENT "verify-install start instDir=$INSTDIR"
  !insertmacro MU_VERIFY_REQUIRED_FILE "$INSTDIR\${MU_APP_EXECUTABLE_FILENAME}" "${MU_APP_EXECUTABLE_FILENAME}"
  !insertmacro MU_VERIFY_REQUIRED_FILE "$INSTDIR\ffmpeg.dll" "ffmpeg.dll"
  !insertmacro MU_VERIFY_REQUIRED_FILE "$INSTDIR\libEGL.dll" "libEGL.dll"
  !insertmacro MU_VERIFY_REQUIRED_FILE "$INSTDIR\libGLESv2.dll" "libGLESv2.dll"
  !insertmacro MU_VERIFY_REQUIRED_FILE "$INSTDIR\d3dcompiler_47.dll" "d3dcompiler_47.dll"
  !insertmacro MU_VERIFY_REQUIRED_FILE "$INSTDIR\dxcompiler.dll" "dxcompiler.dll"
  !insertmacro MU_VERIFY_REQUIRED_FILE "$INSTDIR\dxil.dll" "dxil.dll"
  !insertmacro MU_VERIFY_REQUIRED_FILE "$INSTDIR\vk_swiftshader.dll" "vk_swiftshader.dll"
  !insertmacro MU_VERIFY_REQUIRED_FILE "$INSTDIR\vulkan-1.dll" "vulkan-1.dll"
  !insertmacro MU_VERIFY_REQUIRED_FILE "$INSTDIR\resources\app.asar" "resources\app.asar"
!macroend

!macro MU_VERIFY_BUNDLED_BACKEND_RESOURCES _RUNTIME_KEY
  InitPluginsDir
  File "/oname=$PLUGINSDIR\verify-bundled-backend-install.ps1" "${PROJECT_DIR}\resources\windows\support\verify-bundled-backend-install.ps1"
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\verify-bundled-backend-install.ps1" -InstallDir "$INSTDIR" -RuntimeKey "${_RUNTIME_KEY}" -LogPath "$MuSessionLogPath"`
  Pop $MuVerifyResourceResult

  ${If} $MuVerifyResourceResult != 0
    !insertmacro MU_FAIL_UX \
      "${MU_E_BUNDLED_BACKEND_INCOMPLETE}" \
      "event=session-end result=fail code=${MU_E_BUNDLED_BACKEND_INCOMPLETE} detail=bundled-backend-incomplete runtime=${_RUNTIME_KEY} result=$MuVerifyResourceResult" \
      "${MU_MSG_BUNDLED_BACKEND_INCOMPLETE_ZH}" \
      "${MU_MSG_BUNDLED_BACKEND_INCOMPLETE_EN}" \
      "${MU_MSG_BUNDLED_BACKEND_INCOMPLETE_ACTION_ZH}" \
      "${MU_MSG_BUNDLED_BACKEND_INCOMPLETE_ACTION_EN}" \
      "bundled-backend-incomplete runtime=${_RUNTIME_KEY} result=$MuVerifyResourceResult instDir=$INSTDIR" \
      "bundled-backend-incomplete runtime=${_RUNTIME_KEY} result=$MuVerifyResourceResult instDir=$INSTDIR"
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro MU_VERIFY_CORE_APP_FILES
  !insertmacro MU_VERIFY_BUNDLED_BACKEND_RESOURCES "${MU_RUNTIME_KEY}"
  !insertmacro MU_LOG_EVENT "verify-install ok instDir=$INSTDIR"
  !insertmacro MU_CLEAR_ACTIVE_INSTALLER_MARKER
  !insertmacro MU_SESSION_SUCCESS
!macroend

!endif
