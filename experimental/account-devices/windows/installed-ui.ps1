param([string]$RunId, [switch]$Interactive)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Core
$base = Join-Path $env:LOCALAPPDATA 'AnywhereCodingLab'
$art = Join-Path $base 'artifacts'
[void][IO.Directory]::CreateDirectory($art)
if (!$Interactive) {
    $json = [Console]::In.ReadToEnd()
    $inputData = $json | ConvertFrom-Json
    $RunId = [guid]::ParseExact($inputData.runId,'D').ToString()
    if ($inputData.username -ne 'lab-coder') { throw 'Expected ordinary lab account' }
    $who = [Security.Principal.WindowsIdentity]::GetCurrent()
    $acl = New-Object System.IO.Pipes.PipeSecurity
    $acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($who.User,'FullControl','Allow')))
    $pipe = [IO.Pipes.NamedPipeServerStream]::new("AnywhereUI-$RunId",'Out',1,'Byte','Asynchronous',4096,4096,$acl)
    $task = "AnywhereLab-Installed-$RunId"
    $registered = $false
    try {
        $arg = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "' + $PSCommandPath + '" -Interactive -RunId '+$RunId
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
        $principal = New-ScheduledTaskPrincipal -UserId $who.Name -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 9) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings | Out-Null
        $registered=$true
        $wait=$pipe.BeginWaitForConnection($null,$null)
        Start-ScheduledTask $task
        if (!$wait.AsyncWaitHandle.WaitOne(40000)) {throw 'Interactive verifier did not connect'}
        $pipe.EndWaitForConnection($wait)
        $bytes=[Text.Encoding]::UTF8.GetBytes($json);$pipe.Write($bytes,0,$bytes.Length);$pipe.Flush();$pipe.Dispose()
        do {Start-Sleep -Milliseconds 600} while ((Get-ScheduledTask $task).State -eq 'Running')
        $result=(Get-ScheduledTaskInfo $task).LastTaskResult
        $file=Join-Path $art "installed-$RunId.json"
        if (Test-Path $file) { Get-Content -LiteralPath $file -Encoding UTF8 -Raw }
        if ($result) { throw "Interactive UI test exited with $result" }
    } finally {
        $pipe.Dispose()
        if ($registered) {Unregister-ScheduledTask $task -Confirm:$false}
    }
    return
}
$RunId=[guid]::ParseExact($RunId,'D').ToString()
$pipe=[IO.Pipes.NamedPipeClientStream]::new('.',"AnywhereUI-$RunId",'In')
$pipe.Connect(15000)
$reader=[IO.StreamReader]::new($pipe,[Text.Encoding]::UTF8)
$auth=$reader.ReadToEnd() | ConvertFrom-Json
$reader.Dispose();$pipe.Dispose()
if ($auth.runId -ne $RunId -or $auth.username -ne 'lab-coder') { throw 'Unexpected verifier input' }
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms,System.Drawing
$utf8=[Text.UTF8Encoding]::new($false)
$state=[ordered]@{runId=$RunId;phase='launching';passed=$false;checks=@()}
$report=Join-Path $art "installed-$RunId.json"
function Save-Report { [IO.File]::WriteAllText($report,($state|ConvertTo-Json -Depth 5),$utf8) }
function Phase($text) { $state.phase=$text; Save-Report }
function Wait-For($stage,[scriptblock]$fn,$seconds=42) {
    $end=(Get-Date).AddSeconds($seconds)
    do {
      try {$waitResult=& $fn; if($waitResult) {return $waitResult}} catch [System.Windows.Automation.ElementNotAvailableException] {}
      Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $end)
    throw "Timed out while waiting for $stage"
}
function Find-Element($field,$value,$kind) {
    $prop=if ($field -eq 'id') {[System.Windows.Automation.AutomationElement]::AutomationIdProperty} else {[System.Windows.Automation.AutomationElement]::NameProperty}
    $condition=[System.Windows.Automation.PropertyCondition]::new($prop,[string]$value)
    if($kind) {
        foreach($candidate in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)) {
            if ($candidate.Current.ControlType.ProgrammaticName -eq $kind) {return $candidate}
        }
        return
    }
    $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
}
function Element($field,$value) { Wait-For $value { Find-Element $field $value } }
function Press($field,$value) {
    $state.action="Press $value"
    $e=Wait-For $value { $n=Find-Element $field $value 'ControlType.Button'; if($n -and $n.Current.IsEnabled){$n} }
    $pattern=$null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {$pattern.Invoke()}
    else {$e.SetFocus();[Windows.Forms.SendKeys]::SendWait('{ENTER}')}
}
function Edit($id,$value) {
    $state.action="Edit $id"
    $e=Element 'id' $id
    $e.SetFocus()
    $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($value)
}
function Mode($mode) {
    $entry=Element 'id' 'mode'
    $entry.SetFocus()
    [Windows.Forms.SendKeys]::SendWait('{HOME}')
    if ($mode -eq 'read') { [Windows.Forms.SendKeys]::SendWait('{DOWN}') }
    $button=Element 'id' 'apply'
    if($button.Current.IsEnabled) {Press 'id' 'apply'}
    [void](Wait-For "applied permission $mode" {
        $apply=Find-Element 'id' 'apply'
        $create=Find-Element 'name' '新建会话' 'ControlType.Button'
        if($create -and $create.Current.IsEnabled -and $apply -and !$apply.Current.IsEnabled){$create}
    })
}
function Shot($suffix) {
    $r=$window.Current.BoundingRectangle
    $bmp=[Drawing.Bitmap]::new([int]$r.Width,[int]$r.Height)
    $gfx=[Drawing.Graphics]::FromImage($bmp)
    try {
        $gfx.CopyFromScreen([int]$r.Left,[int]$r.Top,0,0,$bmp.Size)
        $bmp.Save((Join-Path $art "installed-$RunId-$suffix.png"),[Drawing.Imaging.ImageFormat]::Png)
    } finally {$gfx.Dispose();$bmp.Dispose()}
}
function Hash-Text($text) {
    $sha=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant() }
    finally {$sha.Dispose()}
}
function Send-Message($message) {Edit 'draft' $message;Press 'id' 'send'}
$file="gui-$RunId.txt";$fixture=Join-Path (Join-Path $base 'project') $file
$marker='GUI_'+[guid]::NewGuid().ToString('N')
$created=$false;$signed=$false
try {
    $shortcut=Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Anywhere Coding Lab.lnk'
    $target=(New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath
    if ($target -notlike "$env:LOCALAPPDATA\Programs\Anywhere Coding Lab\app-*\Anywhere Coding Lab.exe") {throw 'Expected installed shortcut'}
    Start-Process -FilePath $shortcut
    $proc=Wait-For 'installed desktop window' { Get-Process -Name 'Anywhere Coding Lab' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1 }
    $window=[System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
    $state.shortcut=$shortcut;$state.target=$target;$state.windowPid=$proc.Id
    $state.checks+='installed-shortcut'
    Phase 'login'
    $initial=Wait-For 'sign-in form or existing account' {
        if(Find-Element 'id' 'logout') {'signed-in'} elseif(Find-Element 'id' 'username') {'sign-in'}
    }
    if($initial -eq 'signed-in') {
        $labels=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
        if(!($labels | Where-Object {$_.Current.Name -like 'lab-coder · Windows*'})) {throw 'A different account is using this desktop'}
        Press 'id' 'logout'
    }
    $userField=Element 'id' 'username'
    for($attempt=1;$attempt -le 3;$attempt++) {
        Edit 'username' $auth.username
        Edit 'password' $auth.password
        Press 'name' '登录'
        $outcome=Wait-For 'sign-in response' {
            if (Find-Element 'id' 'logout') {'ok'}
            else {$msg=Find-Element 'id' 'login-error';if($msg -and $msg.Current.Name){$msg.Current.Name}}
        } 55
        if($outcome -eq 'ok') {$signed=$true;break}
        if($attempt -eq 3) {throw 'Sign-in failed'}
    }
    $auth=$null
    $state.checks+='desktop-login'
    Phase 'grant'
    Mode 'read'
    $state.sessionTitle='Windows 安装版联调 '+$RunId.Substring(0,8)
    Edit 'title' $state.sessionTitle
    Press 'name' '新建会话'
    [void](Element 'name' $state.sessionTitle)
    [void](Element 'id' 'draft')
    $state.checks+='locally-granted-read'
    $stream=[IO.File]::Open($fixture,[IO.FileMode]::CreateNew)
    try { $bytes=$utf8.GetBytes($marker+[Environment]::NewLine);$stream.Write($bytes,0,$bytes.Length) } finally {$stream.Dispose()}
    $created=$true
    $state.expectedSha256=Hash-Text $marker
    $state.file=$file
    Phase 'first-turn'
    Send-Message ('请读取当前 Windows 项目中「'+$file+'」的第一行，只回复这一行原文。')
    [void](Wait-For 'model file answer' {Find-Element 'name' $marker} 205)
    [void](Element 'name' 'Codex')
    $state.checks+='exact-model-file-answer'
    Shot 'file'
    [IO.File]::Delete($fixture);$created=$false
    Phase 'followup'
    Send-Message '请直接从你刚才的回答取最后八个字符，只回复这八个字符。'
    $suffix=$marker.Substring($marker.Length-8)
    [void](Wait-For 'follow-up answer' {Find-Element 'name' $suffix} 205)
    $state.followupSha256=Hash-Text $suffix
    $state.checks+='same-session-followup-after-file-removed'
    Shot 'followup'
    Phase 'revoke'
    Mode 'revoked'
    Press 'id' 'logout'
    [void](Element 'id' 'username')
    $signed=$false
    $state.checks+='revoked-and-signed-out'
    $state.passed=$true;Phase 'passed'
} catch {
    $state.error=$_.Exception.Message
    $state.line=$_.InvocationInfo.ScriptLineNumber
    if ($window) { try {
        Shot 'diagnostic'
        $state.controls=@($window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition) | Where-Object {$_.Current.AutomationId} | ForEach-Object {$_.Current.AutomationId+' '+$_.Current.ControlType.ProgrammaticName+' '+$_.Current.IsEnabled})
    } catch {} }
    Save-Report
    throw
} finally {
    if ($created) {[IO.File]::Delete($fixture)}
    if ($signed) { try {Press 'id' 'logout'} catch {} }
}
