@echo off
setlocal
cd /d "%~dp0"

echo Starting TV Strategy Optimizer...
npm.cmd start

if errorlevel 1 (
  echo.
  echo Launch failed. Make sure dependencies are installed:
  echo   npm.cmd install
  pause
)

endlocal
