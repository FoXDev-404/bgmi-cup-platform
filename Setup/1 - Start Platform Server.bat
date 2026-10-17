@echo off
REM =====================================================================
REM  1 - Start the BGMI Cup platform server (http://127.0.0.1:8080).
REM
REM  Double-click this file. If the server is already running it just
REM  says so. Keep the window open while you broadcast - this is the
REM  website + overlay backend that OBS talks to.
REM =====================================================================
setlocal
chcp 65001 >nul
title BGMI Cup - Platform Server

cd /d "%~dp0.."

netstat -ano | findstr /C:":8080 " | findstr /C:"LISTENING" >nul
if not errorlevel 1 (
  echo The platform server is ALREADY RUNNING on http://127.0.0.1:8080
  echo Nothing to do - open http://127.0.0.1:8080 in your browser if needed.
  echo.
  echo %cmdcmdline% | find /i "%~nx0" >nul
  if not errorlevel 1 pause
  exit /b 0
)

set "PY=%~dp0..\scripts\obs\.venv\Scripts\python.exe"
if not exist "%PY%" (
  set "PY=python"
  echo NOTE: scripts\obs\.venv not found - using the system python.
)

echo Starting the platform server... keep this window open.
echo Close this window or press Ctrl+C to stop the server.
echo.
"%PY%" server.py
set "RC=%ERRORLEVEL%"

echo.
echo Server stopped (exit %RC%). Double-click this file again to restart it.
echo %cmdcmdline% | find /i "%~nx0" >nul
if not errorlevel 1 pause
exit /b %RC%
