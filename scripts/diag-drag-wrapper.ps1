<# Boot host for diag-drag-clones.ps1: gives the harness a window to size
 * BEFORE the app reads its geometry, so the CLI boots at a chosen size
 * (the user's real sessions run ~190-230 cols, not the 120-col default).
 #>
param(
  [Parameter(Mandatory = $true)][string]$Cli,
  [int]$BootDelayMs = 1800
)
Start-Sleep -Milliseconds $BootDelayMs
& node $Cli
