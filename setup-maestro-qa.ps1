$ErrorActionPreference = "Stop"

$WorksideQA = "C:\Users\sjroy\Source\WorksideQA"
$MerxusWeb = "C:\Users\sjroy\Source\Merxus\web"
$MerxusBackend = "C:\Users\sjroy\Source\Merxus\merxus-ai-backend"
$MerxusMobile = "C:\Users\sjroy\Source\Merxus\mobile"
$LocalConfig = Join-Path $WorksideQA ".maestro.local.ps1"
$CanonicalFirebaseProject = "merxus-maestro-local"
$CanonicalAndroidAppId = "com.merxus.mobile.qa"
$CanonicalAuthEmulator = "127.0.0.1:9099"
$CanonicalFirestoreEmulator = "127.0.0.1:8080"
$CanonicalStorageEmulator = "127.0.0.1:9199"
$CanonicalBackendUrl = "http://127.0.0.1:8787"

function Add-MaestroToCurrentPath {
    $maestroBin = Join-Path $env:USERPROFILE ".maestro\bin"
    if (Test-Path $maestroBin) {
        if (($env:Path -split ';') -notcontains $maestroBin) {
            $env:Path = "$env:Path;$maestroBin"
        }
    }
}

function Import-MerxusMaestroLocalConfig {
    if (-not (Test-Path $LocalConfig)) {
        throw "Missing local config: $LocalConfig`nCopy .maestro.local.ps1.example to .maestro.local.ps1 and fill in the credentials."
    }
    . $LocalConfig
    if ($env:MERXUS_MAESTRO_FIREBASE_PROJECT_ID -and $env:MERXUS_MAESTRO_FIREBASE_PROJECT_ID -ne $CanonicalFirebaseProject) {
      throw "MERXUS_MAESTRO_FIREBASE_PROJECT_ID must equal $CanonicalFirebaseProject."
    }
    if ($env:MERXUS_MAESTRO_ANDROID_APP_ID -and $env:MERXUS_MAESTRO_ANDROID_APP_ID -ne $CanonicalAndroidAppId) {
      throw "MERXUS_MAESTRO_ANDROID_APP_ID must equal $CanonicalAndroidAppId."
    }
    $env:MERXUS_QA_ENVIRONMENT = "maestro"
    $env:GCLOUD_PROJECT = $CanonicalFirebaseProject
    $env:FIREBASE_PROJECT_ID = $CanonicalFirebaseProject
    $env:MERXUS_MAESTRO_FIREBASE_PROJECT_ID = $CanonicalFirebaseProject
    $env:FIREBASE_AUTH_EMULATOR_HOST = $CanonicalAuthEmulator
    $env:FIRESTORE_EMULATOR_HOST = $CanonicalFirestoreEmulator
    $env:FIREBASE_STORAGE_EMULATOR_HOST = $CanonicalStorageEmulator
    $env:MERXUS_QA_BACKEND_URL = $CanonicalBackendUrl
    $env:MERXUS_ALLOW_EXTERNAL_PROVIDERS = "false"
}

function Invoke-MerxusMaestroAuthVerify {
    Push-Location $MerxusBackend
    try {
      $output = & node scripts/qa-maestro-auth-verify.js 2>&1
      $exitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    $output | ForEach-Object { Write-Host $_ }
    if ($exitCode -ne 0) { throw "Auth emulator verification failed. The fixture users and tenant/role documents must be reset before Maestro can run." }
    return $true
}

function Import-MerxusMaestroMobileEnvironment {
    $runtimeTool = Join-Path $WorksideQA 'packages\qa-mobile\src\merxus-mobile-runtime.js'
    $json = & node $runtimeTool --mobile-root $MerxusMobile --print-env
    if ($LASTEXITCODE -ne 0) { throw 'Could not load the canonical Mobile Maestro build profile.' }
    $mobileEnvironment = $json | ConvertFrom-Json
    foreach ($entry in $mobileEnvironment.PSObject.Properties) {
      [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, 'Process')
    }
    $env:MERXUS_MOBILE_REPO = $MerxusMobile
}

function Test-MerxusMaestroMobileRuntime {
    param([switch]$ConfigOnly)
    $runtimeTool = Join-Path $WorksideQA 'packages\qa-mobile\src\merxus-mobile-runtime.js'
    $runtimeArgs = @($runtimeTool, '--mobile-root', $MerxusMobile)
    if ($ConfigOnly) { $runtimeArgs += '--config-only' }
    & node @runtimeArgs
    if ($LASTEXITCODE -ne 0) { throw 'T3 must serve the Merxus Maestro runtime. Stop the incorrect Metro instance and run Start-MerxusMaestroMetro.' }
}

function Assert-MerxusMetroPortAvailable {
    try {
      $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq 8081)
    } catch {
      throw 'Cannot inspect port 8081. Metro was not started; check Windows networking permissions and retry.'
    }
    if ($listeners.Count -eq 0) { return }

    $owners = foreach ($listenerPid in ($listeners.OwningProcess | Sort-Object -Unique)) {
      $processName = '(unavailable: process exited or access denied)'
      $started = 'unknown'
      try {
        $ownerProcess = Get-Process -Id $listenerPid -ErrorAction Stop
        $processName = $ownerProcess.ProcessName
        try { $started = $ownerProcess.StartTime.ToString('yyyy-MM-dd HH:mm:ss') } catch { }
      } catch { }
      "PID=$listenerPid process=$processName started=$started"
    }
    $details = $owners -join [Environment]::NewLine
    throw @"
T3 START BLOCKED: port 8081 is already occupied.
$details
An existing Metro may be stale or serving another runtime. No new Metro was started.
Inspect the running server with: npm run qa:merxus:maestro:mobile:verify -- --served-only
To replace it, press Ctrl+C in its owning T3 terminal, then run Start-MerxusMaestroMetro again.
If that process is elevated, stop it from its elevated terminal. This helper does not kill processes or switch ports.
"@
}

