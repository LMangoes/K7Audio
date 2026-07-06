@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found on PATH. Install from https://nodejs.org, then re-run this file.
  pause
  exit /b 1
)

call npm install
if errorlevel 1 (
  echo npm install failed - see errors above.
  pause
  exit /b 1
)

echo Setup complete. Use launch.vbs to start K7 Audio ^(no console window^).
pause
