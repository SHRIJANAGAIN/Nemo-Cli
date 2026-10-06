# Rasterize skt-icon.jpeg into terminal block art for the Trayambak logo.
# Each cell uses U+2580 (upper half block) with the TOP pixel as foreground and
# the BOTTOM pixel as background: two vertical pixels per row, which is what
# keeps the eye ring readable at banner size.
# NOTE: PowerShell 5.1 has no `e escape (that is PS6+), so ESC is [char]27.
Add-Type -AssemblyName System.Drawing

$ESC = [char]27
$src = "C:\Users\engli\trayambak\skt-icon.jpeg"
$img = [System.Drawing.Image]::FromFile($src)

$cols = 48
$textRows = 14
$pixelRows = $textRows * 2

$bmp = New-Object System.Drawing.Bitmap $img
$out = New-Object System.Collections.Generic.List[string]

for ($r = 0; $r -lt $textRows; $r++) {
  $line = ""
  for ($c = 0; $c -lt $cols; $c++) {
    $topColor = $null; $botColor = $null
    for ($half = 0; $half -lt 2; $half++) {
      $py = [int](($r * 2 + $half) * $img.Height / $pixelRows)
      $px = [int]($c * $img.Width / $cols)
      if ($py -ge $img.Height) { $py = $img.Height - 1 }
      if ($px -ge $img.Width) { $px = $img.Width - 1 }
      $p = $bmp.GetPixel($px, $py)
      $lum = (0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B) / 255
      $col = if ($lum -gt 0.90) { $null } else { "{0};{1};{2}" -f $p.R, $p.G, $p.B }
      if ($half -eq 0) { $topColor = $col } else { $botColor = $col }
    }
    if ($null -eq $topColor -and $null -eq $botColor) { $line += " "; continue }
    if ($null -eq $topColor) { $topColor = $botColor }
    if ($null -eq $botColor) { $botColor = $topColor }
    $line += "$ESC[0m$ESC[38;2;$topColor" + "m$ESC[48;2;$botColor" + "m" + [char]0x2580
  }
  $out.Add($line + "$ESC[0m")
}

# Trim fully-blank leading/trailing rows so the banner has no dead space.
while ($out.Count -gt 0 -and $out[0] -replace "$ESC\[[0-9;]*m", "" -replace " ", "" -eq "") { $out.RemoveAt(0) }
while ($out.Count -gt 0 -and $out[$out.Count - 1] -replace "$ESC\[[0-9;]*m", "" -replace " ", "" -eq "") { $out.RemoveAt($out.Count - 1) }

$path = "C:\Users\engli\trayambak\packages\tui\src\ink-app\logo_ansi.txt"
[System.IO.File]::WriteAllText($path, ($out -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))

$bmp.Dispose(); $img.Dispose()
Write-Output ("rows=" + $out.Count + " cols=" + $cols + " bytes=" + (Get-Item $path).Length)