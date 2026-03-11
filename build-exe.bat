@echo off
setlocal
cd /d "%~dp0"

echo Installing dependencies (if needed)...
npm.cmd install
if errorlevel 1 goto :fail

echo Building Windows portable EXE...
npm.cmd run build:win
if errorlevel 1 goto :fail

echo.
echo Build complete. Check the dist folder.
pause
endlocal
exit /b 0

:fail
echo.
echo Build failed. Scroll up for errors.
pause
endlocal
exit /b 1
