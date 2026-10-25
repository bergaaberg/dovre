# Builds the launcher (launcher/, Go) and sets up the ways to start Dovre, all for this user
# only (no admin):
#   - at login: Startup\Dovre.lnk runs `dovrew boot` (the window at once, the server alongside)
#   - Start menu: "Open Dovre", with the hotkey Ctrl+Alt+D
#   - `dovre` on the PATH (~/.local/bin), for PowerShell, cmd and Git Bash
#   - dovre:// links (the starting page's "Start Dovre")
# -Remove takes all of it away again. Run it again after changing launcher/.
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $root 'bin'
$cli = Join-Path $binDir 'dovre.exe'
$gui = Join-Path $binDir 'dovrew.exe'
$icon = Join-Path $root 'assets\icon.ico'
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Dovre.lnk'
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Open Dovre.lnk'
$bin = Join-Path $HOME '.local\bin'
$proto = 'HKCU:\Software\Classes\dovre'

if ($Remove) {
  Remove-Item $startup, $menu, (Join-Path $bin 'dovre.cmd'), (Join-Path $bin 'dovre') -ErrorAction SilentlyContinue
  Remove-Item $proto -Recurse -ErrorAction SilentlyContinue
  "Removed the login start, the Start menu entry, the dovre command and dovre:// links."
  return
}

# The launcher: one source, two builds. dovrew has no console window, for shortcuts and links.
if (-not (Get-Command go -ErrorAction SilentlyContinue)) { throw 'The launcher is Go: install Go (https://go.dev/dl/) and run this again.' }
New-Item -ItemType Directory -Force $binDir | Out-Null
Push-Location (Join-Path $root 'launcher')
try {
  go build -trimpath -ldflags '-s -w' -o $cli .
  if ($LASTEXITCODE) { throw 'go build failed' }
  go build -trimpath -ldflags '-s -w -H=windowsgui' -o $gui .
  if ($LASTEXITCODE) { throw 'go build failed' }
} finally { Pop-Location }

$shell = New-Object -ComObject WScript.Shell
function Shortcut([string]$path, [string]$verb, [string]$hotkey = '') {
  $s = $shell.CreateShortcut($path)
  $s.TargetPath = $gui
  $s.Arguments = $verb
  $s.WorkingDirectory = $root
  $s.IconLocation = "$icon,0"
  $s.Description = 'Dovre: the view from the top'
  if ($hotkey) { $s.Hotkey = $hotkey }
  $s.Save()
}
Shortcut $startup 'boot'
Shortcut $menu 'open' 'CTRL+ALT+D'

New-Item -ItemType Directory -Force $bin | Out-Null
[IO.File]::WriteAllText((Join-Path $bin 'dovre.cmd'), "@`"$cli`" %*`r`n")
# Git Bash: a shell script with LF line endings.
[IO.File]::WriteAllText((Join-Path $bin 'dovre'), "#!/bin/sh`nexec `"$($cli -replace '\\', '/')`" `"`$@`"`n")

New-Item -Path $proto -Force | Out-Null
Set-ItemProperty -Path $proto -Name '(default)' -Value 'URL:Dovre'
Set-ItemProperty -Path $proto -Name 'URL Protocol' -Value ''
New-Item -Path "$proto\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$proto\DefaultIcon" -Name '(default)' -Value "$icon,0"
New-Item -Path "$proto\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$proto\shell\open\command" -Name '(default)' -Value "`"$gui`" `"%1`""

"Installed:"
"  launcher      $cli, $gui"
"  at login      $startup"
"  Start menu    $menu  (Ctrl+Alt+D)"
"  command       $bin\dovre(.cmd)"
"  links         dovre://open"
