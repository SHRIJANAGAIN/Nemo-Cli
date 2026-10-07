# Real-conhost replay probe for the boot frame leak - WindowTop based, no
# P/Invoke (the ReadConsoleOutputCharacter path hard-crashes the host).
#
# How it detects the leak: the console buffer is shrunk to EXACTLY the window
# size (no scrollback), so any write that pushes the buffer scrolls it - and
# the scrolled window position is readable as [Console]::WindowTop. The byte
# stream is replayed in tick-sized chunks and WindowTop is sampled after each
# one:
#   - repaints that rewrite in place  -> WindowTop flat
#   - repaints that push the buffer   -> WindowTop climbs ~1 per tick (leak)
#
# Run inside a REAL conhost:
#   conhost.exe powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\diag-conhost-replay.ps1 [chunkRows]
$ErrorActionPreference = "Stop"
$bytesPath = Join-Path $env:TEMP "trayambak-boot-bytes.bin"
$log = Join-Path $env:TEMP "conhost-replay.log"
Remove-Item $log -ErrorAction SilentlyContinue
function W($m) { Add-Content -Path $log -Value $m }
trap {
  W ("TRAP: " + $_.Exception.GetType().Name + ": " + $_.Exception.Message)
  W ("AT: " + $_.InvocationInfo.Line.Trim())
  exit 1
}

# Split the stream into per-tick chunks: each chunk is one full-frame repaint
# (ink writes them back-to-back). Chunking on the erase that precedes a frame
# keeps chunks aligned with renders instead of with byte counts.
$chunkRows = if ($args.Count -ge 1) { [int]$args[0] } else { 6000 }
$raw = [IO.File]::ReadAllText($bytesPath, [Text.Encoding]::Default)
W "stream: $($raw.Length) chars, chunk=$chunkRows"

# Optional: shrink the window first, so a stream captured for a TALLER window
# lands in a window that can no longer hold it - the exact post-shrink state
# the resize guard has to re-anchor.
$shrinkTo = if ($args.Count -ge 2) { [int]$args[1] } else { 0 }
if ($shrinkTo -gt 0) {
  & "$env:SystemRoot\System32\mode.com" con: lines=$shrinkTo | Out-Null
  Start-Sleep -Milliseconds 200
  W "window shrunk to $([Console]::WindowWidth)x$([Console]::WindowHeight)"
}

$h = [Console]::OpenStandardOutput()
$w = [Console]::WindowWidth
$r = [Console]::WindowHeight
W "console: cols=$w rows=$r buffer=$([Console]::BufferHeight) top=$([Console]::WindowTop)"

# Buffer == window: every pushed line becomes a scroll we can see.
try { [Console]::SetConsoleScreenBufferSize($w, $r) } catch { W "resize-shrink-failed: $($_.Exception.Message)" }
W "after shrink: buffer=$([Console]::BufferHeight) top=$([Console]::WindowTop)"

$startTop = [Console]::WindowTop
$tops = @()
for ($i = 0; $i -lt $raw.Length; $i += $chunkRows) {
  $len = [Math]::Min($chunkRows, $raw.Length - $i)
  $bytes = [Text.Encoding]::Default.GetBytes($raw.Substring($i, $len))
  $h.Write($bytes, 0, $bytes.Length)
  $h.Flush()
  Start-Sleep -Milliseconds 120
  $tops += [Console]::WindowTop
}
W "windowTop after each chunk: $($tops -join ',')"
$drift = [Console]::WindowTop - $startTop
W "total drift: $drift row(s) over $($tops.Count) chunks"
$verdict = if ($drift -gt 0) { "REPLAY_LEAK (frame pushes the buffer every repaint)" } else { "REPLAY_OK (in-place repaint)" }
W $verdict
exit 0