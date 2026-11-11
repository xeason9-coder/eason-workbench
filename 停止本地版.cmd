@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0本地服务.ps1" -Action Stop
exit /b %ERRORLEVEL%
