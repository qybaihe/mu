@echo off
rem mu's ACP adapter in the packaged app (Windows). The backend runs this file as the command of mu's registration.
rem The adapter (app.asar.unpacked\out\main\mu-acp.js) and mu itself (harness\mu-agent) run on the app's own
rem mu.exe as Node, so no Node has to be installed. MU_NODE, when set, runs them on that Node instead.
rem Keep this file ASCII: cmd reads it in the console's code page.
if defined MU_NODE (
  "%MU_NODE%" "%~dp0..\app.asar.unpacked\out\main\mu-acp.js" %*
) else (
  set ELECTRON_RUN_AS_NODE=1
  "%~dp0..\..\mu.exe" "%~dp0..\app.asar.unpacked\out\main\mu-acp.js" %*
)
exit /b %errorlevel%
