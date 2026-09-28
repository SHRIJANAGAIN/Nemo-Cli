# Install trayambak dependencies and build.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..
npm install --no-audit --no-fund
npm run build
Write-Output "trayambak built at dist/packages/cli/src/index.js"
