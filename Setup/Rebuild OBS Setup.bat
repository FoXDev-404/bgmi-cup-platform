@echo off
REM =====================================================================
REM  Rebuild / repair the OBS setup (profile "BGMI Cup", collection
REM  "BGMI Cup v2"). Safe to re-run any time.
REM
REM  Run this after connecting a new camera, after the phone mirror is
REM  up (so it binds the phone window + game audio), or when
REM  "4 - Check Everything.bat" reports something red about the OBS setup.
REM
REM  It closes OBS, fixes the collection, and reopens OBS.
REM  It NEVER starts a stream.
REM
REM  Extra options (run from a terminal):  --cameras 2 | --fps 30 |
REM  --no-restart | --help
REM =====================================================================
setlocal
chcp 65001 >nul
title BGMI Cup - Rebuild OBS Setup

call "%~dp0..\scripts\obs\setup_obs.bat" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo Rebuild finished with problems ^(exit %RC%^) - read the messages above.
) else (
  echo Rebuild finished. Now run "4 - Check Everything.bat" to confirm.
)
echo %cmdcmdline% | find /i "%~nx0" >nul
if not errorlevel 1 pause
exit /b %RC%
