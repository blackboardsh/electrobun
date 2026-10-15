param([Parameter(Mandatory=$true)][string]$ChannelRoot)
$ErrorActionPreference = 'Stop'
Write-Output "Snapshot UTC: $([DateTime]::UtcNow.ToString('o'))"

# Only inspect this generated fixture's transactions and processes.
$transactionIds = @()
Get-ChildItem -LiteralPath $ChannelRoot -File -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.Name -match '^\.electrobun-update-([a-f0-9]{32})(\.result)?\.json$') {
    $transactionIds += $Matches[1]
    Write-Output "Transaction file: $($_.Name)"
    Get-Content -Raw -LiteralPath $_.FullName
  }
}
foreach ($id in ($transactionIds | Select-Object -Unique)) {
  $taskName = 'ApplicationUpdate_' + $id.Substring(0, 24)
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    $info = $task | Get-ScheduledTaskInfo
    [pscustomobject]@{
      TaskName = $taskName; State = [string]$task.State
      LastRunTime = $info.LastRunTime; LastTaskResult = $info.LastTaskResult
      Actions = $task.Actions; Principal = $task.Principal
    } | ConvertTo-Json -Depth 5
  } else {
    Write-Output "Task no longer registered: $taskName"
  }
}
Get-CimInstance Win32_Process | Where-Object {
  ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($ChannelRoot, [StringComparison]::OrdinalIgnoreCase)) -or
  ($_.Name -match '^electrobun-update-([a-f0-9]{32})\.exe$' -and $transactionIds -contains $Matches[1])
} | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate | ConvertTo-Json -Depth 3
