@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0import-feishu-config.ps1" %*
exit /b %errorlevel%
