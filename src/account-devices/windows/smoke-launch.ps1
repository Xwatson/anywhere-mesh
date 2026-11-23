# Run once through the VM's OpenSSH service. The test itself runs on the signed-in user's desktop.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Join-Path $env:LOCALAPPDATA 'AnywhereCodingLab'
$payload = [Console]::In.ReadToEnd()
$inputData = $payload | ConvertFrom-Json
$id = [guid]::ParseExact($inputData.runId, 'D').ToString()
if ($inputData.username -ne 'lab-coder') { throw 'Expected the ordinary lab account' }
$release = [regex]::Match([IO.File]::ReadAllText((Join-Path $root 'Start-Anywhere.cmd')), 'app-[A-F0-9]{16}').Value
if (!$release) { throw 'No installed desktop release' }
$who = [Security.Principal.WindowsIdentity]::GetCurrent()
$acl = New-Object System.IO.Pipes.PipeSecurity
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($who.User,'FullControl','Allow')))
$pipe = [IO.Pipes.NamedPipeServerStream]::new("AnywhereLab-$id", 'InOut', 1, 'Byte', 'Asynchronous', 4096, 4096, $acl)
$task = 'AnywhereLab-Smoke-' + $id
$registered = $false
try {
    $exe = Join-Path $root 'runtime\electron-v45.3.3\electron.exe'
    $argsLine = '"' + (Join-Path $root ('runtime\'+$release+'\src\desktop')) + '" --lab-windows --lab-windows-smoke --lab-smoke-id=' + $id
    $action = New-ScheduledTaskAction -Execute $exe -Argument $argsLine -WorkingDirectory $root
    $user = New-ScheduledTaskPrincipal -UserId $who.Name -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $task -Action $action -Principal $user -Settings $settings | Out-Null
    $registered = $true
    $wait = $pipe.BeginWaitForConnection($null,$null)
    Start-ScheduledTask -TaskName $task
    if (!$wait.AsyncWaitHandle.WaitOne(35000)) { throw 'The native desktop did not connect to its test input pipe' }
    $pipe.EndWaitForConnection($wait)
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $pipe.Write($bytes,0,$bytes.Length)
    $pipe.Flush()
    $pipe.WaitForPipeDrain()
    $pipe.Dispose()
    $deadline = [DateTime]::UtcNow.AddSeconds(255)
    do {
        Start-Sleep -Milliseconds 650
        if ((Get-ScheduledTask -TaskName $task).State -ne 'Running') { break }
    } while ([DateTime]::UtcNow -lt $deadline)
    if ((Get-ScheduledTask -TaskName $task).State -eq 'Running') { throw 'Native desktop test exceeded its deadline' }
    $result = (Get-ScheduledTaskInfo -TaskName $task).LastTaskResult
    if ($result) { throw ('Desktop exited with code ' + $result) }
} finally {
    $pipe.Dispose()
    if ($registered) {
        if ((Get-ScheduledTask -TaskName $task).State -eq 'Running') { Stop-ScheduledTask -TaskName $task }
        Unregister-ScheduledTask -TaskName $task -Confirm:$false
    }
}
