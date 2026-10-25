# Docker without Docker Desktop: Docker Engine in a WSL distro of its own (`dovre-docker`,
# Ubuntu 24.04, packages from Ubuntu's archive), for this user only, no admin. The launcher then
# serves it on a Windows pipe (launcher/dockerpipe.go): \\.\pipe\dovre_docker while Docker
# Desktop is still installed (its own pipe is docker_engine), docker_engine once it's gone, so the
# docker CLI, Testcontainers and Rider find it without settings.
#   pwsh scripts/docker.ps1           set it up (again: it's safe to run twice)
#   pwsh scripts/docker.ps1 -Remove   take the distro away, with its images, containers and volumes
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$env:WSL_UTF8 = '1'
$distro = 'dovre-docker'

function Distros { (wsl --list --quiet) -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ } }
function InDistro([string]$script) {
  # LF only: bash reads a CR as part of the command.
  $script = $script -replace "`r", ''
  $script | wsl -d $distro -u root -- bash -euo pipefail -s
  if ($LASTEXITCODE) { throw "the step in $distro failed ($LASTEXITCODE)" }
}

if ($Remove) {
  if ((Distros) -contains $distro) { wsl --unregister $distro; "Removed $distro and everything in it." }
  docker context rm -f dovre 2>$null | Out-Null
  return
}

if ((Distros) -notcontains $distro) {
  "Installing Ubuntu 24.04 as $distro..."
  wsl --install Ubuntu-24.04 --name $distro --no-launch
  if ($LASTEXITCODE) {
    # A TLS-inspecting proxy may reset the download (0x80072eff). A docker that still works (Docker Desktop) can
    # pull the same Ubuntu as an image; its files become the distro.
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'wsl --install failed, and no docker to fetch Ubuntu with' }
    "The download was refused; taking Ubuntu 24.04 from its Docker image instead..."
    $dir = Join-Path $env:LOCALAPPDATA "Dovre\$distro"
    $tar = Join-Path $env:TEMP "$distro.tar"
    New-Item -ItemType Directory -Force $dir | Out-Null
    docker pull ubuntu:24.04 | Out-Null
    $id = docker create ubuntu:24.04
    try { docker export -o $tar $id } finally { docker rm $id | Out-Null }
    wsl --import $distro $dir $tar --version 2
    $code = $LASTEXITCODE
    Remove-Item $tar -ErrorAction SilentlyContinue
    if ($code) { throw 'wsl --import failed' }
  }
}

# A TLS-inspecting proxy (Zscaler here) opens TLS on the way out: Linux needs its root to trust anything over https.
$pem = ($(Get-ChildItem Cert:\LocalMachine\Root, Cert:\CurrentUser\Root | Where-Object Subject -like '*Zscaler*') | ForEach-Object {
  "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks') + "`n-----END CERTIFICATE-----"
}) -join "`n"

"Setting up Docker Engine in $distro..."
InDistro @"
export DEBIAN_FRONTEND=noninteractive
# Ubuntu's archive is plain http, so this works before the certificate is in.
if ! command -v dockerd >/dev/null || ! command -v socat >/dev/null || ! command -v update-ca-certificates >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends ca-certificates systemd systemd-sysv dbus iptables docker.io docker-compose-v2 docker-buildx socat >/dev/null
fi
if [ -n '$($pem -replace "`r", '')' ]; then
  # One certificate per file, or update-ca-certificates skips it.
  mkdir -p /usr/local/share/ca-certificates
  rm -f /usr/local/share/ca-certificates/zscaler*.crt
  printf '%s\n' '$($pem -replace "`r", '')' | awk '/BEGIN/{n++} {print > ("/usr/local/share/ca-certificates/zscaler-" n ".crt")}'
  update-ca-certificates >/dev/null 2>&1
fi
# systemd starts dockerd with the distro; root is the only user (nobody logs in here).
cat > /etc/wsl.conf <<'EOF'
[boot]
systemd=true
[user]
default=root
[interop]
appendWindowsPath=false
EOF
systemctl enable docker.service docker.socket >/dev/null 2>&1 || true
"@

# The new wsl.conf (systemd) takes effect on the next start.
wsl --terminate $distro | Out-Null
InDistro 'for i in $(seq 1 30); do [ -S /var/run/docker.sock ] && docker info >/dev/null 2>&1 && break; sleep 1; done; docker version --format "Docker Engine {{.Server.Version}} is running in $(. /etc/os-release; echo $PRETTY_NAME)"'

if (Get-Command docker -ErrorAction SilentlyContinue) {
  $pipe = if (Test-Path "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe") { 'dovre_docker' } else { 'docker_engine' }
  docker context rm -f dovre 2>$null | Out-Null
  docker context create dovre --description "Dovre's engine ($distro)" --docker "host=npipe:////./pipe/$pipe" | Out-Null
  "docker context 'dovre' points at \\.\pipe\$pipe (served by the launcher while Dovre runs)."
} else {
  "No docker CLI on Windows: get docker.exe from https://download.docker.com/win/static/stable/x86_64/ (the CLI only)."
}
