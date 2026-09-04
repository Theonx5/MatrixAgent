!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing PaperMatrix if it is running..."
  nsExec::Exec 'taskkill /F /IM PaperMatrix.exe /T'
  Pop $0
  ; Previous Matrix Agent builds (<=0.2.3) ran as pideck.exe. Kill by image
  ; name unconditionally: the file may already be deleted from $INSTDIR
  ; while a zombie process from the deleted image is still running, so
  ; guarding the kill on IfFileExists would leave those processes alive.
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
  ; Runtime cache is reconstructed from node_modules.tar.gz; always remove it.
  ; Never delete Pi CLI data. User files in %USERPROFILE%\.MatrixAgent stay
  ; unless the user checks Delete application data.
  ${If} $UpdateMode <> 1
    SetShellVarContext current
    IfFileExists "$LOCALAPPDATA\online.papermatrix.matrix-agent\host" 0 skip_host_cache
      RMDir /r "$LOCALAPPDATA\online.papermatrix.matrix-agent\host"
    skip_host_cache:
    IfFileExists "$LOCALAPPDATA\com.skitre.pideck\host" 0 skip_legacy_host_cache
      RMDir /r "$LOCALAPPDATA\com.skitre.pideck\host"
    skip_legacy_host_cache:
    ${If} $DeleteAppDataCheckboxState = 1
      ; Agent data now lives next to the installed binary; wipe it too when
      ; the user opts into full data removal. The legacy home-directory layout
      ; is cleaned as well for pre-0.2.6 installs.
      IfFileExists "$INSTDIR\agent" 0 skip_instdir_agent_data
        RMDir /r "$INSTDIR\agent"
      skip_instdir_agent_data:
      IfFileExists "$PROFILE\.MatrixAgent" 0 skip_matrix_agent_data
        RMDir /r "$PROFILE\.MatrixAgent"
      skip_matrix_agent_data:
    ${EndIf}
  ${EndIf}
!macroend