function Start-MerxusMaestroMetro {
    Assert-MerxusMetroPortAvailable
    Import-MerxusMaestroMobileEnvironment
    Test-MerxusMaestroMobileRuntime -ConfigOnly
    Push-Location $MerxusMobile
    try {
      Write-Host 'Maestro config verified. T5 must verify the served Android manifest before UI certification.'
      & npx expo start --dev-client --host lan --port 8081 --clear
      if ($LASTEXITCODE -ne 0) { throw 'Maestro Metro exited unsuccessfully.' }
    } finally { Pop-Location }
}

function Invoke-MerxusMaestroBackendIdentityVerify {
    $endpoint = "$CanonicalBackendUrl/api/auth/check-email"
    $backendPid = $null
    try {
      $connection = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($connection) { $backendPid = $connection.OwningProcess }
    } catch { }

    $identities = @(
      @{ Name = "Owner A"; Email = $env:MERXUS_MAESTRO_OWNER_A_EMAIL },
      @{ Name = "Owner B"; Email = $env:MERXUS_MAESTRO_OWNER_B_EMAIL }
    )
    foreach ($identity in $identities) {
      $safe = $null
      try {
        $payload = @{ email = $identity.Email } | ConvertTo-Json -Compress
        $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $endpoint -ContentType "application/json" -Body $payload -TimeoutSec 5
        $body = $response.Content | ConvertFrom-Json
        $safe = "status=$($response.StatusCode) exists=$($body.exists) provider=$($body.provider) hasWorkspace=$($body.hasWorkspace)"
        if ($response.StatusCode -ne 200 -or $body.exists -ne $true -or $body.provider -ne "email" -or $body.hasWorkspace -ne $true) {
          throw "unexpected check-email result ($safe)"
        }
        Write-Host "Backend identity: $($identity.Name) passed ($safe)" -ForegroundColor Green
      } catch {
        $pidText = if ($backendPid) { $backendPid } else { "unknown" }
        $status = $null
        try { $status = $_.Exception.Response.StatusCode.value__ } catch { }
        $safeError = if ($safe) { $safe } elseif ($status) { "status=$status" } else { "requestError=$($_.Exception.GetType().Name)" }
        throw "Backend identity preflight failed for $($identity.Name): $safeError. endpoint=$endpoint project=$CanonicalFirebaseProject auth=$CanonicalAuthEmulator firestore=$CanonicalFirestoreEmulator backendPid=$pidText"
      }
    }
    return $true
}

