@echo off
REM =====================================================================
REM  4 - Check the whole setup (green/red). Wait until it prints READY.
REM
REM  Verifies every scene, its own browser source + URL + token, camera
REM  positions, audio, hotkeys, transition, and (optionally) fps/CPU.
REM  Extra options (run from a terminal):  --quick  --keys  --shots
REM  --soak 120
REM =====================================================================
setlocal
chcp 65001 >nul
title BGMI Cup - Check Everything

call "%~dp0..\scripts\obs\check_obs.bat" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo Something is RED above - fix it before going live, or run
  echo "Rebuild OBS Setup.bat" and check again.
) else (
  echo READY - nothing red. Have a good show!
)
echo %cmdcmdline% | find /i "%~nx0" >nul
if not errorlevel 1 pause
exit /b %RC%
