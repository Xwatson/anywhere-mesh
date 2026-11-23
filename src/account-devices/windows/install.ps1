param([switch]$RuntimeOnly)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'AnywhereMesh'
$runtime = Join-Path $root 'runtime'
$staging = Join-Path $root 'staging'
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Expected a local lab directory' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& "$env:WINDIR\System32\icacls.exe" $root /inheritance:r /grant:r ('*'+$sid+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE) { throw 'Cannot protect the lab directory' }
[void][IO.Directory]::CreateDirectory((Join-Path $root 'artifacts'))
Add-Type -AssemblyName System.IO.Compression.FileSystem
function VerifiedArchive($name, $hash) {
    $path = Join-Path $staging $name
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $hash) { throw "Invalid archive: $name" }
    return $path
}
function ExtractMember($archive, $entry, $dest) {
    $z = [IO.Compression.ZipFile]::OpenRead($archive)
    $temp = $dest + '.' + [guid]::NewGuid().ToString('N')
    try {
        [IO.Compression.ZipFileExtensions]::ExtractToFile($z.GetEntry($entry), $temp, $false)
        if (Test-Path -LiteralPath $dest) {
            if ((Get-FileHash $temp).Hash -ne (Get-FileHash $dest).Hash) { [IO.File]::Replace($temp,$dest,$null) }
        } else { [IO.File]::Move($temp,$dest) }
    } finally { $z.Dispose(); if (Test-Path -LiteralPath $temp) { [IO.File]::Delete($temp) } }
}
$node = VerifiedArchive 'node-v24.21.0-win-x64.zip' '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
$tier = VerifiedArchive 'easytier-windows-x86_64-v2.6.4.zip' '27af91e270e554709b048bd32327fefd2dfce5062ae1e8701af7550c6f525f84'
$electron = VerifiedArchive 'electron-v45.3.3-win32-x64.zip' '49dd2d3875944f08de03d34595cd30093c588b9edcabb41a0ac481028a3a5a8a'
[void][IO.Directory]::CreateDirectory($runtime)
ExtractMember $node 'node-v24.21.0-win-x64/node.exe' (Join-Path $runtime 'node.exe')
& "$env:WINDIR\System32\icacls.exe" (Join-Path $runtime 'node.exe') /grant '*S-1-15-2-1:RX' | Out-Null
if ($LASTEXITCODE) { throw 'Cannot grant sandbox access to the Node runtime' }
ExtractMember $node 'node-v24.21.0-win-x64/LICENSE' (Join-Path $runtime 'node-LICENSE')
foreach ($item in @('easytier-core.exe','Packet.dll')) {
    ExtractMember $tier ('easytier-windows-x86_64/' + $item) (Join-Path $runtime $item)
}
$electronDir = Join-Path $runtime 'electron-v45.3.3'
if (!(Test-Path -LiteralPath $electronDir)) {
    $temp = Join-Path $runtime ([guid]::NewGuid().ToString('N'))
    try {
        [IO.Compression.ZipFile]::ExtractToDirectory($electron, $temp)
        [IO.Directory]::Move($temp, $electronDir)
    } finally { if (Test-Path -LiteralPath $temp) { [IO.Directory]::Delete($temp,$true) } }
}
foreach ($item in @('windows.toml','ca.crt')) {
    $src = Join-Path $staging $item
    $dst = Join-Path $root $item
    if (Test-Path -LiteralPath $dst) {
        if ((Get-FileHash $src).Hash -ne (Get-FileHash $dst).Hash) { throw "Existing deployment differs: $item" }
    } else { [IO.File]::Copy($src,$dst) }
}
if ($RuntimeOnly) { return }

# Extract each code release beside the previous one. Switch the launcher only after successful compilation.
$bundle = Join-Path $staging 'windows-app.zip'
$id = (Get-FileHash -LiteralPath $bundle).Hash.Substring(0,16)
$app = Join-Path $runtime ('app-' + $id)
if (!(Test-Path -LiteralPath $app)) {
    $temp = Join-Path $runtime ([guid]::NewGuid().ToString('N'))
    try {
        [IO.Compression.ZipFile]::ExtractToDirectory($bundle,$temp)
        $native = Join-Path $temp 'src\account-devices\windows'
        foreach ($tool in @('WorkspaceSnapshot','PeerHost','TaskHost','LoginProtection')) {
            $sources = @("$native\$tool.cs")
            if ($tool -eq 'WorkspaceSnapshot') { $sources += "$native\WorkspaceTree.cs" }
            & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /optimize+ /codepage:65001 /platform:x64 /reference:System.Web.Extensions.dll /reference:System.Security.dll "/out:$native\$tool.exe" @sources
            if ($LASTEXITCODE) { throw "$tool compilation failed" }
        }
        [IO.Directory]::Move($temp,$app)
    } finally { if (Test-Path -LiteralPath $temp) { [IO.Directory]::Delete($temp,$true) } }
}
$project = Join-Path $root 'project'
[void][IO.Directory]::CreateDirectory($project)
$fixture = Join-Path $project 'notes.txt'
if (!(Test-Path -LiteralPath $fixture)) {
    [IO.File]::WriteAllText($fixture, 'WINDOWS_ONLY_' + [guid]::NewGuid().ToString('N') + [Environment]::NewLine)
}
$cmd = '@start "" "%~dp0runtime\electron-v45.3.3\electron.exe" "%~dp0runtime\app-' + $id + '\src\desktop" --lab-windows'
[IO.File]::WriteAllText((Join-Path $root 'Start-Anywhere.cmd'), $cmd + [Environment]::NewLine, [Text.Encoding]::ASCII)
Write-Output ('Windows lab release ' + $id)
