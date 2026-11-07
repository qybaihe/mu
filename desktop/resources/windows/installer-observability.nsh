!ifndef MU_INSTALLER_OBSERVABILITY_NSH
!define MU_INSTALLER_OBSERVABILITY_NSH

!define MU_APP_EXECUTABLE_FILENAME "mu.exe"
!define MU_FALLBACK_LOG "mu-installer-${VERSION}-fallback-log.jsonl"

!pragma warning disable 6001
Var /GLOBAL MuSessionId
Var /GLOBAL MuIsUpdated
Var /GLOBAL MuSessionLogResult
Var /GLOBAL MuSessionLogPath

!macro MU_SESSION_HEADER
  !insertmacro MU_SLOG "event=header arch=${MU_TARGET_ARCH} updated=$MuIsUpdated instDir=$INSTDIR version=${VERSION} log=$MuSessionLogPath detail=customHeader"
!macroend

!macro MU_SLOG _MESSAGE
  Push $9
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
    $$ErrorActionPreference = 'SilentlyContinue'; \
    $$log = '$MuSessionLogPath'; \
    if (-not $$log) { $$log = Join-Path $$env:TEMP '${MU_FALLBACK_LOG}' }; \
    $$session = '$MuSessionId'; \
    if (-not $$session) { $$session = 'uninitialized' }; \
    $$message = '${_MESSAGE}'; \
    $$event = 'log'; \
    if ($$message -match '(^|\s)event=([^\s]+)') { $$event = $$Matches[2] } else { $$first = @($$message -split '\s+', 2)[0]; if ($$first -and $$first -notmatch '=') { $$event = $$first } }; \
    $$payload = [ordered]@{ schemaVersion = 1; ts = (Get-Date -Format o); session = $$session; version = '${VERSION}'; arch = '${MU_TARGET_ARCH}'; updated = ('$MuIsUpdated' -eq '1'); instDir = '$INSTDIR'; event = $$event; message = $$message }; \
    $$json = $$payload | ConvertTo-Json -Compress -Depth 8; \
    Add-Content -LiteralPath $$log -Encoding UTF8 -Value $$json \
  }"`
  Pop $9
  Pop $9
!macroend

!macro MU_LOG_EVENT _MESSAGE
  Push $9
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
    $$ErrorActionPreference = 'SilentlyContinue'; \
    $$log = '$MuSessionLogPath'; \
    if (-not $$log) { $$log = Join-Path $$env:TEMP '${MU_FALLBACK_LOG}' }; \
    $$session = '$MuSessionId'; \
    if (-not $$session) { $$session = 'uninitialized' }; \
    $$message = '${_MESSAGE}'; \
    $$event = 'log'; \
    if ($$message -match '(^|\s)event=([^\s]+)') { $$event = $$Matches[2] } else { $$first = @($$message -split '\s+', 2)[0]; if ($$first -and $$first -notmatch '=') { $$event = $$first } }; \
    $$payload = [ordered]@{ schemaVersion = 1; ts = (Get-Date -Format o); session = $$session; version = '${VERSION}'; arch = '${MU_TARGET_ARCH}'; updated = ('$MuIsUpdated' -eq '1'); instDir = '$INSTDIR'; event = $$event; message = $$message }; \
    $$json = $$payload | ConvertTo-Json -Compress -Depth 8; \
    Add-Content -LiteralPath $$log -Encoding UTF8 -Value $$json \
  }"`
  Pop $9
  Pop $9
!macroend

!macro MU_LOG_JSON_EVENT _EVENT _JSON_FIELDS
  Push $9
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
    $$ErrorActionPreference = 'SilentlyContinue'; \
    $$log = '$MuSessionLogPath'; \
    if (-not $$log) { $$log = Join-Path $$env:TEMP '${MU_FALLBACK_LOG}' }; \
    $$session = '$MuSessionId'; \
    if (-not $$session) { $$session = 'uninitialized' }; \
    $$payload = [ordered]@{ schemaVersion = 1; ts = (Get-Date -Format o); session = $$session; version = '${VERSION}'; arch = '${MU_TARGET_ARCH}'; updated = ('$MuIsUpdated' -eq '1'); instDir = '$INSTDIR'; event = '${_EVENT}' }; \
    ${_JSON_FIELDS}; \
    $$json = $$payload | ConvertTo-Json -Compress -Depth 8; \
    Add-Content -LiteralPath $$log -Encoding UTF8 -Value $$json \
  }"`
  Pop $9
  Pop $9
!macroend

!macro MU_SESSION_BEGIN
  ${GetParameters} $R9
  ClearErrors
  ${GetOptions} $R9 "--installer-log=" $R8
  ${IfNot} ${Errors}
    StrCpy $MuSessionLogPath $R8
  ${EndIf}
  ClearErrors
  ${GetOptions} $R9 "--installer-session=" $R8
  ${IfNot} ${Errors}
    StrCpy $MuSessionId $R8
  ${EndIf}

  ${If} $MuSessionLogPath == ""
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$id = '$MuSessionId'; if (-not $$id) { $$id = [guid]::NewGuid().ToString('N').Substring(0,12) }; $$stamp = Get-Date -Format 'yyyyMMdd'; $$name = 'mu-installer-${VERSION}-' + $$stamp + '-log.jsonl'; $$log = Join-Path $$env:TEMP $$name; [Console]::Out.Write($$id + '|' + $$log)"`
    Pop $MuSessionLogResult
    Pop $MuSessionLogResult
    StrCpy $MuSessionId $MuSessionLogResult 12
    StrCpy $MuSessionLogPath $MuSessionLogResult 1024 13
  ${ElseIf} $MuSessionId == ""
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "[Console]::Out.Write([guid]::NewGuid().ToString('N').Substring(0,12))"`
    Pop $MuSessionLogResult
    Pop $MuSessionLogResult
    StrCpy $MuSessionId $MuSessionLogResult
  ${EndIf}

  ClearErrors
  ${GetOptions} $R9 "--updated" $R8
  StrCpy $MuIsUpdated "0"
  ${IfNot} ${Errors}
    StrCpy $MuIsUpdated "1"
  ${EndIf}

  !insertmacro MU_SLOG "event=session-begin detail=preInit"
!macroend

!macro MU_LOG_EXTRACT_RESULT _METHOD
  ${IfNot} ${FileExists} "$INSTDIR\${MU_APP_EXECUTABLE_FILENAME}"
    !insertmacro MU_FAIL_UX \
      "${MU_E_EXTRACT_FAILED}" \
      "event=extract result=fail method=${_METHOD} missing=${MU_APP_EXECUTABLE_FILENAME}" \
      "${MU_MSG_EXTRACT_FAILED_ZH}" \
      "${MU_MSG_EXTRACT_FAILED_EN}" \
      "${MU_MSG_EXTRACT_FAILED_ACTION_ZH}" \
      "${MU_MSG_EXTRACT_FAILED_ACTION_EN}" \
      "extract result=fail method=${_METHOD} missing=${MU_APP_EXECUTABLE_FILENAME} instDir=$INSTDIR" \
      "extract result=fail method=${_METHOD} missing=${MU_APP_EXECUTABLE_FILENAME} instDir=$INSTDIR"
  ${Else}
    !insertmacro MU_SLOG "event=extract result=ok method=${_METHOD} detail=customFiles_${MU_TARGET_ARCH}"
  ${EndIf}
!macroend

!macro MU_SESSION_SUCCESS
  !insertmacro MU_SLOG "event=session-end result=success detail=customInstall"
!macroend

!endif
