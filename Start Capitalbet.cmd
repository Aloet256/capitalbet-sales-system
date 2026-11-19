@echo off
setlocal
cd /d "%~dp0"
node server.mjs --local
if errorlevel 1 pause
