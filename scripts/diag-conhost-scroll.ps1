# Conhost scroll-physics probe: does a legacy conhost HOLD a manually-scrolled
# window position while an ink-style writer repaints a bottom-anchored frame,
# or does it YANK back to the caret? Also probes the 2J/3J/H full-clear storm.
# Run inside a REAL conhost:  conhost.exe powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\diag-conhost-scroll.ps1
$log = Join-Path $env:TEMP "conhost-scroll.log"
Remove-Item $log -ErrorAction SilentlyContinue
function W($m) { Add-Content -Path $log -Value $m }

$ESC = [char]27
try {
  W "start: bufH=$([Console]::BufferHeight) winH=$([Console]::WindowHeight) winTop=$([Console]::WindowTop) cols=$([Console]::WindowWidth)"
  $W = [Console]::WindowWidth
  $H = [Console]::WindowHeight

  # 1) prefix into scrollback
  foreach ($i in 1..80) { [Console]::Out.Write("scrollback line $i`r`n") }
  W "after prefix: bufH=$([Console]::BufferHeight) winTop=$([Console]::WindowTop) (bottom = bufH-winH = $([Console]::BufferHeight - [Console]::WindowHeight))"

  # ink-style frame writer: relative cursor-up + rewrite H lines
  function Write-InkFrame($tag, $height) {
    [Console]::Out.Write("$ESC[${height}A")
    for ($i = 0; $i -lt $height; $i++) {
      $line = ("FRAME $tag row $i ").PadRight([Console]::WindowWidth - 1)
      [Console]::Out.Write("$ESC[0G")
      [Console]::Out.Write($line)
      [Console]::Out.Write("$ESC[K")
      if ($i -lt $height - 1) { [Console]::Out.Write("`r`n") }
    }
  }

  Write-InkFrame "init" $H
  W "after init frame: winTop=$([Console]::WindowTop) bufH=$([Console]::BufferHeight)"

  # 2) generation-style repaint loop; drag the scrollbar up mid-loop
  $draggedTop = -1
  for ($n = 1; $n -le 25; $n++) {
    if ($n -eq 11) {
      $draggedTop = [Math]::Max(0, [Console]::BufferHeight - [Console]::WindowHeight - 40)
      [Console]::SetWindowPosition(0, $draggedTop)
      W "iter $n DRAG-UP set winTop=$([Console]::WindowTop) (target $draggedTop)"
    }
    Write-InkFrame "gen$n" $H
    $top = [Console]::WindowTop
    $verdict = ""
    if ($draggedTop -ge 0) {
      $verdict = if ($top -eq $draggedTop) { "HOLD" } elseif ($top -eq [Console]::BufferHeight - [Console]::WindowHeight) { "YANK-to-bottom" } else { "moved($top)" }
    }
    W "iter $n winTop=$top bufH=$([Console]::BufferHeight) $verdict"
    Start-Sleep -Milliseconds 40
  }

  # 3) storm: 2J 3J H + full static+frame reprint (what ink writes per render on win32 fullscreen)
  [Console]::Out.Write("$ESC[2J$ESC[3J$ESC[H")
  foreach ($i in 1..80) { [Console]::Out.Write("scrollback line $i`r`n") }
  Write-InkFrame "post-storm" $H
  W "after storm: winTop=$([Console]::WindowTop) bufH=$([Console]::BufferHeight) (3J reset the buffer; thumb range rebuilt)"
  W "DONE"
} catch {
  W "ERROR: $($_.Exception.Message)"
}
