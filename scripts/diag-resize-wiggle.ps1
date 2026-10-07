# Resize-clone probe: boot the REAL CLI in a REAL conhost, wiggle the width
# like a user drag (120 -> 100 -> 120), and watch WindowTop. Clones appended
# to the buffer push the viewport; a clean resize keeps it flat.
#
# Run inside a REAL conhost:
#   conhost.exe powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\diag-resize-wiggle.ps1
$ErrorActionPreference = "Continue"
$log = Join-Path $env:TEMP "resize-wiggle.log"
Remove-Item $log -ErrorAction SilentlyContinue
function W($m) { Add-Content -Path $log -Value $m }
trap { W ("TRAP: " + $_.Exception.Message); exit 1 }

$cli = "C:\Users\engli\AppData\Roaming\npm\node_modules\@skt-ai-labs\trayambak-cli\dist\apps\cli\src\index.js"
if (-not (Test-Path $cli)) { W "NO_CLI_ENTRY"; exit 1 }

$env:TRAYAMBAK_RESIZE_DEBUG = "1"
$env:TRAYAMBAK_RESIZE_LOG = (Join-Path $env:TEMP "resize-wiggle-guard.log")
Remove-Item $env:TRAYAMBAK_RESIZE_LOG -ErrorAction SilentlyContinue

W "console: $([Console]::WindowWidth)x$([Console]::WindowHeight) buffer=$([Console]::BufferHeight) top=$([Console]::WindowTop)"
$proc = Start-Process -FilePath "node.exe" -ArgumentList $cli -NoNewWindow -PassThru -WorkingDirectory $env:TEMP
W "started pid=$($proc.Id)"
Start-Sleep -Seconds 4
if ($proc.HasExited) { W "CLI EXITED EARLY"; exit 1 }
$t0 = [int][Console]::WindowTop
W "settled top=$t0"

# Wiggle: narrow, settle, widen back - the exact user gesture.
& "$env:SystemRoot\System32\mode.com" con: cols=100 | Out-Null
W "narrowed to $([Console]::WindowWidth)"
Start-Sleep -Seconds 3
$tn = [int][Console]::WindowTop
& "$env:SystemRoot\System32\mode.com" con: cols=120 | Out-Null
W "widened to $([Console]::WindowWidth)"
Start-Sleep -Seconds 4
$t1 = [int][Console]::WindowTop
W "final top=$t1 (started $t0, after narrow $tn)"
W "drift narrow-phase=$($tn - $t0) drift total=$($t1 - $t0)"

if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
W "guard log:"
if (Test-Path $env:TRAYAMBAK_RESIZE_LOG) {
  Get-Content $env:TRAYAMBAK_RESIZE_LOG | Select-Object -Last 12 | ForEach-Object { W ("  " + $_) }
} else {
  W "  (no guard log - env did not reach the child?)"
}
if (($t1 - $t0) -gt 3) { W "WIGGLE_LEAK" } else { W "WIGGLE_OK" }
exit 0