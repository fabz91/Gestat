@echo off
chcp 65001 >nul
title GESTAT - fabrication de linstallateur
cd /d "%~dp0"
echo.
echo  ==========================================
echo    GESTAT - fabrication de linstallateur
echo  ==========================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js nest pas installe.
  echo  Installez la version LTS depuis https://nodejs.org puis relancez ce fichier.
  echo.
  pause
  exit /b 1
)
echo  Node.js trouve :
node -v
echo.
echo  1/2  Telechargement des outils (npm install)... quelques minutes
call npm install --no-audit --no-fund
if errorlevel 1 goto erreur
echo.
echo  2/2  Fabrication de linstallateur (npm run build)...
call npm run build
if errorlevel 1 goto erreur
echo.
echo  ==========================================
echo    Termine ! Linstallateur est dans le dossier dist
echo  ==========================================
start "" "%~dp0dist"
echo.
pause
exit /b 0
:erreur
echo.
echo  *** Une erreur sest produite. Verifiez la connexion internet puis relancez. ***
echo  (Faites une photo de cette fenetre si le probleme continue.)
echo.
pause
exit /b 1
