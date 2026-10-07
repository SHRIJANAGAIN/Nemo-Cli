# Replay a known-good UTF-8 boot capture through a REAL console at the user's
# geometry and report whether frames end up stacked.
#
# Two failure modes this measures:
#   1. scrollback growth  -> rows pushed above the window (WindowTop climbs)
#   2. stacked frames     -> read the visible window back and count top borders
# Logs before touching the console so a hang is still diagnosable.
$ErrorActionPreference = "Continue"
$log = Join-Path $env:TEMP "replay2.log"
Remove-Item $log -ErrorAction SilentlyContinue
function W($m) { Add-Content -Path $log -Value $m }

W "START args=$($args -join ' ')"
$cols = if ($args.Count -ge 1) { [int]$args[0] } else { 115 }
$rows = if ($args.Count -ge 2) { [int]$args[1] } else { 37 }
$chunk = if ($args.Count -ge 3) { [int]$args[2] } else { 2500 }
$src = if ($args.Count -ge 4) { $args[3] } else { (Join-Path $env:TEMP "boot-utf8.bin") }

try {
  & "$env:SystemRoot\System32\mode.com" con: cols=$cols lines=$rows 2>&1 | Out-Null
  W "mode ok"
} catch {
  W "mode failed: $($_.Exception.Message)"
}
Start-Sleep -Milliseconds 400

$w = [Console]::WindowWidth
$r = [Console]::WindowHeight
W "window=${w}x${r} buffer=$([Console]::BufferWidth)x$([Console]::BufferHeight) top=$([Console]::WindowTop)"

if (-not (Test-Path $src)) { W "MISSING $src"; exit 1 }
$fs = New-Object IO.FileStream($src, [IO.FileMode]::Open, [IO.FileAccess]::Read)
$sr = New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)
$raw = $sr.ReadToEnd()
$sr.Close()
W "stream=$($raw.Length) chars chunk=$chunk"

$h = [Console]::OpenStandardOutput()
$startTop = [Console]::WindowTop
$tops = @()
for ($i = 0; $i -lt $raw.Length; $i += $chunk) {
  $len = [Math]::Min($chunk, $raw.Length - $i)
  $b = [Text.Encoding]::UTF8.GetBytes($raw.Substring($i, $len))
  $h.Write($b, 0, $b.Length)
  $h.Flush()
  Start-Sleep -Milliseconds 60
  $tops += [Console]::WindowTop
}
$drift = [Console]::WindowTop - $startTop
W "tops=$($tops -join ',')"
W "drift=$drift"
W "final top=$([Console]::WindowTop) left=$([Console]::WindowLeft)"
W "REPLAY_DONE"
exit 0
