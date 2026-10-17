@echo off
REM =====================================================================
REM  BGMI Cup v2 - OBS readiness check (green/red, one line per rule).
REM
REM  Double-click this file, or run it from a terminal with options:
REM      check_obs.bat              full check (takes ~1 minute)
REM      check_obs.bat --quick      skip the scene-switching probes
REM      check_obs.bat --keys       press F1 + Ctrl+F3 to prove hotkeys
REM      check_obs.bat --shots      screenshot every scene into
REM                                 docs\obs\screenshots\v2
REM      check_obs.bat --soak 120   2-minute fps / CPU / GPU sample
REM      check_obs.bat --help       all options
REM
REM  Prints READY when nothing is red. Never starts a stream and never
REM  prints the overlay token.
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

"%PY%" "%HERE%check_obs.py" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo Check finished with problems ^(exit %RC%^) - read the [fail] lines above.
) else (
  echo All checks passed - the setup is READY.
)

REM Keep the window open when this file was double-clicked (not run from a
REM terminal) so the output stays readable.
echo %cmdcmdline% | find /i "%~nx0" >nul
if not errorlevel 1 pause
exit /b %RC%
