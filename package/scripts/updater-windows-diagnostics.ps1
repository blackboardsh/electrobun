param(
  [Parameter(Mandatory=$true)][string]$ChannelRoot,
  [string]$TransactionIdsCsv = ''
)
$ErrorActionPreference = 'Stop'
Write-Output "Snapshot UTC: $([DateTime]::UtcNow.ToString('o'))"

# Only inspect this generated fixture's transactions and processes.
$transactionIds = @($TransactionIdsCsv.Split(',') | Where-Object { $_ -match '^[a-f0-9]{32}$' } | Select-Object -First 32)
Get-ChildItem -LiteralPath $ChannelRoot -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^\.electrobun-update-([a-f0-9]{32})(\.result)?\.json$' } |
  Select-Object -First 32 | ForEach-Object {
  if ($_.Name -match '^\.electrobun-update-([a-f0-9]{32})(\.result)?\.json$') {
    $transactionIds += $Matches[1]
    Write-Output "Transaction file: $($_.Name)"
    if ($_.Length -le 65536 -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      Get-Content -Raw -LiteralPath $_.FullName -ErrorAction Continue
    } else {
      Write-Output "Transaction contents omitted: too large or a reparse point"
    }
  }
}
foreach ($id in ($transactionIds | Select-Object -Unique -First 32)) {
  $taskName = 'ApplicationUpdate_' + $id.Substring(0, 24)
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    $info = $task | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
    [pscustomobject]@{
      TaskName = $taskName; State = [string]$task.State
      LastRunTime = $info.LastRunTime; LastTaskResult = $info.LastTaskResult
      Actions = @($task.Actions | Select-Object Execute, Arguments, WorkingDirectory)
      Principal = $task.Principal | Select-Object UserId, LogonType, RunLevel
    } | ConvertTo-Json -Depth 5
  } else {
    Write-Output "Task no longer registered: $taskName"
  }
}
$rootPrefix = $ChannelRoot.TrimEnd('\') + '\'
$allProcesses = @(Get-CimInstance Win32_Process)
$ownedProcesses = @($allProcesses | Where-Object {
  ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) -or
  ($_.Name -match '^electrobun-update-([a-f0-9]{32})\.exe$' -and $transactionIds -contains $Matches[1]) -or
  ($_.Name -match '^electrobun-uninstall-[a-f0-9]+\.exe$' -and $_.CommandLine -and
    $_.CommandLine.IndexOf($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0)
} | Select-Object -First 32)
# Managers synchronously wait for System32 tools, whose executable paths are
# outside the fixture. Retain only descendants of the scoped process snapshot.
$ownedIds = @{}
foreach ($process in $ownedProcesses) { $ownedIds[[int]$process.ProcessId] = $true }
for ($depth = 0; $depth -lt 4 -and $ownedProcesses.Count -lt 32; $depth++) {
  $children = @($allProcesses | Where-Object {
    $ownedIds.ContainsKey([int]$_.ParentProcessId) -and -not $ownedIds.ContainsKey([int]$_.ProcessId)
  } | Select-Object -First (32 - $ownedProcesses.Count))
  if ($children.Count -eq 0) { break }
  foreach ($process in $children) { $ownedIds[[int]$process.ProcessId] = $true }
  $ownedProcesses += $children
}
$ownedProcesses | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath,
  @{Name='CommandLine';Expression={ if ($_.CommandLine.Length -gt 8192) { $_.CommandLine.Substring(0,8192) } else { $_.CommandLine } }},
  CreationDate | ConvertTo-Json -Depth 3
