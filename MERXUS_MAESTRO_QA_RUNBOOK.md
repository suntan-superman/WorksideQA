# Merxus Maestro QA Runbook

## Purpose
Single source of truth for starting and validating the Merxus Maestro QA environment after a reboot.

The fixture/bootstrap contract is authoritative. Do not search historical reports for QA credentials.

## Terminal map
- T1 – Firebase emulators
- T2 – Maestro QA backend
- T3 – Mobile Maestro runtime served by Metro
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
2. Copy `maestro.local.ps1.example` to `.maestro.local.ps1`.
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

## T3 – Mobile Maestro runtime

T3 is not merely Metro. It must serve the Merxus Mobile Maestro runtime configuration.
The native package `com.merxus.mobile.qa` does not select the JavaScript runtime.
Plain `expo start` does not load an EAS build profile and defaults to production
when neither Mobile environment selector is set.

The canonical non-secret configuration is Mobile `eas.json`,
`build.maestro-simulator.env`. `setup-maestro-qa.ps1` imports it through
`merxus-mobile-runtime.js`; keep credentials/machine IDs in ignored
`.maestro.local.ps1`. Do not search historical terminals for these values again.

```powershell
[Console]::Title = "T3 - Maestro Metro"
Set-Location C:\Users\sjroy\Source\WorksideQA
. .\setup-maestro-qa.ps1
Start-MerxusMaestroMetro
```

`open-merxus-qa.bat` uses this same function automatically. The function imports
the profile before resolving Expo's public config, validates it through Mobile's
real runtime mapper/validator, then starts foreground Metro on port 8081 with a
cleared cache. It refuses an occupied port instead of switching ports or killing
another instance. A blocked start reports each listener's PID, process name and
start time when accessible, and includes the served-runtime verification command.
Stop old T3 with Ctrl+C in its owning terminal first (especially if the old
terminal is elevated). An occupied port may belong to a healthy Metro; inspect
the served configuration before deciding to replace it.

| Mobile input from the Maestro profile | Value before Metro starts |
| --- | --- |
| `MERXUS_MOBILE_ENVIRONMENT` | `maestro` (highest-precedence environment selector) |
| `EXPO_PUBLIC_ENVIRONMENT` | `maestro` (fallback environment selector) |
| `EXPO_PUBLIC_API_BASE_URL` | `http://127.0.0.1:8787` |
| `EXPO_PUBLIC_FIREBASE_PROJECT_ID` | `merxus-maestro-local` |
| `EXPO_PUBLIC_AUTH_EMULATOR_HOST` | `127.0.0.1:9099` |
| `EXPO_PUBLIC_FIRESTORE_EMULATOR_HOST` | `127.0.0.1:8080` |
| `EXPO_PUBLIC_STORAGE_EMULATOR_HOST` | `127.0.0.1:9199` |
| `EXPO_PUBLIC_ALLOW_EXTERNAL_PROVIDERS` | `false` |

The importer also sets `EXPO_NO_DOTENV=1` only in this QA shell and clears inherited
`EXPO_PUBLIC_FIREBASE_API_KEY`, `EXPO_PUBLIC_FIREBASE_APP_ID`, and
`EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET`, allowing `app.config.js`'s existing Maestro
defaults (`maestro-local-not-a-secret`, `1:000000000000:web:maestrolocal`, and
`merxus-maestro-local.appspot.com`). It clears `EXPO_PUBLIC_FIXTURE_GENERATION`;
that optional display value must not inherit a previous certification's generation.
No production `.env`, endpoints, native identity, or profile is edited.

`app.config.js` derives both native app IDs and `extra.APP_ID` from Maestro mode;
there is no separate app-ID environment input to set. `extra.ENVIRONMENT` feeds
`RUNTIME_CONFIG.isMaestro`; Mobile maps loopback addresses to `10.0.2.2` on Android.
`firebase.js` connects all three emulators only for valid Maestro runtime config.

| Android runtime target | Expected value |
| --- | --- |
| Environment / isMaestro | `maestro` / `true` |
| App ID | `com.merxus.mobile.qa` |
| Backend | `http://10.0.2.2:8787` |
| Firebase project | `merxus-maestro-local` |
| Auth | `10.0.2.2:9099` |
| Firestore | `10.0.2.2:8080` |
| Storage | `10.0.2.2:9199` |

T3's config check proves what the new process will serve; readiness requires the
actual served manifest check from T5. This checks an Android Expo manifest from
`http://127.0.0.1:8081/`, not merely T5 variables or `/status`:

```powershell
Set-Location C:\Users\sjroy\Source\WorksideQA
. .\setup-maestro-qa.ps1
npm run qa:merxus:maestro:mobile:verify
```

The command prints only safe runtime fields, performs no login/reset, and returns
nonzero for production config, missing/wrong emulator endpoints, wrong app/project,
enabled providers, unavailable Metro, or a malformed manifest. `-- --config-only`
checks the current shell without contacting Metro; `-- --served-only` checks the
running server independently of the current shell. It never retries or repairs T3.

### Why the September 13 startup failed

