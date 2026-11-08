; GESTAT - réglages de l'installateur (NSIS)
; Les données sont dans %APPDATA%\GESTAT\donnees : elles ne sont jamais effacées,
; ni par une réinstallation par-dessus, ni par la désinstallation.

!macro customHeader
  ShowInstDetails show
!macroend

!macro customInstall
  DetailPrint "Vos données GESTAT restent dans $APPDATA\GESTAT\donnees"
  ; Raccourcis avec l'icône GESTAT (l'exe lui-même garde l'icône par défaut, comme GESTIME)
  CreateShortCut "$DESKTOP\GESTAT.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\resources\gestat-icone.ico" 0
  CreateDirectory "$SMPROGRAMS"
  CreateShortCut "$SMPROGRAMS\GESTAT.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\resources\gestat-icone.ico" 0
!macroend

!macro customUnInstall
  DetailPrint "Les données de $APPDATA\GESTAT\donnees sont conservées."
!macroend
