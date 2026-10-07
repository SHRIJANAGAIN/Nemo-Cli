# End-to-end boot-leak probe against the REAL CLI in a REAL conhost.
#
# The leak shows as the idle WelcomeScreen's 500ms repaints PUSHING the
# console buffer: every push scrolls the window, so [Console]::WindowTop
# climbs ~1 row per repaint. A healthy boot keeps it flat.
#
# Run inside a REAL conhost:
#   conhost.exe powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\diag-live-boot.ps1 [seconds]
$ErrorActionPreference = "Continue"
$log = Join-Path $env:TEMP "live-boot.log"
Remove-Item $log -ErrorAction SilentlyContinue
function W($m) { Add-Content -Path $log -Value $m }
trap { W ("TRAP: " + $_.Exception.Message); exit 1 }

$seconds = if ($args.Count -ge 1) { [int]$args[0] } else { 12 }
W "console: cols=$([Console]::WindowWidth) rows=$([Console]::WindowHeight) buffer=$([Console]::BufferHeight) top=$([Console]::WindowTop)"

$cli = "C:\Users\engli\AppData\Roaming\npm\node_modules\@skt-ai-labs\trayambak-cli\dist\apps\cli\src\index.js"
if (-not (Test-Path $cli)) { W "NO_CLI_ENTRY $cli"; exit 1 }
W "cli entry: $cli"

$start = Get-Date
# TRAYAMBAK_TRACE=1 tees every stdout byte to trayambak-trace.log in the cwd -
# ground truth for what the real console actually received.
$traceDir = if ($args.Count -ge 5 -and $args[4]) { [string]$args[4] } else { Join-Path $env:TEMP "tb-boot-trace" }
New-Item -ItemType Directory -Path $traceDir -Force | Out-Null
Get-ChildItem $traceDir -Filter trayambak-trace.log -ErrorAction SilentlyContinue | Remove-Item -Force
$env:TRAYAMBAK_TRACE = "1"
$proc = Start-Process -FilePath "node.exe" -ArgumentList $cli -NoNewWindow -PassThru -WorkingDirectory $traceDir
W "started pid=$($proc.Id) trace=$traceDir"

$samples = New-Object System.Collections.Generic.List[int]
$exited = $false
# Optional mid-run width change: this is the trigger the resize-guard exists
# for. Full-width border rows reflow into two rows at the narrower width and
# ink's line-count erase starts missing the old frame (frames pile up).
$resizeAt = if ($args.Count -ge 2) { [double]$args[1] } else { 0 }
$newCols = if ($args.Count -ge 3) { [int]$args[2] } else { 100 }
$resizeKind = if ($args.Count -ge 4) { [string]$args[3] } else { "cols" }
$didResize = $false
while (((Get-Date) - $start).TotalSeconds -lt $seconds) {
  Start-Sleep -Milliseconds 250
  if ($proc.HasExited) { $exited = $true; break }
  if (-not $didResize -and ((Get-Date) - $start).TotalSeconds -ge $resizeAt) {
    $didResize = $true
    $beforeW = [Console]::WindowWidth
    $beforeH = [Console]::WindowHeight
    if ($resizeKind -eq "rows") {
      & "$env:SystemRoot\System32\mode.com" con: lines=$newCols | Out-Null
    } else {
      & "$env:SystemRoot\System32\mode.com" con: cols=$newCols lines=$beforeH | Out-Null
    }
    W "RESIZE($resizeKind) issued: ${beforeW}x${beforeH} -> $([Console]::WindowWidth)x$([Console]::WindowHeight) at t=$([Math]::Round(((Get-Date) - $start).TotalSeconds, 1))s"
    continue
  }
  $samples.Add([int][Console]::WindowTop)
}
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
W "cli exited early: $exited"
W "samples: $($samples -join ',')"
$distinct = ($samples | Select-Object -Unique) -join ','
W "distinct windowTop values: $distinct"
# One-time growth is NOT the leak: a boot notice that grows the frame scrolls
# the buffer once and then settles. The leak is CONTINUOUS drift - still
# climbing in the last third of the run (one row per 500ms repaint).
$tail = [Math]::Max(2, [Math]::Floor($samples.Count / 3))
$tailClimb = 0
for ($i = $samples.Count - $tail + 1; $i -lt $samples.Count; $i++) {
  if ($samples[$i] -gt $samples[$i - 1]) { $tailClimb += ($samples[$i] - $samples[$i - 1]) }
}
$totalClimb = 0
for ($i = 1; $i -lt $samples.Count; $i++) { if ($samples[$i] -gt $samples[$i - 1]) { $totalClimb += ($samples[$i] - $samples[$i - 1]) } }
W "total upward scroll: $totalClimb row(s); steady-state (last third) climb: $tailClimb"
$verdict = if ($tailClimb -gt 0) { "LIVE_LEAK (idle repaints keep scrolling the buffer)" } elseif ($exited) { "INCONCLUSIVE (cli exited)" } else { "LIVE_OK (settles flat)" }
W $verdict
exit 0