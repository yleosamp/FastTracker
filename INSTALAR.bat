@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo Falha na instalacao. Confira a mensagem acima.
  pause
  exit /b 1
)
pause
