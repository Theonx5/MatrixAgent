!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing PaperMatrix if it is running..."
  nsExec::Exec 'taskkill /F /IM PaperMatrix.exe /T'
  Pop $0
  ; Previous Matrix Agent builds used pideck.exe only inside this install dir.
  IfFileExists "$INSTDIR\pideck.exe" 0 skip_old_binary_close
    nsExec::Exec 'taskkill /F /IM pideck.exe /T'
    Pop $0
  skip_old_binary_close:
  Sleep 800

  IfFileExists "$INSTDIR\*.*" 0 skip_clear_readonly
    DetailPrint "Clearing read-only attributes in $INSTDIR"
    nsExec::Exec 'attrib -R "$INSTDIR\*.*" /S /D'
    Pop $0
  skip_clear_readonly:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\pideck.exe" 0 skip_old_binary_delete
    Delete "$INSTDIR\pideck.exe"
  skip_old_binary_delete:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM PaperMatrix.exe /T'
  Pop $0
  Sleep 500
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Never delete Pi CLI data or other products' AppData. Tauri only removes
  ; this app's bundle id (online.papermatrix.matrix-agent). Matrix Agent user
  ; files live in %USERPROFILE%\.MatrixAgent.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    IfFileExists "$PROFILE\.MatrixAgent" 0 skip_matrix_agent_data
      RMDir /r "$PROFILE\.MatrixAgent"
    skip_matrix_agent_data:
  ${EndIf}
!macroend
