# Merxus Maestro QA Runbook

## Purpose
Single source of truth for starting and validating the Merxus Maestro QA environment after a reboot.

The fixture/bootstrap contract is authoritative. Do not search historical reports for QA credentials.

## Terminal map
- T1 – Firebase emulators
- T2 – Maestro QA backend
- T3 – Metro
- T4 – Android / ADB
- T5 – WorksideQA

## Canonical paths
- WorksideQA: `C:\Users\sjroy\Source\WorksideQA`
- Firebase/Web: `C:\Users\sjroy\Source\Merxus\web`
- Backend: `C:\Users\sjroy\Source\Merxus\merxus-ai-backend`
- Mobile: `C:\Users\sjroy\Source\Merxus\mobile`

## Canonical IDs
- Firebase project: `merxus-maestro-local`
- Android emulator: `emulator-5554`
- Android QA app: `com.merxus.mobile.qa`
- Metro port: `8081`
- iOS simulator: `3C029085-0B3D-49B6-AB7D-2943DA45F695`

## Canonical fixture identities

The backend contract lives in `merxus-ai-backend/src/services/qa/maestroFixtureConfig.js`.
The reset script reads the email/password environment keys from that contract,
then creates or updates both Auth-emulator users and their tenant/role documents.

| Fixture | UID | Email | Role / tenant |
| --- | --- | --- | --- |
| Owner A | `merxus-maestro-owner-a` | `owner-a@merxus-maestro.test` | owner / `merxus-maestro-tenant-a` |
| Owner B | `merxus-maestro-owner-b` | `owner-b@merxus-maestro.test` | owner / `merxus-maestro-tenant-b` |

Canonical local keys (values are never printed by tooling):

- `MERXUS_MAESTRO_OWNER_A_EMAIL`
- `MERXUS_MAESTRO_OWNER_A_PASSWORD`
- `MERXUS_MAESTRO_OWNER_B_EMAIL`
- `MERXUS_MAESTRO_OWNER_B_PASSWORD`
- `MERXUS_MAESTRO_FIREBASE_PROJECT_ID`
- `MERXUS_MAESTRO_ANDROID_APP_ID`
- `MERXUS_ANDROID_EMULATOR_ID`
- `MERXUS_IOS_SIMULATOR_ID` (Mac only)

## One-time setup
1. Ensure `C:\Users\sjroy\.maestro\bin` is in the persistent user PATH.
2. Copy `.maestro.local.ps1.example` to `.maestro.local.ps1`.
3. Set the canonical Owner A/B passwords locally in `.maestro.local.ps1`.
   The committed example intentionally contains placeholders; the real file is ignored.
4. Add `.maestro.local.ps1` to WorksideQA `.gitignore` and verify with `git check-ignore .maestro.local.ps1`.
5. Copy `setup-maestro-qa.ps1` and `open-merxus-qa.bat` into the WorksideQA root.

## T1 – Firebase
```powershell
[Console]::Title = "T1 - Firebase"
Set-Location C:\Users\sjroy\Source\Merxus\web
$env:NO_UPDATE_NOTIFIER = "1"
firebase emulators:start `
  --project merxus-maestro-local `
  --config firebase.json `
  --only auth,firestore,storage
```

## T2 – Backend
```powershell
[Console]::Title = "T2 - Backend"
Set-Location C:\Users\sjroy\Source\Merxus\merxus-ai-backend
npm run qa:maestro:serve
```

## T3 – Metro
```powershell
[Console]::Title = "T3 - Metro"
Set-Location C:\Users\sjroy\Source\Merxus\mobile
npx expo start --dev-client --host lan --clear
```

## T4 – Android / ADB
Start the emulator from Android Studio, then run:
```powershell
Set-Location C:\Users\sjroy\Source\WorksideQA
. .\setup-maestro-qa.ps1
Initialize-MerxusAndroidQa
```

## T5 – WorksideQA
The startup script loads `.maestro.local.ps1`, validates the tools, checks the
selected emulator, and verifies both Auth users plus tenant/role mappings. Run:
```powershell
Set-Location C:\Users\sjroy\Source\WorksideQA
. .\setup-maestro-qa.ps1
Test-MerxusMaestroQa
```
`Test-MerxusMaestroQa` must pass before any Maestro flow is launched. The
standalone backend check is also available after T1/T2 are ready:
```powershell
Set-Location C:\Users\sjroy\Source\Merxus\merxus-ai-backend
npm run qa:maestro:auth:verify
```
If users are missing after a clean emulator or reboot, reset the selected
scenario before launching a flow (the reset creates/updates both users):
```powershell
Set-Location C:\Users\sjroy\Source\WorksideQA
. .\setup-maestro-qa.ps1
Set-Location $env:MERXUS_BACKEND_REPO
npm run qa:maestro:reset -- --apply --confirm-reset --scenario login-owner-a --generation merxus-maestro-local
```
Use the WorksideQA fixture command for normal scenario resets so its generated
state and verifier arguments remain aligned.
Example Slice 25 certification:
```powershell
npm run qa:merxus:maestro:phase2:unsaved-reload:android
```

## Post-reboot startup order

1. T1: start Auth/Firestore/Storage emulators with project `merxus-maestro-local`.
2. T2: start the local backend and wait for port 8787 health.
3. T3: start Metro for the QA app.
4. T4: boot the explicitly configured emulator and run `Initialize-MerxusAndroidQa`.
5. T5: dot-source `setup-maestro-qa.ps1` and run `Test-MerxusMaestroQa`.
6. If auth verification reports missing users/documents, run the fixture reset for the intended scenario, then rerun `npm run qa:maestro:auth:verify`.
7. Launch the requested Maestro flow only after startup validation passes.

## Troubleshooting

| Symptom | Check / correction |
| --- | --- |
| `Account not found` | Run `npm run qa:maestro:auth:verify`; if either user is absent, run the scenario reset. Do not recover credentials from old reports. |
| Email/password contract rejected | Compare the local env keys with `maestroFixtureConfig.js`; passwords are fixed QA-only values and must not be replaced with production credentials. |
| Auth/Firestore emulator unreachable | Confirm T1 is running with `--project merxus-maestro-local` and hosts `127.0.0.1:9099` / `127.0.0.1:8080`. |
| Tenant/role mapping failure | Run the fixture reset, then rerun auth verification; it checks Auth claims and `users`, `tenants`, `offices`, and settings documents. |
| Android emulator offline | Start the configured AVD, confirm `adb -s $env:MERXUS_ANDROID_EMULATOR_ID get-state` returns `device`, then run `Initialize-MerxusAndroidQa`. |
| Maestro not found | Add `C:\Users\sjroy\.maestro\bin` to PATH, open a new PowerShell, and run `maestro --version`. |

## Security
Do not commit `.maestro.local.ps1`; do not put passwords in this runbook; do not bypass secret scanning.
