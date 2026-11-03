# Opens the Sync tab and taps "Start Bluetooth Sync" on each emulator (testing helper).
# Usage (from GhostTrackerApp):
#   powershell -ExecutionPolicy Bypass -File scripts\start-sync.ps1
param([string[]]$Devices = @("emulator-5554", "emulator-5556"))

$adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"

function Tap-Text($device, $pattern) {
  & $adb -s $device shell uiautomator dump /sdcard/ui.xml | Out-Null
  [xml]$ui = (& $adb -s $device exec-out cat /sdcard/ui.xml) -join ""
  $node = $ui.SelectNodes("//node") | Where-Object {
    ($_.text -match $pattern) -or ($_.'content-desc' -match $pattern)
  } | Select-Object -Last 1
  if (-not $node) { return $false }
  $b = [regex]::Matches($node.bounds, "\d+") | ForEach-Object { [int]$_.Value }
  $x = [int](($b[0] + $b[2]) / 2); $y = [int](($b[1] + $b[3]) / 2)
  & $adb -s $device shell input tap $x $y | Out-Null
  return $true
}

foreach ($d in $Devices) {
  Write-Host "== $d"
  if (Tap-Text $d '^Sync$') { Write-Host "  opened Sync tab" } else { Write-Host "  Sync tab not found"; continue }
  Start-Sleep -Milliseconds 1500
  if (Tap-Text $d 'Stop Bluetooth Sync') {
    # Already running: we just tapped Stop, so tap Start again.
    Start-Sleep -Milliseconds 1500
    Tap-Text $d 'Start Bluetooth Sync' | Out-Null
    Write-Host "  restarted Bluetooth sync"
  } elseif (Tap-Text $d 'Start Bluetooth Sync') {
    Write-Host "  tapped Start Bluetooth Sync"
  } else {
    Write-Host "  button not found (select 'Bluetooth' in the Sync tab first)"
  }
  Start-Sleep -Milliseconds 1500
  # Allow the Bluetooth permission prompt if it appears
  if (Tap-Text $d '^(Allow|ALLOW)$') { Write-Host "  allowed permission" }
}
Write-Host "Done. Check the Sync tab on each emulator for 'In sync'."
