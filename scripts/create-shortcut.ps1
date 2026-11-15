# Creates "Claude Auto Shutdown" on the Desktop, pointing at the packaged app.
# Run after `npm run package`:  npm run shortcut
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'release\Claude Auto Shutdown-win32-x64\Claude Auto Shutdown.exe'
if (-not (Test-Path $exe)) { throw "Not found: $exe (run npm run package first)" }

# GetFolderPath follows a Desktop redirected to OneDrive.
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'Claude Auto Shutdown.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = Split-Path -Parent $exe
$shortcut.IconLocation = "$exe,0"
$shortcut.Description = 'Shut down Windows after Claude Code finishes'
$shortcut.Save()

# Ask Explorer to refresh its icon cache so the new icon shows right away.
try { & "$env:SystemRoot\System32\ie4uinit.exe" -show } catch { }

Write-Output "Created $link"
