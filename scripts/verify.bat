@echo off
rem ============================================================================
rem  One-command verification for the BGMI project (Windows).
rem
rem  Runs, in order:
rem    1. python tests\test_api.py / test_admin.py / test_broadcast.py /
rem       test_flow.py / test_seed.py
rem       (each hosts its own throw-away server + DB)
rem    2. npx playwright test            (specs host their own server + DB)
rem    3. the ten stage scripts in tests\e2e\, each against a freshly seeded
rem       throw-away DB on http://127.0.0.1:8090
rem
rem  Nothing here touches data\registrations.db, .env or the live 8080 demo
rem  server; the throw-away DB lives in %TEMP%\opencode\bgmi-verify.
rem  Exits 0 only when everything is green.
rem ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0.."

set "VDIR=%TEMP%\opencode\bgmi-verify"
if not "%VDIR%"=="%VDIR: =%" (
  echo [verify] %VDIR% contains spaces - use scripts\verify.sh instead.
  exit /b 2
)

if not exist "%VDIR%" mkdir "%VDIR%"
if not exist "%VDIR%\uploads" mkdir "%VDIR%\uploads"
set "FAILED="

rem Phases A/B below (python suites + specs) each host their OWN throw-away
rem server+DB. Clear every variable that could point them at the 8090 instance
rem instead - BASE switches the suites into remote mode, which would share its
rem rate-limit buckets and its database with the stage run.
set "BASE="
set "PORT="
set "BGMI_DB="
set "BGMI_UPLOADS="
set "BGMI_ADMIN_USER="
set "BGMI_ADMIN_PASSWORD="
set "VERIFY_ADMIN_USER="
set "VERIFY_ADMIN_PASSWORD="
set "BGMI_RATE_LIMIT_TEST="

echo ==== python suites ====
python tests\test_api.py || set "FAILED=!FAILED! test_api"
python tests\test_admin.py || set "FAILED=!FAILED! test_admin"
python tests\test_broadcast.py || set "FAILED=!FAILED! test_broadcast"
python tests\test_flow.py || set "FAILED=!FAILED! test_flow"
python tests\test_seed.py || set "FAILED=!FAILED! test_seed"

echo ==== playwright specs ====
call npx playwright test --reporter=line || set "FAILED=!FAILED! playwright"

rem Phase C env: the stage scripts run against the one shared 8090 instance on
rem purpose (see the reset routine at the bottom).
set "BGMI_DB=%VDIR%\verify.db"
set "BGMI_UPLOADS=%VDIR%\uploads"
set "PORT=8090"
set "BGMI_ADMIN_USER=verifyadmin"
set "BGMI_ADMIN_PASSWORD=verify-pass-2026"
set "VERIFY_ADMIN_USER=verifyadmin"
set "VERIFY_ADMIN_PASSWORD=verify-pass-2026"

for %%S in (public-site registration-flows status-lookup admin-flows ^
            matches-flows control-desk desk-layout flow-sidebar scoring-check ^
            overlays security-a11y) do (
  call :reset
  if errorlevel 1 (
    echo [verify] could not reset the environment - aborting
    exit /b 1
  )
  echo ==== stage %%S ====
  node "tests\e2e\%%S.js" http://127.0.0.1:8090 || set "FAILED=!FAILED! %%S"
)
call :stop

if defined FAILED (
  echo.
  echo FAILED:!FAILED!
  exit /b 1
)
echo.
echo ALL GREEN
exit /b 0

:stop
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8090 " ^| findstr LISTENING') do taskkill /F /PID %%p >nul 2>&1
exit /b 0

:reset
call :stop
del /q "%VDIR%\verify.db" >nul 2>&1
rmdir /s /q "%VDIR%\uploads" >nul 2>&1
mkdir "%VDIR%\uploads" >nul 2>&1
python scripts\seed_demo.py >nul || exit /b 1
python scripts\create_admin.py >nul || exit /b 1
powershell -NoProfile -Command "Start-Process -FilePath 'python' -ArgumentList 'server.py' -WorkingDirectory '%CD%' -WindowStyle Hidden -RedirectStandardOutput '%VDIR%\server.log' -RedirectStandardError '%VDIR%\server.err'"
set /a tries=0
:wait
set /a tries+=1
python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8090/api/live/state',timeout=1)" >nul 2>&1 && exit /b 0
if !tries! gtr 50 (
  echo [verify] server did not come up - see "%VDIR%\server.log"
  exit /b 1
)
ping 127.0.0.1 -n 2 >nul
goto :wait
