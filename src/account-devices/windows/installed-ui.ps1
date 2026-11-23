param([string]$RunId, [switch]$Interactive)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Core
$base = Join-Path $env:LOCALAPPDATA 'AnywhereMesh'
$art = Join-Path $base 'artifacts'
[void][IO.Directory]::CreateDirectory($art)
if (!$Interactive) {
    $json = [Console]::In.ReadToEnd()
    $inputData = $json | ConvertFrom-Json
    $RunId = [guid]::ParseExact($inputData.runId,'D').ToString()
    if ($inputData.username -ne $(if ($inputData.fresh) {'lab-other'} else {'lab-coder'})) { throw 'Expected ordinary lab account' }
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
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
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
if ($auth.runId -ne $RunId -or $auth.username -ne $(if ($auth.fresh) {'lab-other'} else {'lab-coder'})) { throw 'Unexpected verifier input' }
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
    elseif ($e.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)) {$pattern.Expand()}
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
    switch ($mode) {
        'read' { [Windows.Forms.SendKeys]::SendWait('{DOWN}') }
        'edit' { [Windows.Forms.SendKeys]::SendWait('{DOWN 2}') }
        'execute' { [Windows.Forms.SendKeys]::SendWait('{END}'); [void](Element 'name' '授予完全访问'); Shot 'full-permission' }
    }
    Press 'id' 'apply'
    [void](Wait-For "applied permission $mode" {$b=Find-Element 'id' 'context';if($b -and $b.Current.IsEnabled -and !(Find-Element 'id' 'mode')){$b}})
}
function Sign-In {
    Edit 'username' $auth.username; Edit 'password' $auth.password
    Press 'id' 'login-submit'
    # Enrollment and first state synchronization retry inside the client.
    $submitted=Get-Date
    $outcome=Wait-For 'sign-in after one submission' {
        if(Find-Element 'id' 'account-menu' 'ControlType.Button') {'ok'}
        elseif(((Get-Date)-$submitted).TotalSeconds -gt 1) {
            $errorBox=Find-Element 'id' 'login-error'
            if($errorBox) {
                $nodes=$errorBox.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
                $nodes | ForEach-Object {$_.Current.Name} | Where-Object {$_} | Select-Object -First 1
            }
        }
    } 150
    if($outcome -ne 'ok') {throw ('Sign-in failed: '+$outcome)}
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
$fresh=[bool]$auth.fresh
if ($fresh) {
    $freshData=Join-Path $env:TEMP ("Anywhere-FirstRun-"+$RunId)
    if (Test-Path $freshData) {throw 'Test app data already exists'}
    [void][IO.Directory]::CreateDirectory($freshData)
    $base=Join-Path $freshData 'AnywhereMesh'
}
function Launch-Fresh {
    $start=[Diagnostics.ProcessStartInfo]::new($target)
    $start.UseShellExecute=$false
    $start.EnvironmentVariables['LOCALAPPDATA']=$freshData
    $started=[Diagnostics.Process]::Start($start)
    Wait-For 'isolated installed desktop' {
        $started.Refresh()
        if ($started.HasExited) {throw 'Isolated installed desktop exited'}
        if ($started.MainWindowHandle -ne 0) {$started}
    }
}
$file='笔记-'+$RunId.Substring(0,8)+'.txt';$fixture=Join-Path (Join-Path $base 'project') $file
$marker='GUI_'+[guid]::NewGuid().ToString('N')
$created=$false;$signed=$false
try {
    $shortcut=Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'AnywhereMesh.lnk'
    $target=(New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath
    if ($target -notlike "$env:LOCALAPPDATA\Programs\AnywhereMesh\app-*\AnywhereMesh.exe") {throw 'Expected installed shortcut'}
    if ($fresh) { $proc=Launch-Fresh } else {
    Start-Process -FilePath $shortcut
    $proc=Wait-For 'installed desktop window' { Get-Process -Name 'AnywhereMesh' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1 }
    }
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
    if ($fresh) {
        $legacy=Join-Path $base 'windows.toml'
        $network=Join-Path $base 'network-session.toml'
        if ($initial -ne 'sign-in' -or (Test-Path $legacy) -or (Test-Path $network)) {throw 'Profile was already configured'}
        Shot 'signin'
        $state.checks+='first-launch-without-toml'
        if (!$auth.projectAccess -and !$auth.remember) {
            Edit 'username' $auth.username
            Edit 'password' ([guid]::NewGuid().ToString())
            Press 'name' '登录'
            [void](Element 'name' '账号或密码不正确。')
            if (Test-Path $network) {throw 'Network configured before authentication'}
            $state.checks+='invalid-password-does-not-provision'
        }
    }
    Sign-In; $signed=$true
    if ($fresh) {
        if (Test-Path $legacy) {throw 'Unexpected legacy network config'}
        if (Test-Path $network) {
            $content=[IO.File]::ReadAllText($network)
            if ($content -match 'network_secret|local_private_key|credential\s*=') {throw 'Unexpected private material on disk'}
            $instance=([regex]::Match($content,'instance_id = "([a-f0-9-]{36})"')).Groups[1].Value
            if (!$instance) {throw 'Missing device identity'}
        } else {
            $vaultInit=Join-Path $base 'state\login.dpapi'
            if (!(Test-Path $vaultInit)) {throw 'Missing saved login vault'}
            Add-Type -AssemblyName System.Security
            $plainInit=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($vaultInit),$utf8.GetBytes('AnywhereMesh device login v1'),'CurrentUser')
            $instance=($utf8.GetString($plainInit)|ConvertFrom-Json).deviceId
            if (!$instance) {throw 'Missing direct-transport device identity'}
        }
        $state.checks+='automatic-network-config'
    }
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
    [void](Wait-For 'interactive composer controls' { $btn=Find-Element 'id' 'context'; if($btn -and $btn.Current.IsEnabled){$btn} })
    if (!$auth.remember) {
        Press 'id' 'device-status'
        [void](Element 'name' '我的设备')
        [void](Wait-For 'local Windows device' {$nodes=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition);$nodes | Where-Object {$_.Current.Name -like ('Windows · '+$env:COMPUTERNAME+' · 本机')} | Select-Object -First 1})
        Press 'name' '关闭'
        $state.checks+='device-status-on-demand'
    }
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
    if ($auth.remember) {
        Phase 'closing-signed-in'
        $vault=Join-Path $base 'state\login.dpapi'
        $sealed=[IO.File]::ReadAllBytes($vault)
        Add-Type -AssemblyName System.Security
        $plain=[Security.Cryptography.ProtectedData]::Unprotect($sealed,$utf8.GetBytes('AnywhereMesh device login v1'),'CurrentUser')
        $record=$utf8.GetString($plain)|ConvertFrom-Json
        if($record.token -notmatch '^[a-zA-Z0-9_-]{43}$' -or $record.deviceId -ne $instance -or $utf8.GetString($sealed).Contains($record.token) -or $utf8.GetString($plain).Contains($auth.password)){throw 'Unexpected credential storage'}
        $state.deviceId=$instance
        $state.checks+='dpapi-device-token-without-password'
        if (!$proc.CloseMainWindow() -or !$proc.WaitForExit(30000)) {throw 'Signed-in test desktop did not close'}
        $signed=$false
        if (!(Test-Path $vault)) {throw 'Closing discarded the login'}
        $proc=Launch-Fresh
        $window=[System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
        Phase 'automatic-login'
        [void](Wait-For 'automatic sign-in without entering a password' {Find-Element 'id' 'account-menu'} 175)
        $signed=$true
        Press 'name' $state.sessionTitle
        [void](Wait-For 'previous reply after reopening' {Find-Element 'name' $marker} 65)
        [void](Wait-For 'restored project permission' {Find-Element 'name' '只读'} 45)
        if ((Test-Path $network) -and ![IO.File]::ReadAllText($network).Contains($instance)) {throw 'Restore selected a different device'}
        if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($vault)) -ne [Convert]::ToBase64String($sealed)) {throw 'Restore replaced the existing login'}
        $state.checks+='close-keeps-login','same-login-and-device-after-reopen','previous-chat-restored','same-project-grant'
        Shot 'restored'
        Sign-Out; [void](Element 'id' 'username');$signed=$false
        if(Test-Path $vault){throw 'Explicit logout left a remembered credential'}
        if (!$proc.CloseMainWindow() -or !$proc.WaitForExit(30000)) {throw 'Signed-out test desktop did not close'}
        $proc=Launch-Fresh
        $window=[System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
        [void](Element 'id' 'username')
        if(Find-Element 'id' 'account-menu'){throw 'Explicit logout was reversed on restart'}
        $state.checks+='logout-removes-vault','reopen-after-logout-requires-sign-in'
        # Revisit an old encrypted backup in this isolated profile. A revoked server
        # session must be rejected even when its local ciphertext is still available.
        if (!$proc.CloseMainWindow() -or !$proc.WaitForExit(30000)) {throw 'Test login window did not close'}
        [IO.File]::WriteAllBytes($vault,$sealed)
        $proc=Launch-Fresh
        $window=[System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
        [void](Wait-For 'revoked login rejected after relaunch' {if(!(Test-Path $vault)){Find-Element 'id' 'username'}} 150)
        $state.checks+='server-revocation-enforced'
        $state.passed=$true;Phase 'passed'
        return
    }
    Phase 'followup'
    Send-Message '请直接从你刚才的回答取最后八个字符，只回复这八个字符。'
    $suffix=$marker.Substring($marker.Length-8)
    [void](Wait-For 'follow-up answer' {Find-Element 'name' $suffix} 205)
    $state.followupSha256=Hash-Text $suffix
    $state.checks+='same-session-followup-after-file-removed'
    Shot 'followup'
    if ($fresh) {
        Phase 'full-access'
        Mode 'execute'
        $prefix='access-'+$RunId.Substring(0,8)
        $source=$prefix+'-source.txt';$product=$prefix+'-result.txt'
        $testProject=Split-Path -Parent $fixture
        $sourcePath=Join-Path $testProject $source;$resultPath=Join-Path $testProject $product
        if ((Test-Path $sourcePath) -or (Test-Path $resultPath)) {throw 'Existing test output'}
        Send-Message ('请使用 workspace_write_file 新建 '+$source+'，文件内容是你上一条回复的八个字符。然后必须使用 workspace_run 执行 Windows 命令 copy /Y '+$source+' '+$product+'。两个操作都成功后只回复 DONE_'+$prefix+'。')
        [void](Wait-For 'real Codex file write and project command' {
            if ((Test-Path $sourcePath) -and (Test-Path $resultPath)) {
                ([IO.File]::ReadAllText($sourcePath).Trim() -ceq $suffix) -and ([IO.File]::ReadAllText($resultPath).Trim() -ceq $suffix)
            }
        } 207)
        [void](Wait-For 'completed full-access turn' {$send=Find-Element 'id' 'send';if($send){$send}} 35)
        $state.commandFile=$product
        $state.checks+='same-thread-grant-upgrade','retained-history-used-for-write','real-codex-project-write','real-codex-windows-command'
        Shot 'command'
    }
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
    if ($fresh) {
        Send-Message ('请读取 '+$product)
        [void](Element 'id' 'consent-mode')
        Press 'id' 'cancel-consent'
        $state.checks+='revocation-requires-local-consent-again'
    }
    Sign-Out
    [void](Element 'id' 'username')
    $signed=$false
    $state.checks+='revoked-and-signed-out'
    if ($fresh) {
        if (!$proc.CloseMainWindow() -or !$proc.WaitForExit(15000)) {throw 'Isolated desktop did not close'}
        $proc=Launch-Fresh
        $window=[System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
        Sign-In; $signed=$true
        [void](Element 'name' $state.sessionTitle)
        if ((Test-Path $network) -and ![IO.File]::ReadAllText($network).Contains($instance)) {throw 'Device identity changed on second launch'}
        Sign-Out; [void](Element 'id' 'username'); $signed=$false
        $state.checks+='relaunch-same-device-and-thread'
    }
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
    if ($fresh -and $proc -and !$proc.HasExited) { [void]$proc.CloseMainWindow(); [void]$proc.WaitForExit(15000) }
}
