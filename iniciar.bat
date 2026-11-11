@echo off
title Reparto de camara
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias...
  call npm install --omit=dev
)
rem Abre el panel en Edge: en esta PC, Chrome tiene una politica que bloquea WebRTC.
start "" /b cmd /c "ping -n 4 127.0.0.1 >nul & start "" msedge http://127.0.0.1:8080"
node src\servidor.js
pause
