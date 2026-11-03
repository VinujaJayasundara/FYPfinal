# Simulated jog for the Android emulator (for testing only; NOT a real run).
# Sends one GPS fix per second along a straight north-east line at ~3 m/s
# (about 5:30 /km), which passes the app's 1 Hz, 50 m accuracy and 25 km/h gates.
#
# Usage (from GhostTrackerApp):
#   powershell -ExecutionPolicy Bypass -File scripts\fake-run.ps1                 # emulator-5554, 120 s
#   powershell -ExecutionPolicy Bypass -File scripts\fake-run.ps1 -Device emulator-5556 -Seconds 300
param(
  [string]$Device = "emulator-5554",
  [int]$Seconds = 120,
  [double]$SpeedMs = 3.0,
  [double]$StartLat = 6.8418,
  [double]$StartLon = 79.8916
)

$adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
$mPerDegLat = 111320.0
$mPerDegLon = 111320.0 * [Math]::Cos($StartLat * [Math]::PI / 180)
$step = $SpeedMs / [Math]::Sqrt(2)   # equal north and east components

Write-Host "Simulated run on $Device for $Seconds s at $SpeedMs m/s. Start the run in the app now."
for ($i = 0; $i -le $Seconds; $i++) {
  $lat = $StartLat + ($i * $step) / $mPerDegLat
  $lon = $StartLon + ($i * $step) / $mPerDegLon
  # geo fix takes longitude first
  & $adb -s $Device emu geo fix ("{0:F7}" -f $lon) ("{0:F7}" -f $lat) | Out-Null
  if ($i % 10 -eq 0) { Write-Host ("{0,4} s  ~{1,5:N0} m" -f $i, ($i * $SpeedMs)) }
  Start-Sleep -Milliseconds 1000
}
Write-Host "Done. Stop and save the run in the app."
