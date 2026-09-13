@echo off
setlocal
set "WQA=C:\Users\sjroy\Source\WorksideQA"
set "WEB=C:\Users\sjroy\Source\Merxus\web"
set "BACKEND=C:\Users\sjroy\Source\Merxus\merxus-ai-backend"
set "MOBILE=C:\Users\sjroy\Source\Merxus\mobile"

start "T1 - Firebase" powershell.exe -NoExit -ExecutionPolicy Bypass -Command "[Console]::Title='T1 - Firebase'; Set-Location '%WEB%'; $env:NO_UPDATE_NOTIFIER='1'; firebase emulators:start --project merxus-maestro-local --config firebase.json --only auth,firestore,storage"
timeout /t 2 /nobreak >nul
start "T2 - Backend" powershell.exe -NoExit -ExecutionPolicy Bypass -Command "[Console]::Title='T2 - Backend'; Set-Location '%BACKEND%'; npm run qa:maestro:serve"
timeout /t 2 /nobreak >nul
start "T3 - Metro" powershell.exe -NoExit -ExecutionPolicy Bypass -Command "[Console]::Title='T3 - Metro'; Set-Location '%MOBILE%'; npx expo start --dev-client --host lan --clear"
timeout /t 2 /nobreak >nul
start "T4 - Android ADB" powershell.exe -NoExit -ExecutionPolicy Bypass -Command "[Console]::Title='T4 - Android ADB'; Set-Location '%WQA%'; . '%WQA%\setup-maestro-qa.ps1'; Write-Host ''; Write-Host 'Start the AVD in Android Studio if needed, then run: Initialize-MerxusAndroidQa' -ForegroundColor Cyan"
timeout /t 2 /nobreak >nul
start "T5 - WorksideQA" powershell.exe -NoExit -ExecutionPolicy Bypass -Command "[Console]::Title='T5 - WorksideQA'; Set-Location '%WQA%'; . '%WQA%\setup-maestro-qa.ps1'; Test-MerxusMaestroQa"
endlocal
