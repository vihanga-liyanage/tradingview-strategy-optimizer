# TradingView Strategy Optimizer - Install script
# Run this in PowerShell (right-click -> Run with PowerShell, or open PowerShell and run .\install.ps1)

$ErrorActionPreference = "Stop"
$nodePath = "C:\Program Files\nodejs"

Write-Host "Adding Node.js to PATH for this session..." -ForegroundColor Cyan
$env:Path = "$nodePath;$env:Path"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js not found at $nodePath" -ForegroundColor Red
    Write-Host "Install Node.js from https://nodejs.org/ (v18 or later), then run this script again." -ForegroundColor Yellow
    exit 1
}

Write-Host "Node: $(node -v)" -ForegroundColor Green
Write-Host "npm:  $(npm -v)" -ForegroundColor Green

Set-Location $PSScriptRoot

Write-Host "`nInstalling npm packages..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`nInstalling Playwright Chromium (this may take a minute)..." -ForegroundColor Cyan
npx playwright install chromium
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`nDone. You can run: node runner.js" -ForegroundColor Green
