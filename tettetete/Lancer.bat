@echo off
title Swipe vers PC
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js est introuvable. Installe-le depuis https://nodejs.org puis relance.
  pause
  exit /b 1
)
node server.js
pause
