@echo off
setlocal
set "WORKSIDEQA=%~dp0"
cd /d "%WORKSIDEQA%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%WORKSIDEQA%start-mobile-qa.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo WorksideQA mobile environment is NOT READY. Exit code %EXITCODE%.
  pause
)
exit /b %EXITCODE%
