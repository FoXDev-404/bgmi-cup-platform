@echo off
REM =====================================================================
REM  3 - Start OBS with the "BGMI Cup v2" scene collection.
REM
REM  Never starts a second copy - if OBS is already open it says so.
REM  Once OBS is open, run "4 - Check Everything.bat".
REM =====================================================================
setlocal
chcp 65001 >nul
title BGMI Cup - Start OBS

call "%~dp0..\scripts\obs\start_obs.bat" %*
set "RC=%ERRORLEVEL%"

echo.
echo Done (exit %RC%). Next step: run "4 - Check Everything.bat".
echo %cmdcmdline% | find /i "%~nx0" >nul
if not errorlevel 1 pause
exit /b %RC%
