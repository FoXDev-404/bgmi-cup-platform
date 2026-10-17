@echo off
REM =====================================================================
REM  BGMI Cup v2 - build / repair the OBS broadcast setup (idempotent).
REM
REM  Double-click this file, or run it from a terminal with options:
REM      setup_obs.bat                 rebuild everything (safe to re-run)
REM      setup_obs.bat --cameras 2     re-detect / force the number of cams
REM      setup_obs.bat --fps 30        weak machine fallback
REM      setup_obs.bat --no-restart    quick tweak without relaunching OBS
REM      setup_obs.bat --help          all options
REM
REM  It exits OBS gracefully, patches the scene collection, writes the
REM  token-free export, and relaunches OBS. It NEVER starts a stream.
REM =====================================================================
setlocal
chcp 65001 >nul

set "HERE=%~dp0"
set "PY=%HERE%.venv\Scripts\python.exe"
if not exist "%PY%" (
  set "PY=python"
  echo [!] scripts\obs\.venv not found - run scripts\obs\setup_env.ps1 once.
  echo     Falling back to system python ^(needs websocket-client installed^).
)

"%PY%" "%HERE%setup_obs.py" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo Setup finished with problems ^(exit %RC%^) - read the warnings above.
) else (
  echo Setup finished successfully.
)

REM Keep the window open when this file was double-clicked (not run from a
REM terminal) so the output stays readable.
echo %cmdcmdline% | find /i "%~nx0" >nul
if not errorlevel 1 pause
exit /b %RC%
