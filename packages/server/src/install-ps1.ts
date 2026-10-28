/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Windows one-line installer, served as `/install.ps1`:
 *
 *   irm https://skt.sktailabs.in/install.ps1 | iex
 *
 * The script checks for node (installing Node 20+ LTS itself via winget or
 * the official nodejs.org MSI when missing), runs `npm install -g`,
 * verifies — then prints next steps. No secrets, no downloads outside npm
 * and nodejs.org,
 * no admin rights needed (npm global prefix is user-writable on stock
 * setups; if not, npm itself tells the user how to fix it). Kept as a
 * module constant (not a static file) so `verify-pack` covers it and tests
 * pin its contents: a silent change here would rewire every install.
 */

export const INSTALL_PS1 = `# Nemo one-line installer.
# Run: irm https://skt.sktailabs.in/install.ps1 | iex
$ErrorActionPreference = "Stop"
$esc = [char]27
$cr = [char]13

function Fail($msg) { Write-Error $msg; exit 1 }

# Node.js bootstrap: when no 'node' is on PATH, install Node 20+ LTS first
# (winget when present, else the official nodejs.org MSI), refresh this
# session's PATH from the registry, and hand back control. Only the
# nodejs.org + winget channels are ever touched — no third-party binaries.
function Install-NodeLTS {
  $arch = "x64"
  if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { $arch = "arm64" }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Output "installing Node.js LTS via winget…"
    winget install --id OpenJS.NodeJS.LTS -e --source winget --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { Fail "winget could not install Node.js (exit $LASTEXITCODE) — install Node 20+ from https://nodejs.org, then re-run this command." }
  } else {
    Write-Output "winget not found — downloading Node.js LTS from nodejs.org…"
    $wc = New-Object System.Net.WebClient
    try {
      $listing = $wc.DownloadString("https://nodejs.org/dist/latest-v22.x/")
    } catch {
      Fail "could not reach nodejs.org ($($_.Exception.Message)) — install Node 20+ from https://nodejs.org, then re-run this command."
    }
    $m = [regex]::Match($listing, "node-v([0-9]+.[0-9]+.[0-9]+)-win-" + $arch + ".msi")
    if (-not $m.Success) { Fail "could not find a Node.js installer for win-$arch — install Node 20+ from https://nodejs.org, then re-run this command." }
    $nodeVer = $m.Groups[1].Value
    $msi = Join-Path $env:TEMP ("node-v" + $nodeVer + "-win-" + $arch + ".msi")
    Write-Output ("downloading Node.js " + $nodeVer + "…")
    $wc.DownloadFile("https://nodejs.org/dist/v" + $nodeVer + "/node-v" + $nodeVer + "-win-" + $arch + ".msi", $msi)
    Write-Output "installing Node.js (approve the admin prompt if one appears)…"
    Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", $msi, "/qn", "/norestart") -Wait
    Remove-Item $msi -ErrorAction SilentlyContinue
  }
  $regPath = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  $env:PATH = $regPath
}

# Full-page clear, then the banner shimmers in: a silver-white wave sweeps
# across the name (steel shadows, bright silver crest — the NV metal;
# plain consoles still show the text uncoloured).
Clear-Host
$banner = "T R A Y A M B A K"
$wave = @(238, 242, 246, 249, 252, 255, 252, 249, 246, 242, 238, 234)
for ($s = 0; $s -lt 6; $s++) {
  $line = ""
  for ($k = 0; $k -lt $banner.Length; $k++) {
    $c = $wave[($k + $s) % $wave.Count]
    $line += "$esc[38;5;" + $c + "m" + $banner[$k]
  }
  Write-Host ("$cr " + $line + "$esc[0m   ") -NoNewline
  Start-Sleep -Milliseconds 130
}
Write-Host ""

# The third eye opens in stages: shut, stirring, half-open, blazing.
$eyes = @('( - )', '( o )', '( O )', '( (O))', '( O )', '( ◉ )')
$glow = @(240, 245, 250, 220, 220, 196)
for ($n = 0; $n -lt $eyes.Count; $n++) {
  $g = $glow[$n]
  Write-Host ("$cr$esc[38;5;" + $g + "m" + $eyes[$n] + "$esc[0m  opening the third eye…   ") -NoNewline
  Start-Sleep -Milliseconds 300
}
Write-Host ""
Write-Host (" $esc[38;5;196m( ◉ )$esc[0m  $esc[3mthree eyes of Shiva is coming$esc[23m")
Write-Host ""
Start-Sleep -Milliseconds 500

$nodeV = $null
try { $nodeV = node --version } catch { $nodeV = $null }
if (-not $nodeV) {
  Write-Output "node not found — installing Node.js LTS first, then nemo…"
  Install-NodeLTS
  try { $nodeV = node --version } catch { $nodeV = $null }
  if (-not $nodeV) { Fail "Node.js install finished but 'node' is still not on PATH — restart the terminal and re-run this command." }
}
Write-Output "node $nodeV found."
Write-Output ""

# Download + install with a live comet bar: npm install -g runs as a
# background job while the foreground paints a glowing comet (head + fading
# trail) over a dim track, plus the eye spinner and elapsed time.
# Start-Job can be unavailable in locked-down hosts — then fall straight
# through to a direct install (same command, no animation).
$spin = @('◉', '◎', '◯', '◎')
$width = 24
$installDone = $false
try {
  $job = Start-Job -ScriptBlock { npm install -g @shrijanagain/nemo-cli }
  $t0 = Get-Date
  $i = 0
  while ($job.State -eq 'Running') {
    $elapsed = [int]((Get-Date) - $t0).TotalSeconds
    if ($elapsed -gt 600) { Stop-Job $job; Fail "install timed out after 10 minutes (network/npm issue?)" }
    $pos = $i % $width
    $bar = ""
    for ($b = 0; $b -lt $width; $b++) {
      $d = ($pos - $b + $width) % $width
      if ($d -eq 0) { $bar += "$esc[38;5;213m█" }
      elseif ($d -eq 1) { $bar += "$esc[38;5;141m▓" }
      elseif ($d -eq 2) { $bar += "$esc[38;5;99m▒" }
      else { $bar += "$esc[38;5;238m─" }
    }
    $eye = $spin[$i % 4]
    Write-Host ("$cr" + $eye + " [" + $bar + "$esc[0m] downloading nemo… $elapsed s elapsed   ") -NoNewline
    Start-Sleep -Milliseconds 150
    $i++
  }
  Write-Host ""
  $jobOut = Receive-Job $job 2>&1 | Out-String
  Remove-Job $job -Force
  if ($job.State -ne 'Completed') { Fail "npm install failed:$([Environment]::NewLine)$jobOut" }
  $installDone = $true
} catch {
  Write-Output "background install unavailable, installing directly…"
}
if (-not $installDone) {
  try { npm install -g @shrijanagain/nemo-cli } catch { Fail "npm install failed: $($_.Exception.Message)" }
}
Write-Output "download + install complete."
Write-Output ""

try { $ver = nemo --version } catch { Fail "install finished but 'nemo' is not on PATH — restart the terminal and try again." }
Write-Host (" $esc[38;5;46m( ◉ )$esc[0m  nemo $ver installed.")
Write-Output ""
Write-Output ("$esc[3mthree eyes of Shiva is coming$esc[23m — to your terminal.")
Write-Output ""
Write-Output "Next steps:"
Write-Output "  1. nemo            # open the TUI"
Write-Output "  2. /provider add        # connect your model backend + API key"
Write-Output "  3. /github login        # authorize GitHub (browser opens)"
Write-Output "  4. /devmode trial       # or paste a license: /devmode on 1102-XXXX-XXXX-XXXX"
`
