Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "release.nsh"
!define NAME "Anywhere Coding Lab"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\AnywhereCodingLab"
!define RELDIR "app-${RELEASE}"
Name "Anywhere Coding Lab"
OutFile "Anywhere-Coding-Lab-${VERSION}-win-x64-Setup.exe"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\Anywhere Coding Lab"
SetCompressor zlib
Icon "payload/resources/Anywhere.ico"
UninstallIcon "payload/resources/Anywhere.ico"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Anywhere Coding Lab"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "Anywhere Coding Lab Windows x64 Setup"
VIAddVersionKey "FileVersion" "${VERSION}.0"
VIAddVersionKey "LegalCopyright" "Anywhere Coding Lab"
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

Section "Anywhere Coding Lab"
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
  CreateShortcut "$DESKTOP\Anywhere Coding Lab.lnk" "$INSTDIR\${RELDIR}\Anywhere Coding Lab.exe" "" "$INSTDIR\${RELDIR}\resources\Anywhere.ico"
  CreateShortcut "$SMPROGRAMS\Anywhere Coding Lab.lnk" "$INSTDIR\${RELDIR}\Anywhere Coding Lab.exe" "" "$INSTDIR\${RELDIR}\resources\Anywhere.ico"
  WriteRegStr HKCU "${REGKEY}" "DisplayName" "Anywhere Coding Lab"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${REGKEY}" "Publisher" "Anywhere Coding Lab"
  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "DisplayIcon" "$INSTDIR\${RELDIR}\resources\Anywhere.ico"
  WriteRegStr HKCU "${REGKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${REGKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1
  IfErrors failed
  Goto done
  failed:
    SetErrorLevel 1
    Abort "安装未完成。请关闭正在运行的实验客户端后重试。"
  done:
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  ; The program directory is fixed per user. Projects and device credentials live elsewhere.
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Anywhere Coding Lab"
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
    Abort "请先关闭 Anywhere Coding Lab，然后重试卸载。"
  done:
    FindClose $0
    Delete "$DESKTOP\Anywhere Coding Lab.lnk"
    Delete "$SMPROGRAMS\Anywhere Coding Lab.lnk"
    DeleteRegKey HKCU "${REGKEY}"
    Delete "$INSTDIR\Uninstall.exe"
    RMDir "$INSTDIR"
SectionEnd