The previous automated T3 launched plain Expo without importing the Mobile build
profile. Backend setup variables such as `MERXUS_QA_ENVIRONMENT` and
`MERXUS_MAESTRO_FIREBASE_PROJECT_ID` are not the environment inputs consumed by
Mobile `app.config.js`. That file fell back to production. Reading the running
Android Expo manifest confirmed production environment, production project and
`https://api.merxus.ai`, even though the installed native package was QA.

Older instructions explicitly depended on restarting in an already
Maestro-configured shell and preserving that shell's variables. The exact old
process environment was not retained; the checked-in EAS profile and Mobile
runtime code define the reproducible contract, not historical terminal state.

Clean-shell tests now prove the original plain-Expo failure, canonical-profile
success, inherited production override protection, and rejection of a production
served manifest even when the T5 shell is correct. Live Windows PowerShell 5.1
verification also required `Invoke-WebRequest -UseBasicParsing` for the backend
identity check; this avoids dependence on legacy browser initialization.

## T4 – Android / ADB
Start the emulator from Android Studio, then run:
```powershell
Set-Location C:\Users\sjroy\Source\WorksideQA
. .\setup-maestro-qa.ps1
Initialize-MerxusAndroidQa
```

## T5 – WorksideQA
The startup script loads `.maestro.local.ps1`, validates the tools, checks the
selected emulator, and verifies both Auth users plus tenant/role mappings. It
first validates Mobile's resolved config AND the actual T3 Android manifest;
production runtime fails even when local backend identities are valid. It
also POSTs both canonical emails to the exact backend endpoint used by Mobile
(`/api/auth/check-email`) and requires `exists=true`, `provider=email`, and
`hasWorkspace=true`. Run:
```powershell
Set-Location C:\Users\sjroy\Source\WorksideQA
. .\setup-maestro-qa.ps1
Test-MerxusMaestroQa
```
`Test-MerxusMaestroQa` must pass before any Maestro flow is launched. The
same backend identity gate is repeated by the WorksideQA runner after each
scenario fixture reset, immediately before the UI process starts. This keeps
the preflight authoritative even when a long-lived backend or emulator was
restarted between T5 and a flow. A failed gate aborts before UI launch and
reports only safe status/identity/configuration diagnostics; it does not retry
or reset fixtures silently. The standalone Auth check remains available after
T1/T2 are ready:
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
3. T3: dot-source setup and run `Start-MerxusMaestroMetro`; wait for Metro to listen on 8081.
4. T4: boot the explicitly configured emulator and run `Initialize-MerxusAndroidQa`.
5. T5: dot-source `setup-maestro-qa.ps1` and run `Test-MerxusMaestroQa`.
6. If auth verification reports missing users/documents, run the fixture reset for the intended scenario, then rerun `npm run qa:maestro:auth:verify`.
7. Rerun `Test-MerxusMaestroQa` after creating missing fixtures. It must pass the served Mobile config and backend identity checks before manual login or Maestro.
8. For the configuration-fix proof, reopen the QA development app against the restarted Metro. Confirm manual Owner A precheck uses `http://10.0.2.2:8787/api/auth/check-email`, returns `exists=true`, `provider=email`, `hasWorkspace=true`, and reaches Dashboard. Do not count a backend REST login as this UI proof.
9. Only after manual login passes, run `npm run qa:merxus:maestro:phase2:unsaved-reload:android`. Its WorksideQA preflight performs the fixture reset (when configured), Auth verification, and both backend `check-email` identity checks before starting Maestro UI.

## Troubleshooting

| Symptom | Check / correction |
| --- | --- |
| `Account not found` | Run `npm run qa:maestro:auth:verify`; if either user is absent, run the scenario reset. Do not recover credentials from old reports. |
| QA package but production runtime | Run `npm run qa:merxus:maestro:mobile:verify -- --served-only`. Stop the old T3 and restart with `Start-MerxusMaestroMetro`. A QA native package alone does not select Maestro JavaScript config. |
| Config-only passes but served check fails | T5 has correct inputs but T3 is stale, launched without setup, or serves another project. Stop T3 and use the canonical function; do not fix login or change fixture identities. |
| Automated T5 starts before Metro is ready | Let T3 finish starting, then run `Test-MerxusMaestroQa` again. Launcher spacing is not a readiness guarantee. |
| Backend identity preflight failed | Inspect the safe `check-email` status/result and project/emulator/backend diagnostics printed by T5 or `result.json`. Fix T1/T2/configuration or run the intended fixture reset, then start the flow again; there are no silent retries. |
| Email/password contract rejected | Compare the local env keys with `maestroFixtureConfig.js`; passwords are fixed QA-only values and must not be replaced with production credentials. |
| Auth/Firestore emulator unreachable | Confirm T1 is running with `--project merxus-maestro-local` and hosts `127.0.0.1:9099` / `127.0.0.1:8080`. |
| Tenant/role mapping failure | Run the fixture reset, then rerun auth verification; it checks Auth claims and `users`, `tenants`, `offices`, and settings documents. |
| Android emulator offline | Start the configured AVD, confirm `adb -s $env:MERXUS_ANDROID_EMULATOR_ID get-state` returns `device`, then run `Initialize-MerxusAndroidQa`. |
| Maestro not found | Add `C:\Users\sjroy\.maestro\bin` to PATH, open a new PowerShell, and run `maestro --version`. |

## Security
Do not commit `.maestro.local.ps1`; do not put passwords in this runbook; do not bypass secret scanning.
