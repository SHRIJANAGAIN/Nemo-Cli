# Install nemo dependencies and build.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..
npm install --no-audit --no-fund
npm run build
Write-Output "nemo built at dist/packages/cli/src/index.js"
