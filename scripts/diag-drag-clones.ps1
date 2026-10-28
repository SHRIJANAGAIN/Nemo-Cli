<# Real-console drag reproducer for the resize clone bug.
 *
 * Every other oracle in this repo replays bytes into a simulator or a static
 * conhost window (diag-conhost-replay.ps1). None of them exercise the path a
 * user actually hits: a LIVE window being dragged while the app repaints,
 * where the terminal's own re-flow and the app's resize handling interleave
 * in real time. This script closes that gap:
 *
 *   1. launch the staged publish CLI in a fresh conhost window,
 *   2. size the window BEFORE the app boots (real sessions run ~190 cols,
 *      not the 120-col default), wait for the welcome composer,
 *   3. snapshot the whole console buffer (scrollback included),
 *   4. drag the window in rate-limit-crossing bursts (MoveWindow steps,
 *      exactly what a mouse drag produces: WM_SIZE per step),
 *   5. settle, re-read the buffer, count frame top-borders left outside the
 *      viewport = clones.
 *
 * PASS  = exactly one live frame in view, zero frame tops in scrollback,
 *         and the composer still rendered (app alive).
 * -SelfTest proves the counter can see clones at all: it grows the buffer
 * below the window and forges a frame top-border on the new outside row;
 * the read must flag it (OutViewTops=1), otherwise a PASS above would be
 * vacuous.
 *
 * Notes: the other scenarios space steps 35-220ms to cross the guard's
 * ANCHOR_MIN_INTERVAL_MS rate limit deliberately. The 'mouse' scenario goes
 * the other way: 16ms col-by-col steps, the cadence a real pointer drag
 * produces (one WM_SIZE per mouse-move), a monotonic narrow chain that ends
 * at the NEW geometry - the shape of the 09:43 clone report.
 *
 * Run: powershell -ExecutionPolicy Bypass -File scripts\diag-drag-clones.ps1
 *      [-Scenario width|height|corner|user|storm|mouse|boot|selftest|all] [-SettleMs 2500]
 #>
