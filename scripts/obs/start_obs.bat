@echo off
REM Start OBS with the BGMI Cup profile + scene collection (idempotent).
REM If OBS is already running it just says so - never starts a second copy.
setlocal
set OBS_DIR=C:\Program Files\obs-studio\bin\64bit
if not exist "%OBS_DIR%\obs64.exe" set OBS_DIR=C:\Program Files (x86)\obs-studio\bin\64bit
if not exist "%OBS_DIR%\obs64.exe" (
  echo obs64.exe not found - is OBS installed?
  pause
  exit /b 1
)
if not exist "%APPDATA%\obs-studio\basic\scenes\BGMI_Cup_v2.json" (
  echo [!] "BGMI Cup v2" is not built on this machine yet - OBS will show the
  echo     old/default collection. Run "Rebuild OBS Setup.bat" from the
  echo     Setup folder once first - it creates the 16 broadcast scenes.
)
tasklist /FI "IMAGENAME eq obs64.exe" | find /I "obs64.exe" >nul
if not errorlevel 1 (
  echo OBS is already running.
  exit /b 0
)
echo Starting OBS (profile "BGMI Cup", collection "BGMI Cup v2")...
start "" /D "%OBS_DIR%" "%OBS_DIR%\obs64.exe" --profile "BGMI Cup" --collection "BGMI Cup v2" --disable-shutdown-check
exit /b 0
