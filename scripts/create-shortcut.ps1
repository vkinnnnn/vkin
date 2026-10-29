# Creates a "Meeting Copilot" shortcut on the Desktop and in the Start menu.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $root 'assets\icon.ico'
if (-not (Test-Path $electron)) { throw "Electron not found at $electron. Run 'npm install' first." }

$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Meeting Copilot.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Meeting Copilot.lnk')
)
$shell = New-Object -ComObject WScript.Shell
foreach ($path in $targets) {
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $electron
  $lnk.Arguments = "`"$root`""
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = 'Meeting Copilot overlay'
  $lnk.Save()
  Write-Output "Created $path"
}
