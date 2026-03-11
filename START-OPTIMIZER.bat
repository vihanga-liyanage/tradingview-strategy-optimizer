@echo off
title TradingView Strategy Optimizer
set "NODE=C:\Program Files\nodejs"
set "PATH=%NODE%;%PATH%"
cd /d "%~dp0"

echo.
echo  Starting optimizer - leave the browser window open until it finishes.
echo  CLI args passed through: %*
echo.
node runner.js %*

pause
