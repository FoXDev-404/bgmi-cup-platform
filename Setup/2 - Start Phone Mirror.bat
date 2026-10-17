@echo off
REM =====================================================================
REM  2 - Show the phone screen on this PC (scrcpy, window "BGMI-PHONE").
REM
REM  Plug the phone in with USB and unlock it once BEFORE running this.
REM  The window title must stay "BGMI-PHONE" - the OBS source tracks it.
REM  Options: -Fps 30  -Force  -Test   (details: docs\obs-runbook.md)
REM =====================================================================
setlocal
chcp 65001 >nul
title BGMI Cup - Phone Mirror

call "%~dp0..\scripts\obs\start_phone_capture.bat" %*
set "RC=%ERRORLEVEL%"

echo.
echo Phone mirror finished (exit %RC%).
echo If it failed: phone connected + unlocked + USB debugging allowed?
echo %cmdcmdline% | find /i "%~nx0" >nul
if not errorlevel 1 pause
exit /b %RC%
