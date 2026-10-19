@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo First run: run npm ci in this folder, then launch this file again.
  pause
  exit /b 1
)
call npm.cmd run build
if errorlevel 1 (
  pause
  exit /b 1
)
call npm.cmd start
pause
