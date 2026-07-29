; AbapBuddy — NSIS 安装脚本自定义
; customInit 在文件解压前执行，customInstall 在解压后执行
; 配合使用实现升级安装保留用户配置、会话、产物

!macro customInit
  ; ===== 清理 Windows 保留设备名文件 =====
  ; 运行时可能产生 nul 等保留设备名文件，普通文件 API 删不掉，
  ; 会卡住旧版卸载。用 \\?\ 前缀绕过 Win32 设备名检查清掉。
  nsExec::ExecToLog 'cmd.exe /c del /f /q "\\?\$INSTDIR\resources\nul" 2>nul'
  Pop $R9
  nsExec::ExecToLog 'cmd.exe /c del /f /q "\\?\$INSTDIR\resources\con" 2>nul'
  Pop $R9

  ; 安装开始前备份用户数据。
  ; $INSTDIR 通常已被 electron-builder 设为旧安装路径，但 per-user → perMachine
  ; 迁移场景可能指向新路径。此时追加检查 %LOCALAPPDATA% 下的常见旧安装位置。
  StrCpy $R7 "$INSTDIR"
  ${IfNot} ${FileExists} "$R7\resources\.pi\auth.json"
    ReadEnvStr $R8 LOCALAPPDATA
    ${If} $R8 != ""
      StrCpy $R7 "$R8\Programs\AbapBuddy"
      ${IfNot} ${FileExists} "$R7\resources\.pi\auth.json"
        StrCpy $R7 "$INSTDIR"   ; 都没找到，回退
      ${EndIf}
    ${EndIf}
  ${EndIf}

  CreateDirectory "$TEMP\abapbuddy-backup\.pi"
  IfFileExists "$R7\resources\.pi\auth.json" 0 +2
    CopyFiles /SILENT "$R7\resources\.pi\auth.json" "$TEMP\abapbuddy-backup\.pi\"
  IfFileExists "$R7\resources\.pi\sessions\*.*" 0 +3
    CreateDirectory "$TEMP\abapbuddy-backup\.pi\sessions"
    CopyFiles /SILENT "$R7\resources\.pi\sessions\*.*" "$TEMP\abapbuddy-backup\.pi\sessions\"
  IfFileExists "$R7\resources\.gxx-abap\*.*" 0 +3
    CreateDirectory "$TEMP\abapbuddy-backup\.gxx-abap"
    CopyFiles /SILENT "$R7\resources\.gxx-abap\*.*" "$TEMP\abapbuddy-backup\.gxx-abap\"
  IfFileExists "$R7\resources\output\*.*" 0 +3
    CreateDirectory "$TEMP\abapbuddy-backup\output"
    CopyFiles /SILENT "$R7\resources\output\*.*" "$TEMP\abapbuddy-backup\output\"
  CreateDirectory "$TEMP\abapbuddy-backup"
  IfFileExists "$R7\resources\Memory.md" 0 +2
    CopyFiles /SILENT "$R7\resources\Memory.md" "$TEMP\abapbuddy-backup\"
!macroend

!macro customInstall
  ; 安装完成后恢复用户数据
  IfFileExists "$TEMP\abapbuddy-backup\.pi\auth.json" 0 +3
    CreateDirectory "$INSTDIR\resources\.pi"
    Delete "$INSTDIR\resources\.pi\auth.json"
    CopyFiles /SILENT "$TEMP\abapbuddy-backup\.pi\auth.json" "$INSTDIR\resources\.pi\auth.json"
  IfFileExists "$TEMP\abapbuddy-backup\.pi\sessions\*.*" 0 +4
    CreateDirectory "$INSTDIR\resources\.pi\sessions"
    CopyFiles /SILENT "$TEMP\abapbuddy-backup\.pi\sessions\*.*" "$INSTDIR\resources\.pi\sessions\"
  IfFileExists "$TEMP\abapbuddy-backup\.gxx-abap\*.*" 0 +4
    RMDir /r "$INSTDIR\resources\.gxx-abap"
    CreateDirectory "$INSTDIR\resources\.gxx-abap"
    CopyFiles /SILENT "$TEMP\abapbuddy-backup\.gxx-abap\*.*" "$INSTDIR\resources\.gxx-abap\"
  IfFileExists "$TEMP\abapbuddy-backup\output\*.*" 0 +4
    RMDir /r "$INSTDIR\resources\output"
    CreateDirectory "$INSTDIR\resources\output"
    CopyFiles /SILENT "$TEMP\abapbuddy-backup\output\*.*" "$INSTDIR\resources\output\"
  IfFileExists "$TEMP\abapbuddy-backup\Memory.md" 0 +2
    CopyFiles /SILENT "$TEMP\abapbuddy-backup\Memory.md" "$INSTDIR\resources\"
  RMDir /r "$TEMP\abapbuddy-backup"

  ; 静默安装（升级）完成后自动启动
  IfSilent 0 +2
    Exec "$INSTDIR\AbapBuddy.exe"

  ; 开始菜单
  CreateDirectory "$SMPROGRAMS\AbapBuddy"
  CreateShortCut "$SMPROGRAMS\AbapBuddy\AbapBuddy.lnk" "$INSTDIR\AbapBuddy.exe"
  CreateShortCut "$SMPROGRAMS\AbapBuddy\项目文件夹.lnk" "$INSTDIR\resources"
  CreateShortCut "$SMPROGRAMS\AbapBuddy\卸载 AbapBuddy.lnk" "$INSTDIR\Uninstall AbapBuddy.exe"
!macroend

!macro customUnInstall
  RMDir /r "$SMPROGRAMS\AbapBuddy"
!macroend