param(
  [ValidateSet('width', 'height', 'corner', 'user', 'storm', 'mouse', 'boot', 'selftest', 'all')]
  [string]$Scenario = 'all',
  [int]$SettleMs = 2500
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
$cli = Join-Path $repo 'publish\dist\apps\cli\src\index.js'
$wrapper = Join-Path $here 'diag-drag-wrapper.ps1'
if (-not (Test-Path $cli)) {
  Write-Output "FAIL: staged CLI missing at $cli (run npm run publish:build first)"
  exit 2
}

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DC {
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(int pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateFile(string name, int access, int share, IntPtr sec, int disp, int flags, IntPtr tmpl);
  [DllImport("kernel32.dll")] public static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI i);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern bool ReadConsoleOutputCharacter(IntPtr h, StringBuilder s, int len, COORD at, out int read);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern bool WriteConsoleOutputCharacter(IntPtr h, string s, int len, COORD at, out int written);
  [DllImport("kernel32.dll")] public static extern bool SetConsoleScreenBufferSize(IntPtr h, COORD sz);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SR { public short L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct CSBI { public COORD size; public COORD cursor; public ushort attr; public SR win; public COORD maxwin; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public static string WinLog = "";
  public static bool Collect(IntPtr h, IntPtr l) {
    int pid; GetWindowThreadProcessId(h, out pid);
    var sb = new StringBuilder(300); GetWindowText(h, sb, 300);
    RECT r; GetWindowRect(h, out r);
    WinLog += h + "|" + pid + "|" + IsWindowVisible(h) + "|" + r.L + "," + r.T + "," + r.R + "," + r.B + "|" + sb.ToString() + ";";
    return true;
  }
}
"@ -ErrorAction SilentlyContinue

# A console window that has never been shown reports a valid handle with an
# all-zero rect (GetConsoleWindow inside the child returns exactly such a
# phantom). The real host window carries a real rect, so resolve it by
# (not pre-existing, visible, non-zero rect, optional title).
function Find-TargetWindow([int[]]$Before, [string]$Title) {
  [DC]::WinLog = ""
  [void][DC]::EnumWindows([DC+EnumProc]{ param($h, $l) [DC]::Collect($h, $l) }, [IntPtr]::Zero)
  foreach ($entry in ([DC]::WinLog -split ';')) {
    if (-not $entry) { continue }
    $f = $entry.Split('|')
    if ($f.Count -lt 5) { continue }
    $h = [int64]$f[0]
    if ($Before -contains $h) { continue }
    if ($f[2] -ne 'True') { continue }
    $rect = $f[3].Split(',')
    $w = [int]$rect[2] - [int]$rect[0]; $hh = [int]$rect[3] - [int]$rect[1]
    if ($w -le 0 -or $hh -le 0) { continue }
    if ($Title -and $f[4] -ne $Title) { continue }
    return [pscustomobject]@{ Hwnd = [IntPtr]$h; X = [int]$rect[0]; Y = [int]$rect[1]; W = $w; H = $hh; Title = $f[4] }
  }
  return $null
}

# Read the entire console buffer (scrollback included) through AttachConsole.
# GetStdHandle goes stale after AttachConsole inside .NET, so open CONOUT$.
function Read-Buffer([int]$ConsolePid) {
  [void][DC]::FreeConsole()
  if (-not [DC]::AttachConsole($ConsolePid)) { throw "AttachConsole($ConsolePid) failed" }
  $h = [DC]::CreateFile('CONOUT$', 0xC0000000, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if ($h -eq [IntPtr]::new(-1)) { throw 'CONOUT$ open failed' }
  $ci = New-Object DC+CSBI
  if (-not [DC]::GetConsoleScreenBufferInfo($h, [ref]$ci)) { throw 'GetConsoleScreenBufferInfo failed' }
  $tops = 0; $composers = 0; $inViewTops = 0; $outViewTops = 0
  $outside = New-Object System.Collections.Generic.List[string]
  $viewport = New-Object System.Collections.Generic.List[string]
  for ($r = 0; $r -lt $ci.size.Y; $r++) {
    $sb = New-Object System.Text.StringBuilder $ci.size.X
    $n = 0
    $at = New-Object DC+COORD
    $at.X = 0; $at.Y = [int16]$r
    [void][DC]::ReadConsoleOutputCharacter($h, $sb, $ci.size.X, $at, [ref]$n)
    $line = if ($n -gt 0) { $sb.ToString(0, $n) } else { '' }
    $isTop = $line.StartsWith([char]0x256D) -and (($line -replace '[^' + [char]0x2500 + [char]0x256D + [char]0x256E + ']', '').Length -ge 30)
    if ($isTop) {
      $tops++
      if ($r -ge $ci.win.T -and $r -le $ci.win.B) { $inViewTops++ } else { $outViewTops++ }
    }
    if ($line.Contains('Ask Nemo')) { $composers++ }
    if ($r -ge $ci.win.T -and $r -le $ci.win.B -and $viewport.Count -lt 80) {
      $viewport.Add(('{0}|{1}' -f $r, $line.TrimEnd()))
    }
    if (($r -lt $ci.win.T -or $r -gt $ci.win.B) -and $outside.Count -lt 200) {
      # Keep raw rows outside the viewport for the fail dump: a clone's
      # exact content (blank middle? wrapped tail?) is the diagnosis.
      $outside.Add(('{0}|{1}' -f $r, $line.TrimEnd()))
    }
  }
  [void][DC]::FreeConsole()
  return [pscustomobject]@{
    BufCols = $ci.size.X; BufRows = $ci.size.Y
    WinCols = ($ci.win.R - $ci.win.L + 1); WinRows = ($ci.win.B - $ci.win.T + 1)
    WinTop = $ci.win.T; WinBottom = $ci.win.B; CursorY = $ci.cursor.Y
    FrameTops = $tops; InViewTops = $inViewTops; OutViewTops = $outViewTops
    Composers = $composers
    OutsideRows = $outside.ToArray()
    ViewportRows = $viewport.ToArray()
  }
}

# Forge a frame top-border row at an absolute buffer position (used by
# -SelfTest to prove the counter flags rows outside the viewport).
function Write-Row([int]$ConsolePid, [int]$Row, [string]$Text) {
  [void][DC]::FreeConsole()
  if (-not [DC]::AttachConsole($ConsolePid)) { throw "AttachConsole($ConsolePid) failed" }
  $h = [DC]::CreateFile('CONOUT$', 0xC0000000, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  $at = New-Object DC+COORD
  $at.X = 0; $at.Y = [int16]$Row
  $n = 0
  [void][DC]::WriteConsoleOutputCharacter($h, $Text, $Text.Length, $at, [ref]$n)
  [void][DC]::FreeConsole()
  return $n
}

# Grow the screen buffer BELOW the window: rows past the window bottom are
# out-of-view under the same classification scrollback gets, but nothing the
# app does (cursor-follow erases, anchors) ever touches them - and since the
# window rect is unchanged, the app sees no geometry change at all.
function Set-BufferGrow([int]$ConsolePid, [int]$ExtraRows) {
  [void][DC]::FreeConsole()
  if (-not [DC]::AttachConsole($ConsolePid)) { throw "AttachConsole($ConsolePid) failed" }
  $h = [DC]::CreateFile('CONOUT$', 0xC0000000, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if ($h -eq [IntPtr]::new(-1)) { throw 'CONOUT$ open failed' }
  $ci = New-Object DC+CSBI
  if (-not [DC]::GetConsoleScreenBufferInfo($h, [ref]$ci)) { throw 'GetConsoleScreenBufferInfo failed' }
  $sz = New-Object DC+COORD
  $sz.X = $ci.size.X; $sz.Y = [int16]($ci.size.Y + $ExtraRows)
  $ok = [DC]::SetConsoleScreenBufferSize($h, $sz)
  [void][DC]::FreeConsole()
  return $ok
}

function Invoke-Scenario([string]$Name) {
  Write-Host "=== scenario: $Name ==="
  [DC]::WinLog = ""
  [void][DC]::EnumWindows([DC+EnumProc]{ param($h, $l) [DC]::Collect($h, $l) }, [IntPtr]::Zero)
  $before = @()
  foreach ($entry in ([DC]::WinLog -split ';')) { if ($entry) { $before += [int64]($entry.Split('|')[0]) } }

  $p = Start-Process powershell -ArgumentList @(
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $wrapper, '-Cli', $cli
  ) -PassThru

  try {
    # Phase 1: window appears (host console, before the app sets its title).
    $win = $null
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline -and -not $win) {
      Start-Sleep -Milliseconds 150
      $win = Find-TargetWindow $before ''
    }
    if (-not $win) { Write-Host 'FAIL: console window never appeared'; return $false }

    # Phase 2: calibrate + size the window BEFORE the app reads its geometry
    # (the wrapper delays node by 1800ms for exactly this window).
    $pre = $null
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline -and -not $pre) {
      try { $pre = Read-Buffer $p.Id } catch { Start-Sleep -Milliseconds 200 }
    }
    if (-not $pre) { Write-Host 'FAIL: pre-boot buffer read failed'; return $false }

    $cr = New-Object DC+RECT; $wr = New-Object DC+RECT
    [void][DC]::GetClientRect($win.Hwnd, [ref]$cr)
    [void][DC]::GetWindowRect($win.Hwnd, [ref]$wr)
    $pxPerCol = ($cr.R - $cr.L) / $pre.WinCols
    $pxPerRow = ($cr.B - $cr.T) / $pre.WinRows
    $borderX = ($wr.R - $wr.L) - ($cr.R - $cr.L)
    $borderY = ($wr.B - $wr.T) - ($cr.B - $cr.T)

    # Start geometry per scenario: 'user' boots at the real-session size.
    $startCols = 120; $startRows = 30
    if ($Name -eq 'user') { $startCols = 190; $startRows = 28 }
    if ($Name -eq 'mouse' -or $Name -eq 'boot') { $startCols = 192; $startRows = 40 }
    $outerW = [int][math]::Round($startCols * $pxPerCol) + $borderX
    $outerH = [int][math]::Round($startRows * $pxPerRow) + $borderY
    # Park at the screen origin: conhost clamps its window to the display,
    # and the wrapper's console cascades mid-screen by default (a 44-row
    # target would get clipped from y=208).
    [void][DC]::MoveWindow($win.Hwnd, 0, 0, $outerW, $outerH, $true)

    if ($Name -eq 'boot') {
      # Drag from the RAW console: no title/composer wait at all. The
      # burst below starts ~250ms after sizing, node only launches at
      # wrapper+1800ms, and ~2.7s of churn straddles React's first frame -
      # the only scenario that can push a frame mid-paint.
      Start-Sleep -Milliseconds 250
      $base = $null
      try { $base = Read-Buffer $p.Id } catch { }
      if (-not $base) { Write-Host 'FAIL: pre-boot buffer read failed'; return $false }
    } else {
      # Phase 3: wait for the app to boot at that geometry.
      $t = $null
      $deadline = (Get-Date).AddSeconds(20)
      while ((Get-Date) -lt $deadline -and -not $t) {
        Start-Sleep -Milliseconds 300
        $t = Find-TargetWindow $before 'Nemo'
      }
      if (-not $t) { Write-Host 'FAIL: app window title never appeared'; return $false }
      $win = $t

      # Every non-boot scenario waits for the welcome composer to prove the
      # app finished booting pre-drag.
      $base = $null
      $deadline = (Get-Date).AddSeconds(30)
      while ((Get-Date) -lt $deadline) {
        try { $base = Read-Buffer $p.Id; if ($base.Composers -ge 1) { break } } catch { }
        Start-Sleep -Milliseconds 500
      }
      if (-not $base) { Write-Host 'FAIL: pre-drag buffer read failed'; return $false }
      if ($base.Composers -lt 1) { Write-Host 'FAIL: app never reached the welcome composer'; return $false }
    }
    Write-Host ("baseline: " + ($base | Select-Object -Property * -ExcludeProperty OutsideRows, ViewportRows | ConvertTo-Json -Compress))
    Write-Host ("calibration: pxPerCol=$([math]::Round($pxPerCol,2)) pxPerRow=$([math]::Round($pxPerRow,2)) border=${borderX}x${borderY} boot=${startCols}x${startRows}")

    # SelfTest: grow the buffer BELOW the window and forge a frame
    # top-border on the new outside row; the detector must flag it. Two
    # rejected alternatives: shrinking also shrinks the buffer in conhost
    # (no outside rows ever open), and sliding the viewport down gets
    # snapped straight back by conhost's cursor-follow the moment Ink's
    # stale-count erase walks the cursor above the window.
    if ($Name -eq 'selftest') {
      $st0 = Read-Buffer $p.Id
      $grown = Set-BufferGrow $p.Id 10
      Start-Sleep -Milliseconds 400
      $st1 = Read-Buffer $p.Id
      if ($st1.BufRows -ne ($st0.BufRows + 10)) {
        Write-Host ("selftest: GROW-FAIL grown=$grown expected buf=$($st0.BufRows + 10) actual=$($st1.BufRows)")
        return $false
      }
      $forged = [string][char]0x256D + ([string][char]0x2500 * 40) + [string][char]0x256E
      $targetRow = $st0.BufRows + 1   # first fully-outside row below the window
      $wrote = Write-Row $p.Id $targetRow $forged
      Start-Sleep -Milliseconds 150
      $st2 = Read-Buffer $p.Id
      $ok = ($st2.OutViewTops -ge 1)
      Write-Host ("selftest: forged row=$targetRow wrote=$wrote win=0..$($st2.WinBottom) buf=$($st2.BufRows) outView(before)=$($st1.OutViewTops) outView(after)=$($st2.OutViewTops)")
      if ($ok) { Write-Host 'verdict(selftest): DETECTOR_OK - forged clone flagged' }
      else { Write-Host 'verdict(selftest): DETECTOR_BLIND - counter missed a known clone' }
      return $ok
    }

    $originX = $win.X; $originY = $win.Y
    $sCols = $base.WinCols; $sRows = $base.WinRows

    # Steps: [colDelta, rowDelta, sleepMs] per MoveWindow call. Spacing
    # 35-220ms crosses the guard's 250ms rate limit repeatedly.
    $steps = @()
    switch ($Name) {
      'width' {
        foreach ($d in @(4, 8, 12, 16, 20, 25, 30, 35, 40)) { $steps += ,@(-$d, 0, 60) }
        $steps += ,@(0, 0, 400)
        foreach ($d in @(40, 35, 30, 25, 20, 16, 12, 8, 4, 0)) { $steps += ,@(-$d, 0, 60) }
      }
      'height' {
        foreach ($d in @(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)) { $steps += ,@(0, -$d, 50) }
        $steps += ,@(0, 0, 400)
        foreach ($d in @(10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0)) { $steps += ,@(0, -$d, 50) }
      }
      'corner' {
        foreach ($i in 1..12) {
          $cd = [int][math]::Round(30 * $i / 12)
          $rd = [int][math]::Round(8 * $i / 12)
          $steps += ,@(-$cd, -$rd, 35)
        }
      }
      'user' {
        # The reported shape: a long bottom-edge pull that GROWS the window
        # tall (26 -> 47 rows was observed live), with +/-1-col jitter along
        # the way, ending at the NEW geometry (nobody snaps back exactly).
        for ($i = 1; $i -le 16; $i++) {
          $rd = $i                # +16 rows over 16 steps (28 -> 44)
          $cd = if ($i % 4 -eq 3) { -1 } elseif ($i % 4 -eq 0) { 1 } else { 0 }
          $steps += ,@($cd, $rd, 220)
        }
        # Net the col jitter back to base but KEEP the growth: a (0,0) step
        # here would snap rows back to $sRows (deltas are from base) and
        # quietly test a revert instead of the user's end-at-new-size state.
        $steps += ,@(0, 16, 250)
      }
      'storm' {
        # ~2s of continuous mixed dragging ending mid-geometry: width and
        # height jiggling every 50ms, crossing the rate limit ~40 times,
        # alternating narrow (reflow-split) and grow (stale-count) paths.
        for ($i = 1; $i -le 40; $i++) {
          $cd = [int][math]::Round(20 * [math]::Sin($i / 3))
          $rd = [int][math]::Round(8 * [math]::Sin($i / 2))
          $steps += ,@($cd, $rd, 50)
        }
      }
      'mouse' {
        # A faithful pointer drag: WM_SIZE fires ~every 16ms while the hand
        # moves, each event shifting 1-2 cols (pixel granularity), and
        # nobody snaps back to the start size. Deltas are absolute from the
        # boot geometry: pass 1 narrows 192 -> 165 col-by-col, a hand
        # overshoots and corrects (the wobble), height trims 40 -> 37 on
        # the bottom edge, then a second pass grows part-way back and
        # re-narrows - ending at the NEW narrower geometry like the 09:43
        # report's chain of ~1-col-narrower frames.
        for ($i = 1; $i -le 27; $i++) { $steps += ,@(-$i, 0, 16) }        # 192 -> 165
        foreach ($d in @(-29, -28, -30, -28, -27)) { $steps += ,@($d, 0, 16) }  # overshoot + correct, back to 165
        foreach ($r in 1..3) { $steps += ,@(-27, -$r, 16) }                # bottom edge 40 -> 37
        $steps += ,@(-27, -3, 300)                                         # hand pauses > rate limit
        foreach ($i in 27..10) { $steps += ,@(-$i, -3, 16) }               # grow back to 182
        foreach ($i in 10..27) { $steps += ,@(-$i, -3, 16) }               # re-narrow to 165, end here
      }
      'boot' {
        # Resize DURING startup: the burst starts the moment the window
        # title appears (app alive, first frame not yet painted) and runs
        # ~2.4s of continuous width churn, straddling the first paint -
        # the one moment no other scenario exercises. The narrow chain
        # ends at the new geometry; the oscillation keeps WM_SIZE flowing
        # while React mounts and ink writes its first frame.
        for ($i = 1; $i -le 27; $i++) { $steps += ,@(-$i, 0, 16) }        # 192 -> 165
        for ($i = 1; $i -le 120; $i++) {
          $cd = -27 + [int][math]::Round(8 * [math]::Sin($i / 5))          # oscillate 157..173 cols
          $steps += ,@($cd, 0, 16)
        }
        $steps += ,@(-27, 0, 300)                                          # end narrow at 165
      }
    }

    foreach ($s in $steps) {
      $cols = $sCols + $s[0]; $rows = $sRows + $s[1]
      if ($cols -lt 40) { $cols = 40 }; if ($rows -lt 10) { $rows = 10 }
      $outerW2 = [int][math]::Round($cols * $pxPerCol) + $borderX
      $outerH2 = [int][math]::Round($rows * $pxPerRow) + $borderY
      [void][DC]::MoveWindow($win.Hwnd, $originX, $originY, $outerW2, $outerH2, $true)
      Start-Sleep -Milliseconds $s[2]
      if ($Name -eq 'user') {
        $g = Read-Buffer $p.Id
        Write-Host ("  step: req=${cols}x${rows} outer=${outerW2}x${outerH2} origin=$originX,$originY actual=$($g.WinCols)x$($g.WinRows) buf=$($g.BufCols)x$($g.BufRows)")
      }
    }

    Start-Sleep -Milliseconds $SettleMs
    if ($Name -eq 'boot') {
      # The drag ran during startup; let boot finish so the final read can
      # require a rendered composer like every other scenario.
      $deadline = (Get-Date).AddSeconds(20)
      while ((Get-Date) -lt $deadline) {
        try { $chk = Read-Buffer $p.Id; if ($chk.Composers -ge 1) { break } } catch { }
        Start-Sleep -Milliseconds 500
      }
    }
    $final = Read-Buffer $p.Id
    if (-not (($final.OutViewTops -eq 0) -and ($final.InViewTops -eq 1) -and ($final.Composers -ge 1))) {
      # A read can land between the guard's wipe and ink's rewrite (torn
      # mid-repaint state); judge only after a repaint interval has had the
      # chance to restore the frame. A real clone survives this re-read.
      Write-Host ("note: first final read not clean (tops=$($final.FrameTops) inView=$($final.InViewTops) scrollback=$($final.OutViewTops) composers=$($final.Composers)), re-reading after 900ms")
      Start-Sleep -Milliseconds 900
      $final = Read-Buffer $p.Id
    }
    $finalBrief = $final | Select-Object -Property * -ExcludeProperty OutsideRows, ViewportRows
    Write-Host ("final:    " + ($finalBrief | ConvertTo-Json -Compress))

    $bootOut = $base.OutViewTops
    $ok = ($final.OutViewTops -eq 0) -and ($final.InViewTops -eq 1) -and ($final.Composers -ge 1)
    $verdict = if ($ok) { 'PASS' } else { 'FAIL' }
    Write-Host ("verdict($Name): $verdict  inView=$($final.InViewTops) scrollback=$($final.OutViewTops) (boot had $bootOut) composers=$($final.Composers) geom=$($final.WinCols)x$($final.WinRows)")
    if (-not $ok) {
      # Dump viewport + outside rows as UTF-8: mojibake on the console
      # would hide the content that distinguishes the failure shapes.
      $dump = Join-Path $env:TEMP ("tb_dragclone_" + $Name + "_" + (Get-Date).ToString('HHmmss') + ".txt")
      @('--- viewport (in view) ---') + $final.ViewportRows +
        @('--- outside (scrollback/overflow) ---') + $final.OutsideRows |
        Set-Content -Path $dump -Encoding UTF8
      Write-Host ("viewport + outside rows dumped to " + $dump)
      Write-Host '--- viewport (first 20) ---'
      $final.ViewportRows | Select-Object -First 20 | ForEach-Object { Write-Host ('  ' + $_) }
      if ($final.OutsideRows.Count -gt 0) {
        Write-Host '--- outside (first 12) ---'
        $final.OutsideRows | Select-Object -First 12 | ForEach-Object { Write-Host ('  ' + $_) }
      }
    }
    return $ok
  } finally {
    & taskkill.exe /PID $p.Id /T /F 2>$null | Out-Null
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  }
}

$scenarios = switch ($Scenario) {
  'all' { @('width', 'height', 'corner', 'user', 'storm', 'mouse', 'boot') }
  default { @($Scenario) }
}
$failed = 0
foreach ($s in $scenarios) {
  $r = Invoke-Scenario $s
  if (-not $r) { $failed++ }
  Start-Sleep -Milliseconds 500
}
if ($failed -eq 0) {
  Write-Output 'DRAG_CLONES_OK'
  exit 0
} else {
  Write-Output "DRAG_CLONES_FAIL ($failed scenario(s))"
  exit 1
}
