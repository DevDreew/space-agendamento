@echo off
title Robo de WhatsApp - DreewSolution
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Instale o Node.js LTS em https://nodejs.org e abra este arquivo de novo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Instalando o robo pela primeira vez, aguarde...
  call npm install --omit=dev
)
if not exist config.json (
  copy config.exemplo.json config.json >nul
  echo.
  echo Abra o arquivo config.json, cole a chave do robo que aparece no painel do dono e salve.
  notepad config.json
)
node robo.mjs
pause
