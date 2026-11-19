@echo off
setlocal
cd /d "%~dp0"
node server.mjs --demo
if errorlevel 1 pause
