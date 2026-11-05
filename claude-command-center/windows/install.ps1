# Claude Command Center - Windows installer
# Usage (from the project folder):  windows\install.cmd      or:  powershell -ExecutionPolicy Bypass -File windows\install.ps1
# Options: -StatusLine / -NoStatusLine   install (or skip) the Claude Code status line without asking
#          -Autostart                     start the backend when you sign in to Windows
#          -NoShortcuts                   do not create Start menu / Desktop shortcuts
#          -ManualHooks                   write hooks into ~/.claude/settings.json instead of installing the plugin
#          -NoOpen                        do not open the dashboard at the end
[CmdletBinding()]
param([switch]$StatusLine, [switch]$NoStatusLine, [switch]$Autostart, [switch]$NoShortcuts, [switch]$ManualHooks, [switch]$NoOpen)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Step($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Magenta }
function Ok($m) { Write-Host "    [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    [!]  $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "    [x]  $m" -ForegroundColor Red }

$src = Split-Path -Parent $PSScriptRoot
$root = Join-Path $env:LOCALAPPDATA 'ClaudeCommandCenter'
$app = Join-Path $root 'app'
$marketplace = 'ccc-local'
$pluginId = "command-center@$marketplace"

Write-Host ""
Write-Host "  Claude Command Center - installer" -ForegroundColor Cyan
Write-Host "  (unofficial tool, not affiliated with Anthropic)" -ForegroundColor DarkGray

# ---------------------------------------------------------------- 1. prerequisites
Step "Checking prerequisites"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail "Node.js was not found."
  Write-Host "    Install Node.js 18 or newer, then run this installer again:" -ForegroundColor Gray
  Write-Host "      winget install OpenJS.NodeJS.LTS" -ForegroundColor White
  exit 1
}
$nodeVersion = (& node -p "process.versions.node").Trim()
if ([int]($nodeVersion.Split('.')[0]) -lt 18) { Fail "Node.js $nodeVersion is too old (need 18+). Run: winget install OpenJS.NodeJS.LTS"; exit 1 }
Ok "Node.js $nodeVersion"

$claude = Get-Command claude -ErrorAction SilentlyContinue
if ($claude) {
  $cv = (& claude --version 2>$null | Select-Object -First 1)
  Ok "Claude Code $cv"
} else {
  Warn "The 'claude' command was not found on PATH. Hooks will be installed into settings.json instead of as a plugin."
  $ManualHooks = $true
}

# ---------------------------------------------------------------- 2. copy files
Step "Installing files to $app"
if (Test-Path (Join-Path $app 'cli\ccc.js')) { & node (Join-Path $app 'cli\ccc.js') stop *> $null }
New-Item -ItemType Directory -Force -Path $root | Out-Null
if (Test-Path $app) { Remove-Item -Recurse -Force $app }
New-Item -ItemType Directory -Force -Path $app | Out-Null
$items = @('.claude-plugin', 'cli', 'server', 'hooks', 'dashboard', 'windows', 'scripts', 'test', 'commands', 'package.json', 'README.md', 'LICENSE')
foreach ($i in $items) {
  $p = Join-Path $src $i
  if (Test-Path $p) { Copy-Item -Recurse -Force $p (Join-Path $app $i) }
}
# The local marketplace that lets Claude Code install the plugin from this folder.
New-Item -ItemType Directory -Force -Path (Join-Path $root '.claude-plugin') | Out-Null
$mp = @'
{
  "name": "ccc-local",
  "owner": { "name": "Claude Command Center installer" },
  "metadata": { "description": "Local installation of Claude Command Center" },
  "plugins": [
    { "name": "command-center", "source": "./app", "version": "1.0.0",
      "description": "Claude Command Center: live monitoring, model and cost tracking, time prediction, prompt intelligence and notifications." }
  ]
}
'@
[IO.File]::WriteAllText((Join-Path $root '.claude-plugin\marketplace.json'), $mp)
Ok "Files copied"

$ccc = Join-Path $app 'cli\ccc.js'

