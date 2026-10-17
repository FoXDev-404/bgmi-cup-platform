@echo off
rem BGMI Cup - phone mirror launcher (double-click friendly).
rem Usage: start_phone_capture.bat [-Test] [-Fps 30] [-Force]
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_phone_capture.ps1" %*
endlocal
