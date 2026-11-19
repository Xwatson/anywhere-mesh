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
    Press 'id' 'context'
    $entry=Element 'id' 'mode'
    $entry.SetFocus()
    [Windows.Forms.SendKeys]::SendWait('{HOME}')
    if ($mode -eq 'read') { [Windows.Forms.SendKeys]::SendWait('{DOWN}') }
    Press 'id' 'apply'
    [void](Wait-For "applied permission $mode" {$b=Find-Element 'id' 'context';if($b -and $b.Current.IsEnabled -and !(Find-Element 'id' 'mode')){$b}})
}
function Sign-Out { Press 'id' 'account-menu'; Press 'id' 'logout' }
function Close-OpenDialog {
    if (Find-Element 'name' '关闭' 'ControlType.Button') { Press 'name' '关闭' }
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
$file='笔记-'+$RunId.Substring(0,8)+'.txt';$fixture=Join-Path (Join-Path $base 'project') $file
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
        Close-OpenDialog
        if(Find-Element 'id' 'account-menu') {'signed-in'} elseif(Find-Element 'id' 'username') {'sign-in'}
    }
    if($initial -eq 'signed-in') {
        $labels=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
        if(!($labels | Where-Object {$_.Current.Name -eq 'lab-coder'})) {throw 'A different account is using this desktop'}
        Sign-Out
    }
    $userField=Element 'id' 'username'
    for($attempt=1;$attempt -le 3;$attempt++) {
        Edit 'username' $auth.username
        Edit 'password' $auth.password
        Press 'name' '登录'
        $outcome=Wait-For 'sign-in response' {
            if (Find-Element 'id' 'account-menu') {'ok'}
            else {$msg=Find-Element 'id' 'login-error';if($msg -and $msg.Current.Name){$msg.Current.Name}}
        } 55
        if($outcome -eq 'ok') {$signed=$true;break}
        if($attempt -eq 3) {throw 'Sign-in failed'}
    }
    $auth=$null
    $state.checks+='desktop-login'
    Phase 'home'
    [void](Element 'name' '从哪里开始？')
    [void](Element 'id' 'draft')
    if((Find-Element 'id' 'mode') -or (Find-Element 'id' 'fleet') -or (Find-Element 'id' 'logout')) {throw 'Settings unexpectedly visible on home'}
    $state.checks+='composer-first-home'
    [void](Wait-For 'local device online' {
        $badge=Find-Element 'id' 'device-status'
        if($badge -and ($badge.Current.Name -like '*在线*' -or $badge.Current.HelpText -like '*在线*')){$badge}
    } 65)
    Shot 'home'
    Press 'id' 'device-status'
    [void](Element 'name' '我的设备')
    [void](Wait-For 'local Windows device' {$nodes=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition);$nodes | Where-Object {$_.Current.Name -like ('Windows · '+$env:COMPUTERNAME+' · 本机')} | Select-Object -First 1})
    Press 'name' '关闭'
    $state.checks+='device-status-on-demand'
    $stream=[IO.File]::Open($fixture,[IO.FileMode]::CreateNew)
    try { $bytes=$utf8.GetBytes($marker+[Environment]::NewLine);$stream.Write($bytes,0,$bytes.Length) } finally {$stream.Dispose()}
    $created=$true
    $state.expectedSha256=Hash-Text $marker
    $state.file=$file
    Phase 'first-turn'
    $promptText='请读取 '+$file+' 的首行，只回复原文。'
    $state.sessionTitle=if($promptText.Length -gt 32){$promptText.Substring(0,31)+'…'}else{$promptText}
    Send-Message $promptText
    [void](Element 'name' '允许读取这个项目？')
    Shot 'consent'
    Press 'id' 'cancel-consent'
    $draft=Element 'id' 'draft'
    if($draft.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -ne $promptText){throw 'Cancelled grant lost the draft'}
    if(Find-Element 'name' $state.sessionTitle 'ControlType.Button'){throw 'Cancelled grant created a thread'}
    Press 'id' 'send'
    Press 'id' 'allow-send'
    [void](Element 'name' $state.sessionTitle)
    $state.checks+='cancel-keeps-draft','first-send-grants-read-and-creates-thread'
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
    Phase 'search'
    Press 'id' 'new-chat'
    [void](Element 'name' '从哪里开始？')
    Press 'id' 'find-chat'
    Edit 'search-input' $file
    [void](Wait-For 'thread search result' {
        $dialog=Find-Element 'id' 'search-dialog'
        if ($dialog) {
            $nodes=$dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
            $nodes | Where-Object {$_.Current.Name -like ('*'+$file+'*') -and $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Button'} | Select-Object -First 1
        }
    })
    (Element 'id' 'search-input').SetFocus()
    [Windows.Forms.SendKeys]::SendWait('{ENTER}')
    [void](Element 'name' $suffix)
    $state.checks+='search-reopens-bound-thread'
    Phase 'revoke'
    Mode 'revoked'
    Sign-Out
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
    if ($signed) { try {
        Close-OpenDialog
        Sign-Out
    } catch {} }
}
