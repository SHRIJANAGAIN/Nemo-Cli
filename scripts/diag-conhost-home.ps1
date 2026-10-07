# Decisive probe: what does ESC[H do on a real conhost that has scrollback?
#
# The resize-guard anchor writes ESC[2J ESC[H then a full frame. If ESC[H is
# viewport-relative, the frame lands where the user looks. If it is
# buffer-top (row 0 of the whole scrollback), the frame is written over
# ancient history and the viewport jumps there - which reads as clones /
# duplication on the user's screen.
#
# Run inside a REAL conhost:
#   conhost.exe powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\diag-conhost-home.ps1
$ErrorActionPreference = "Continue"
$log = Join-Path $env:TEMP "conhost-home.log"
Remove-Item $log -ErrorAction SilentlyContinue
function W($m) { Add-Content -Path $log -Value $m }
trap { W ("TRAP: " + $_.Exception.Message); exit 1 }

$ESC = [char]27
$out = [Console]::Out
$w = [Console]::WindowWidth
$h = [Console]::WindowHeight
W "console: cols=$w rows=$h buffer=$([Console]::BufferHeight) top=$([Console]::WindowTop)"

# 1. Fill scrollback: 60 marker lines, then settle at the bottom.
for ($i = 1; $i -le 60; $i++) { $out.Write("MARKER line $i`r`n") }
$out.Flush()
Start-Sleep -Milliseconds 300
$bottom = [Console]::BufferHeight - [Console]::WindowHeight
W "after fill: buffer=$([Console]::BufferHeight) top=$([Console]::WindowTop) bottom=$bottom"

# 2. ESC[H alone - where does the viewport go?
$out.Write("$ESC[H")
$out.Flush()
Start-Sleep -Milliseconds 300
W "after ESC[H: top=$([Console]::WindowTop) (0 = buffer-top semantics, $bottom = viewport-relative)"

# 3. Back to bottom, then the real anchor sequence ESC[2J ESC[H.
[Console]::SetWindowPosition(0, [Console]::BufferHeight - [Console]::WindowHeight)
Start-Sleep -Milliseconds 200
W "reset to bottom: top=$([Console]::WindowTop)"
$out.Write("$ESC[2J$ESC[H")
$out.Flush()
Start-Sleep -Milliseconds 300
W "after 2J+H: top=$([Console]::WindowTop) buffer=$([Console]::BufferHeight)"

# 4. Write a 5-line frame at the cursor and see where it lands.
for ($i = 1; $i -le 5; $i++) { $out.Write("FRAME row $i`r`n") }
$out.Flush()
Start-Sleep -Milliseconds 300
W "after frame write: top=$([Console]::WindowTop) buffer=$([Console]::BufferHeight)"
W "DONE"
exit 0