function Test-MerxusMaestroQa {
    Add-MaestroToCurrentPath
    Import-MerxusMaestroLocalConfig
    Test-MerxusMaestroMobileRuntime
    $required = @(
      "MERXUS_MAESTRO_OWNER_A_EMAIL",
      "MERXUS_MAESTRO_OWNER_A_PASSWORD",
      "MERXUS_MAESTRO_OWNER_B_EMAIL",
      "MERXUS_MAESTRO_OWNER_B_PASSWORD",
      "MERXUS_ANDROID_EMULATOR_ID",
      "MERXUS_MAESTRO_FIREBASE_PROJECT_ID",
      "MERXUS_MAESTRO_ANDROID_APP_ID"
    )

    $rows = @()
    $rows += [pscustomobject]@{Check="maestro"; OK=($null -ne (Get-Command maestro -ErrorAction SilentlyContinue)); Detail=if (Get-Command maestro -ErrorAction SilentlyContinue) { maestro --version } else { "not found" }}
    $rows += [pscustomobject]@{Check="adb"; OK=($null -ne (Get-Command adb -ErrorAction SilentlyContinue)); Detail=if (Get-Command adb -ErrorAction SilentlyContinue) { "available" } else { "not found" }}
    $rows += [pscustomobject]@{Check="WorksideQA"; OK=(Test-Path $WorksideQA); Detail=$WorksideQA}
    $rows += [pscustomobject]@{Check="Backend"; OK=(Test-Path $MerxusBackend); Detail=$MerxusBackend}
    $rows += [pscustomobject]@{Check="Mobile"; OK=(Test-Path $MerxusMobile); Detail=$MerxusMobile}
    $rows += [pscustomobject]@{Check="Firebase"; OK=(Test-Path $MerxusWeb); Detail=$MerxusWeb}

    $rows += [pscustomobject]@{Check="Firebase project"; OK=($env:MERXUS_MAESTRO_FIREBASE_PROJECT_ID -eq $CanonicalFirebaseProject); Detail=$env:MERXUS_MAESTRO_FIREBASE_PROJECT_ID}
    $rows += [pscustomobject]@{Check="Android app ID"; OK=($env:MERXUS_MAESTRO_ANDROID_APP_ID -eq $CanonicalAndroidAppId); Detail=$env:MERXUS_MAESTRO_ANDROID_APP_ID}

    foreach ($name in $required) {
      $value = [Environment]::GetEnvironmentVariable($name, "Process")
      $detail = if ([string]::IsNullOrWhiteSpace($value)) { "missing" } elseif ($name -like "*PASSWORD*") { "set" } else { $value }
      $rows += [pscustomobject]@{Check=$name; OK=(-not [string]::IsNullOrWhiteSpace($value)); Detail=$detail}
    }

    $emailA = [Environment]::GetEnvironmentVariable("MERXUS_MAESTRO_OWNER_A_EMAIL", "Process")
    $emailB = [Environment]::GetEnvironmentVariable("MERXUS_MAESTRO_OWNER_B_EMAIL", "Process")
    $rows += [pscustomobject]@{Check="Distinct fixture emails"; OK=((-not [string]::IsNullOrWhiteSpace($emailA)) -and (-not [string]::IsNullOrWhiteSpace($emailB)) -and $emailA.Trim().ToLowerInvariant() -ne $emailB.Trim().ToLowerInvariant()); Detail="Owner A/B emails are distinct"}

    $adbReady = $false
    $device = [Environment]::GetEnvironmentVariable("MERXUS_ANDROID_EMULATOR_ID", "Process")
    if (-not [string]::IsNullOrWhiteSpace($device) -and $null -ne (Get-Command adb -ErrorAction SilentlyContinue)) {
      $state = (& adb -s $device get-state 2>$null)
      $adbReady = ($LASTEXITCODE -eq 0 -and $state.Trim() -eq "device")
    }
    $rows += [pscustomobject]@{Check="Android emulator online"; OK=$adbReady; Detail=if ($adbReady) { $device } else { "not online" }}

    $rows | Format-Table -AutoSize
    if (@($rows | Where-Object { -not $_.OK }).Count -gt 0) {
      Write-Host "`nMerxus Maestro QA validation FAILED." -ForegroundColor Red
      return $false
    }
    Invoke-MerxusMaestroAuthVerify | Out-Null
    Invoke-MerxusMaestroBackendIdentityVerify | Out-Null
    Write-Host "`nMerxus Maestro QA validation PASSED." -ForegroundColor Green
    return $true
}

function Initialize-MerxusAndroidQa {
    Add-MaestroToCurrentPath
    Import-MerxusMaestroLocalConfig
    $device = $env:MERXUS_ANDROID_EMULATOR_ID
    if ([string]::IsNullOrWhiteSpace($device)) { throw "MERXUS_ANDROID_EMULATOR_ID is not set." }
    $state = (& adb -s $device get-state 2>$null)
    if ($LASTEXITCODE -ne 0 -or $state -ne "device") {
      Write-Host "ADB device not ready. Restarting ADB..." -ForegroundColor Yellow
      adb kill-server | Out-Null
      adb start-server | Out-Null
      Start-Sleep -Seconds 2
      $state = (& adb -s $device get-state 2>$null)
    }
    if ($state -ne "device") { throw "Android device $device is not online. Start/restart the AVD and rerun Initialize-MerxusAndroidQa." }
    adb -s $device reverse tcp:8081 tcp:8081 | Out-Null
    Write-Host "Android QA device ready: $device" -ForegroundColor Green
    Write-Host "Metro reverse configured: tcp:8081 -> tcp:8081" -ForegroundColor Green
  }

Add-MaestroToCurrentPath
Import-MerxusMaestroLocalConfig
Import-MerxusMaestroMobileEnvironment
