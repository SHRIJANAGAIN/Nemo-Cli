# Install trayambak on Windows (PowerShell).
# Usage: irm <raw-url>/install.ps1 | iex   (or: .\install.ps1 from the repo root)
$ErrorActionPreference = "Stop"

$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
Set-Location $root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node >= 18 is required (https://nodejs.org)" }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is required" }

npm install --no-audit --no-fund
npm run build

node scripts/install-global.js
