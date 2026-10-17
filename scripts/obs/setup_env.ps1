# Creates the isolated Python venv used by the OBS tooling and installs
# the pinned client library. Run once (or after changing requirements.txt):
#   powershell -ExecutionPolicy Bypass -File scripts\obs\setup_env.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $here '.venv'

if (-not (Test-Path $venv)) {
  Write-Host "creating venv: $venv"
  python -m venv $venv
}
$py = Join-Path $venv 'Scripts\python.exe'
& $py -m pip install --quiet --disable-pip-version-check -r (Join-Path $here 'requirements.txt')
& $py -m pip show websocket-client | Select-String -Pattern '^(Name|Version|License)'
Write-Host "OBS tooling environment ready: $py"
