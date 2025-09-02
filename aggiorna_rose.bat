@echo off
cd /d "C:\Users\Aldo\Desktop\svincoli"

:: 1) Scarica dal bottone FANTA-ASTA (usa la sessione salvata)
set MANUAL_LOGIN=
node ".\scripts\download_leghe_rosters.mjs" || goto :end

:: 2) Sposta/rinomina in radice
if not exist ".\cache\rose_leghe.xlsx" (
  echo ERRORE: export non trovato in .\cache
  goto :end
)
del /f /q "negher rosters.xlsx" 2>nul
move /y ".\cache\rose_leghe.xlsx" "negher rosters.xlsx"

echo.
echo ✅ Fatto: negher rosters.xlsx aggiornato!
:end
pause
