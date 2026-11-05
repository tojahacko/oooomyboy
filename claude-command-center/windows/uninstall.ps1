# Claude Command Center - uninstaller.  -RemoveData also deletes your history in %USERPROFILE%\.claude-command-center
[CmdletBinding()]
param([switch]$RemoveData)
$ErrorActionPreference = 'Continue'
$root = Join-Path $env:LOCALAPPDATA 'ClaudeCommandCenter'
$app = Join-Path $root 'app'
$ccc = Join-Path $app 'cli\ccc.js'

Write-Host "Removing Claude Command Center..." -ForegroundColor Cyan
if (Test-Path $ccc) {
  & node $ccc stop *> $null
  & node $ccc statusline uninstall
  & node $ccc hooks uninstall *> $null
}
if (Get-Command claude -ErrorAction SilentlyContinue) {
  & claude plugin uninstall command-center@ccc-local *> $null
  & claude plugin marketplace remove ccc-local *> $null
  Write-Host "  [ok] Plugin removed from Claude Code" -ForegroundColor Green
}
foreach ($lnk in @(
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Claude Command Center.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claude Command Center.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Command Center (background).lnk'))) {
  if (Test-Path $lnk) { Remove-Item -Force $lnk }
}
Remove-Item -Recurse -Force 'HKCU:\Software\Classes\AppUserModelId\ClaudeCommandCenter.Dashboard' -ErrorAction SilentlyContinue
if (Test-Path $root) { Remove-Item -Recurse -Force $root }
Write-Host "  [ok] Program files and shortcuts removed" -ForegroundColor Green
$data = Join-Path $env:USERPROFILE '.claude-command-center'
if ($RemoveData) { Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue; Write-Host "  [ok] History deleted" -ForegroundColor Green }
else { Write-Host "  History kept in $data (run with -RemoveData to delete it)" -ForegroundColor Gray }
