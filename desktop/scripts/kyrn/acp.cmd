@echo off
rem Starts mu's ACP adapter on Windows: the backend runs this file as the command of mu's registration.
rem Everything is in acp.mjs next to it. Keep this file ASCII: cmd reads it in the console's code page.
node "%~dp0acp.mjs" %*
exit /b %errorlevel%
