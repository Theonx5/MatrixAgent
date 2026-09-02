!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing PaperMatrix if it is running..."
  nsExec::Exec 'taskkill /F /IM pideck.exe /T'
  Pop $0
  Sleep 800

  IfFileExists "$INSTDIR\*.*" 0 skip_clear_readonly
    DetailPrint "Clearing read-only attributes in $INSTDIR"
    nsExec::Exec 'attrib -R "$INSTDIR\*.*" /S /D'
    Pop $0
  skip_clear_readonly:
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM pideck.exe /T'
  Pop $0
  Sleep 500
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Never delete Pi CLI data (%USERPROFILE%\.pi). Tauri already removes
  ; %APPDATA%\com.skitre.pideck when the user checks Delete application data.
  ; Matrix Agent user files live in %USERPROFILE%\.MatrixAgent.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    IfFileExists "$PROFILE\.MatrixAgent" 0 skip_matrix_agent_data
      RMDir /r "$PROFILE\.MatrixAgent"
    skip_matrix_agent_data:
  ${EndIf}
!macroend