# ---------------------------------------------------------------- 3. Claude Code integration
Step "Connecting to Claude Code"
if (-not $ManualHooks) {
  try {
    & claude plugin uninstall $pluginId *> $null
    & claude plugin marketplace remove $marketplace *> $null
    $out = & claude plugin marketplace add $root 2>&1
    if ($LASTEXITCODE -ne 0) { throw "marketplace add failed: $out" }
    $out = & claude plugin install $pluginId 2>&1
    if ($LASTEXITCODE -ne 0) { throw "plugin install failed: $out" }
    & node $ccc hooks uninstall *> $null   # never both plugin and manual hooks
    Ok "Plugin '$pluginId' installed and enabled (user scope)"
  } catch {
    Warn "Plugin install did not work ($($_.Exception.Message)). Falling back to hooks in settings.json."
    $ManualHooks = $true
  }
}
if ($ManualHooks) {
  & node $ccc hooks install
  if ($LASTEXITCODE -ne 0) { Fail "Could not write hooks into settings.json"; exit 1 }
  Ok "Hooks added to $env:USERPROFILE\.claude\settings.json (a backup was kept)"
}

# ---------------------------------------------------------------- 4. status line (optional)
if (-not $NoStatusLine) {
  $doIt = $StatusLine
  if (-not $StatusLine) {
    $ans = Read-Host "    Show live task status, predictions and cost in Claude Code's status line? [Y/n]"
    $doIt = ($ans -eq '' -or $ans -match '^[Yy]')
  }
  if ($doIt) { & node $ccc statusline install } else { Ok "Status line skipped (later: node `"$ccc`" statusline install)" }
}

# ---------------------------------------------------------------- 5. notifications identity, shortcuts, autostart
Step "Desktop integration"
$aumid = 'ClaudeCommandCenter.Dashboard'
$key = "HKCU:\Software\Classes\AppUserModelId\$aumid"
New-Item -Force -Path $key | Out-Null
New-ItemProperty -Force -Path $key -Name 'DisplayName' -Value 'Claude Command Center' | Out-Null
New-ItemProperty -Force -Path $key -Name 'IconUri' -Value (Join-Path $app 'dashboard\icon-256.png') | Out-Null
Ok "Notifications registered as 'Claude Command Center'"

$shell = New-Object -ComObject WScript.Shell
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$vbs = Join-Path $app 'windows\launch.vbs'
$icon = Join-Path $app 'dashboard\icon.ico'
function New-Shortcut($path, $arguments) {
  $s = $shell.CreateShortcut($path)
  if (Test-Path $wscript) { $s.TargetPath = $wscript; $s.Arguments = "`"$vbs`" $arguments" }
  else { $s.TargetPath = $node.Source; $s.Arguments = "`"$ccc`" $(if ($arguments -eq '--background') { 'start' } else { 'open' })"; $s.WindowStyle = 7 }
  $s.WorkingDirectory = $app
  $s.IconLocation = "$icon,0"
  $s.Description = 'Claude Command Center dashboard'
  $s.Save()
}
if (-not $NoShortcuts) {
  $programs = [Environment]::GetFolderPath('Programs')
  New-Shortcut (Join-Path $programs 'Claude Command Center.lnk') ''
  New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claude Command Center.lnk') ''
  Ok "Start menu and Desktop shortcuts created"
}
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Command Center (background).lnk'
if ($Autostart) { New-Shortcut $startup '--background'; Ok "Backend starts when you sign in" }
elseif (Test-Path $startup) { Remove-Item -Force $startup }

# ---------------------------------------------------------------- 6. start + verify
Step "Starting the backend"
& node $ccc start
Step "Health check"
& node $ccc doctor
if (-not $NoOpen) { & node $ccc open | Out-Null }

Write-Host ""
Write-Host "  Done. Start a NEW Claude Code session (or run /hooks to reload) and your prompts appear live." -ForegroundColor Cyan
Write-Host "  Dashboard:  Start menu > Claude Command Center   (or http://127.0.0.1:47821)" -ForegroundColor Gray
Write-Host "  Verify:     node `"$app\scripts\verify.js`"" -ForegroundColor Gray
Write-Host "  Uninstall:  powershell -ExecutionPolicy Bypass -File `"$app\windows\uninstall.ps1`"" -ForegroundColor Gray
Write-Host ""
