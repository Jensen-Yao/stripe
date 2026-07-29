Unicode true

!ifndef SOURCE_DIR
  !error "SOURCE_DIR is required"
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required"
!endif
!ifndef ICON_FILE
  !error "ICON_FILE is required"
!endif

Name "卫星条带规划工具"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Stripe"
InstallDirRegKey HKCU "Software\Stripe" "InstallLocation"
RequestExecutionLevel user
Icon "${ICON_FILE}"
UninstallIcon "${ICON_FILE}"
SetCompressor /SOLID lzma
SetCompressorDictSize 32
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "0.3.8.0"
VIAddVersionKey /LANG=2052 "ProductName" "卫星条带规划工具"
VIAddVersionKey /LANG=2052 "CompanyName" "Jensen-Yao"
VIAddVersionKey /LANG=2052 "FileDescription" "卫星规划、轨道分析与条带设计工作台"
VIAddVersionKey /LANG=2052 "FileVersion" "0.3.8"
VIAddVersionKey /LANG=2052 "ProductVersion" "0.3.8"

!include "MUI2.nsh"
!define MUI_ABORTWARNING
!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Stripe.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动卫星条带规划工具"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "安装" SEC_MAIN
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${SOURCE_DIR}\*.*"
  WriteUninstaller "$INSTDIR\卸载.exe"
  WriteRegStr HKCU "Software\Stripe" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stripe" "DisplayName" "卫星条带规划工具"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stripe" "DisplayIcon" "$INSTDIR\Stripe.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stripe" "DisplayVersion" "0.3.8"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stripe" "Publisher" "Jensen-Yao"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stripe" "UninstallString" '"$INSTDIR\卸载.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stripe" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stripe" "NoRepair" 1
  CreateDirectory "$SMPROGRAMS\卫星条带规划工具"
  CreateShortcut "$SMPROGRAMS\卫星条带规划工具\卫星条带规划工具.lnk" "$INSTDIR\Stripe.exe"
  CreateShortcut "$SMPROGRAMS\卫星条带规划工具\卸载.lnk" "$INSTDIR\卸载.exe"
  CreateShortcut "$DESKTOP\卫星条带规划工具.lnk" "$INSTDIR\Stripe.exe"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\卫星条带规划工具.lnk"
  RMDir /r "$SMPROGRAMS\卫星条带规划工具"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stripe"
  DeleteRegKey HKCU "Software\Stripe"
  RMDir /r "$INSTDIR"
SectionEnd
