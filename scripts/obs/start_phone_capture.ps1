<#
.SYNOPSIS
  BGMI Cup - launch the phone mirror (scrcpy) that OBS captures.

.DESCRIPTION
  Starts scrcpy with the settings the OBS scene collection expects:
    * fixed window title "BGMI-PHONE" (the Window Capture source targets it)
    * borderless window, phone control disabled (no accidental taps)
    * high video bitrate, 60 fps (use -Fps 30 as the fallback)
    * audio forwarding ON (Android 11+; source "playback")
    * stay-awake so the screen never sleeps while plugged in

  Running it twice is harmless: if the BGMI-PHONE window is already up,
  the script does nothing (pass -Force to relaunch).

.EXAMPLES
  powershell -ExecutionPolicy Bypass -File scripts\obs\start_phone_capture.ps1
  powershell -ExecutionPolicy Bypass -File scripts\obs\start_phone_capture.ps1 -Fps 30
  scripts\obs\start_phone_capture.bat -Test        # 10 s fps measurement
#>
[CmdletBinding()]
param(
    [ValidateSet(60, 30)] [int]$Fps = 60,
    [int]$VideoBitRateMbps = 12,
    [int]$AudioBitRateKbps = 128,
    [int]$MaxSize = 1920,
    [switch]$Test,
    [int]$TestSeconds = 10,
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
$WindowTitle = 'BGMI-PHONE'

function Fail([string]$msg) {
    Write-Host "ERROR: $msg" -ForegroundColor Red
    exit 1
}

$scrcpyCmd = Get-Command scrcpy -ErrorAction SilentlyContinue
if (-not $scrcpyCmd) {
    Fail 'scrcpy not found on PATH. Install it once with: winget install Genymobile.scrcpy'
}
$scrcpy = $scrcpyCmd.Source

# Prefer the adb shipped inside the official scrcpy release, then PATH.
$adb = Join-Path (Split-Path $scrcpy) 'adb.exe'
if (-not (Test-Path $adb)) {
    $adbCmd = Get-Command adb -ErrorAction SilentlyContinue
    if ($adbCmd) { $adb = $adbCmd.Source }
}
if (-not $adb -or -not (Test-Path $adb)) {
    Fail 'adb not found (ships with scrcpy; or install Google.PlatformTools).'
}

$deviceLines = @(& $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match '\S' })
$ready = @($deviceLines | Where-Object { $_ -match '^\S+\s+device(\s|$)' })
$unauthorized = @($deviceLines | Where-Object { $_ -match '^\S+\s+unauthorized' })

if ($ready.Count -eq 0) {
    if ($unauthorized.Count -gt 0) {
        Write-Host 'PHONE NOT AUTHORIZED yet. On the phone, do this:' -ForegroundColor Yellow
        Write-Host '  1. Settings > Developer options (tap "Build number" 7 times if missing).'
        Write-Host '  2. Turn ON "USB debugging" and "Stay awake while charging".'
        Write-Host '  3. Unlock the phone, replug the USB cable, tap "Always allow" on the'
        Write-Host '     "Allow USB debugging?" dialog.'
    } else {
        Write-Host 'NO PHONE DETECTED. Check:' -ForegroundColor Yellow
        Write-Host '  - use a data-capable USB cable (not charge-only) and a direct port'
        Write-Host '  - Settings > Developer options > USB debugging = ON, then replug'
    }
    exit 1
}
$serial = ($ready[0] -split '\s+')[0]

if (-not $Test) {
    $existing = Get-Process scrcpy -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -eq $WindowTitle }
    if ($existing -and -not $Force) {
        Write-Host "scrcpy already running with window '$WindowTitle' (pid $($existing.Id)) - nothing to do."
        exit 0
    }
}

# Keep the screen on. scrcpy's own --stay-awake needs input control, which we
# disable on purpose, so set the device-side USB stay-awake flag over adb.
& $adb -s $serial shell svc power stayon usb | Out-Null

$argList = @(
    '-s', $serial,
    "--window-title=$WindowTitle",
    '--window-borderless',
    "--video-bit-rate=${VideoBitRateMbps}M",
    "--max-size=$MaxSize",
    "--max-fps=$Fps",
    '--no-control',
    '--audio-source=playback',
    '--audio-codec=opus',
    "--audio-bit-rate=${AudioBitRateKbps}K"
)

if ($Test) {
    Write-Host "running ${TestSeconds}s test: scrcpy $($argList -join ' ') --print-fps"
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $scrcpy
    $psi.Arguments = (($argList + '--print-fps') -join ' ')
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    Start-Sleep -Seconds $TestSeconds
    if (-not $proc.HasExited) { $proc.Kill() }
    $out = $proc.StandardOutput.ReadToEnd()
    $err = $proc.StandardError.ReadToEnd()

    Write-Host '--- device display ---'
    & $adb -s $serial shell wm size
    & $adb -s $serial shell wm density

    $samples = [regex]::Matches(($out + "`n" + $err), '(\d+(?:\.\d+)?)\s*fps') |
        ForEach-Object { [double]$_.Groups[1].Value }
    if ($samples.Count) {
        $stats = $samples | Measure-Object -Average -Minimum -Maximum
        Write-Host ('fps samples={0} avg={1:N1} min={2:N1} max={3:N1}' -f `
            $samples.Count, $stats.Average, $stats.Minimum, $stats.Maximum)
        if ($Fps -eq 60 -and $stats.Average -lt 50) {
            Write-Host 'WARNING: below 50 fps at -Fps 60; run the launcher with -Fps 30 instead.' -ForegroundColor Yellow
        }
    } else {
        Write-Host 'no FPS samples captured - raw output follows'
        if ($out) { Write-Host $out }
        if ($err) { Write-Host $err }
    }
    exit 0
}

Start-Process -FilePath $scrcpy -ArgumentList $argList
Write-Host "scrcpy launched on $serial (window '$WindowTitle', $Fps fps, ${VideoBitRateMbps}M video, audio on)."
Write-Host 'You can minimise the scrcpy console; keep the phone window open (OBS captures it).'
