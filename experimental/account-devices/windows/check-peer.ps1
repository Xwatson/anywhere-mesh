# Verify cleanup on this VM while its test desktop is closed.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Join-Path $env:LOCALAPPDATA 'AnywhereCodingLab'
$release = [regex]::Match([IO.File]::ReadAllText((Join-Path $root 'Start-Anywhere.cmd')), 'app-[A-F0-9]{16}').Value
if (!$release) { throw 'No installed desktop release' }
$native = Join-Path $root ("runtime\$release\experimental\account-devices\windows")
$node = Join-Path $root 'runtime\node.exe'
function RouteSummary {
    return @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | ForEach-Object { "$($_.InterfaceIndex):$($_.NextHop)" } | Sort-Object) -join ','
}
$initialRoute = RouteSummary
foreach ($failure in @('backend','supervisor')) {
    if (Get-NetTCPConnection -State Listen -LocalPort 31844,31897 -ErrorAction SilentlyContinue) { throw 'Close the lab desktop before testing' }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $node
    $info.Arguments = '"' + (Join-Path $native 'controller.mjs') + '"'
    $info.WorkingDirectory = $root
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.CreateNoWindow = $true
    $backend = [Diagnostics.Process]::Start($info)
    try {
        $limit = [DateTime]::UtcNow.AddSeconds(18)
        do {
            $listener = Get-NetTCPConnection -State Listen -LocalPort 31844 -ErrorAction SilentlyContinue
            if ($listener) { break }
            Start-Sleep -Milliseconds 180
        } while (!$backend.HasExited -and [DateTime]::UtcNow -lt $limit)
        if (!$listener -or $backend.HasExited) { throw 'The Windows network backend did not start' }
        $core = Get-Process -Id $listener.OwningProcess
        $supervisorId = (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $core.Id)).ParentProcessId
        $supervisor = Get-Process -Id $supervisorId
        $parent = (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $supervisorId)).ParentProcessId
        if ($parent -ne $backend.Id -or $supervisor.Path -ne (Join-Path $native 'PeerHost.exe') -or
            $core.Path -ne (Join-Path $root 'runtime\easytier-core.exe')) { throw 'Unexpected process owner' }
        if ((RouteSummary) -ne $initialRoute) { throw 'Default route changed' }
        if ($failure -eq 'backend') { $backend.Kill() } else { $supervisor.Kill() }
        foreach ($process in @($core,$supervisor,$backend)) {
            if (!$process.WaitForExit(6000)) { throw 'A network test process survived its owner' }
        }
        if (Get-NetTCPConnection -State Listen -LocalPort 31844,31897 -ErrorAction SilentlyContinue) { throw 'A test port is still open' }
        Write-Output ($failure + ': peer exited and ports released')
    } finally {
        if (!$backend.HasExited) { $backend.StandardInput.Close(); [void]$backend.WaitForExit(6500) }
    }
}
