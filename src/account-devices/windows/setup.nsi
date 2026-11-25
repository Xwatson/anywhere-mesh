Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"
!include "release.nsh"
!define NAME "AnywhereMesh"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\AnywhereMesh"
!define RELDIR "app-${RELEASE}"
Name "AnywhereMesh"
OutFile "AnywhereMesh-${VERSION}-win-x64-Setup.exe"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\AnywhereMesh"
SetCompressor zlib
Icon "payload/resources/AnywhereMesh.ico"
UninstallIcon "payload/resources/AnywhereMesh.ico"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "AnywhereMesh"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "AnywhereMesh Windows x64 Setup"
VIAddVersionKey "FileVersion" "${VERSION}.0"
VIAddVersionKey "LegalCopyright" "AnywhereMesh"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "需要 64 位 Windows。"
    Abort
  ${EndIf}
  SetRegView 64
  SetShellVarContext current
FunctionEnd

Section "AnywhereMesh"
  SetOutPath "$INSTDIR\${RELDIR}"
  ClearErrors
  File /r "payload/*"
  IfErrors failed
  ; This directory contains the pinned runtime and public certificates only.
  nsExec::ExecToStack '"$SYSDIR\icacls.exe" "$INSTDIR\${RELDIR}\resources\tools" /grant "*S-1-15-2-1:(OI)(CI)RX"'
  Pop $0
  Pop $1
  StrCmp $0 "0" +2
  Goto failed
  FileOpen $0 "$INSTDIR\${RELDIR}\installed.release" w
  FileWrite $0 "${RELEASE}"
  FileClose $0
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  SetOutPath "$INSTDIR\${RELDIR}"
  CreateShortcut "$DESKTOP\AnywhereMesh.lnk" "$INSTDIR\${RELDIR}\AnywhereMesh.exe" "" "$INSTDIR\${RELDIR}\resources\AnywhereMesh.ico"
  CreateShortcut "$SMPROGRAMS\AnywhereMesh.lnk" "$INSTDIR\${RELDIR}\AnywhereMesh.exe" "" "$INSTDIR\${RELDIR}\resources\AnywhereMesh.ico"
  WriteRegStr HKCU "${REGKEY}" "DisplayName" "AnywhereMesh"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${REGKEY}" "Publisher" "AnywhereMesh"
  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "DisplayIcon" "$INSTDIR\${RELDIR}\resources\AnywhereMesh.ico"
  WriteRegStr HKCU "${REGKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${REGKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1
  IfErrors failed
  ; Best-effort cleanup of previous app-<release> directories
  FindFirst $0 $1 "$INSTDIR\app-????????????????"
  cleanup_loop:
    StrCmp $1 "" cleanup_done
    StrCmp $1 "${RELDIR}" cleanup_next
    IfFileExists "$INSTDIR\$1\installed.release" 0 cleanup_next
    RMDir /r "$INSTDIR\$1"
    ClearErrors
  cleanup_next:
    FindNext $0 $1
    Goto cleanup_loop
  cleanup_done:
    FindClose $0
  ; Relaunch updated desktop app if invoked by auto-updater with /RELAUNCH
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/RELAUNCH" $R1
  IfErrors done
  Exec '"$INSTDIR\${RELDIR}\AnywhereMesh.exe"'
  Goto done
  failed:
    SetErrorLevel 1
    Abort "安装未完成。请关闭正在运行的 AnywhereMesh 后重试。"
  done:
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  ; The program directory is fixed per user. Projects and device credentials live elsewhere.
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\AnywhereMesh"
  SetOutPath "$TEMP"
  FindFirst $0 $1 "$INSTDIR\app-????????????????"
  loop:
    StrCmp $1 "" done
    IfFileExists "$INSTDIR\$1\installed.release" 0 next
    ClearErrors
    RMDir /r "$INSTDIR\$1"
    IfErrors locked
  next:
    FindNext $0 $1
    Goto loop
  locked:
    FindClose $0
    SetErrorLevel 1
    Abort "请先关闭 AnywhereMesh，然后重试卸载。"
  done:
    FindClose $0
    Delete "$DESKTOP\AnywhereMesh.lnk"
    Delete "$SMPROGRAMS\AnywhereMesh.lnk"
    Delete "$INSTDIR\Uninstall.exe"
    RMDir "$INSTDIR"
    DeleteRegKey HKCU "${REGKEY}"
SectionEnd
