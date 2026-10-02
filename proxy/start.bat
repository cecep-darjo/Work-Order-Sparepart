@echo off
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js belum terpasang. Unduh versi LTS dari https://nodejs.org lalu jalankan ulang.
  pause
  exit /b 1
)
if not exist dist-offline\index.html (
  echo Build offline belum ada, membuatnya dulu...
  node proxy\build-offline.mjs
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node proxy\server.mjs
pause
