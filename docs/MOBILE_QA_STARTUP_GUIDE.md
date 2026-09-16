# Mobile QA Startup Guide

This is the reboot-safe entry point for local Merxus and SageSet mobile QA. The launcher orchestrates existing WorksideQA service lifecycle; it does not replace product startup scripts or create a second service manager.

## Quick start — Windows

Double-click `Start-Mobile-QA.bat`, then choose:

`1. Merxus`
`2. SageSet`
`3. Both`
`4. Health Check Only`
`5. Exit`

For an explicit command, run `powershell -ExecutionPolicy Bypass -File .\start-mobile-qa.ps1 -Product merxus` from WorksideQA. The ignored `.maestro.local.ps1` is loaded by the canonical Node config loader; passwords are never printed.

## Windows toolchain prerequisites

WorksideQA resolves Firebase and Java centrally and requires an explicit local
Firebase pin so a reboot cannot switch between Yarn/NVM installations. Set
`WORKSIDEQA_FIREBASE_BIN` in the ignored `.maestro.local.ps1` (the example uses
`%NVM_SYMLINK%\firebase.cmd`) and set `WORKSIDEQA_JAVA_BIN`/`JAVA_HOME` to a
JDK 21 LTS installation. Doctor reports the resolved executable and version and
fails before startup when a Firebase CLI that requires Java 21 is paired with
Java 17 or older. Do not downgrade Firebase to work around an old JDK; install
JDK 21 and update only the ignored local configuration.

If JDK 21 is not installed, install it explicitly (then reopen PowerShell):

```powershell
winget install --id EclipseAdoptium.Temurin.21.JDK -e
```

## Quick start — Mac

```bash
cd /Users/stanleyroy/Desktop/Development/worksideQA
./start-mobile-qa.sh
```

Choose the same menu. The script delegates to `qa:start` and the product-scoped strict Doctor. Unsupported platform prerequisites are reported as NOT READY rather than silently substituted.

macOS repository checkouts do not need to mirror the Windows monorepo. Set the
machine-local `MERXUS_MOBILE_REPO` to the actual Mobile checkout (for example,
a standalone `merxusmobile` directory), and set `MERXUS_BACKEND_REPO` and
`MERXUS_WEB_REPO` only when those local checkouts are used by the configured
Firebase/backend services. If the Mobile checkout contains the local
`firebase.json`, the historical shared Merxus parent and web paths are not
required. These values belong only in the ignored `.maestro.local.ps1`; do not
commit user-specific `/Users/...` paths. The iOS path validates `xcrun` and the
configured simulator and does not require Android `adb`.

For macOS SageSet/iOS, set the ignored `SAGESET_IOS_MOBILE_REPO` to the local
SageSet Mobile checkout. This platform-specific value takes precedence over
`SAGESET_MOBILE_REPO`; a Windows `C:\\...` value is ignored on macOS rather than
being resolved as a relative POSIX path. Set `SAGESET_IOS_SIMULATOR_ID` for the
configured simulator. Android SageSet IDs and `adb` are Windows-only checks.

## After reboot

1. Start Firebase, backend, Metro, and the configured device only through the launcher.
2. Wait for the product `READY` summary.
3. Inspect ownership with `npm run qa:status -- --product merxus` (or `sageset`).
4. Run the displayed certification command.

Healthy WorksideQA-owned services are reused. `qa:start` starts only missing services in dependency order, waits on readiness probes, prewarms canonical Metro, starts the configured Windows Android AVD when it is offline, waits for ADB and `sys.boot_completed=1`, configures Android reverse for the product Metro port, installs the exact QA APK when needed, launches the development client against that Metro, and requires a real app screen before strict product Doctor can report READY. The Expo Development Build home/Connect screen is never considered ready. It does not launch a feature flow or start Android Studio.

## Environment inventory

| Environment | Required services | Device/runtime |
| --- | --- | --- |
| Windows / Merxus | Firebase Auth/Firestore/Storage, QA backend, canonical Maestro Metro | Android AVD selected by `MERXUS_ANDROID_AVD_NAME` (or the single installed AVD), serial from `MERXUS_ANDROID_EMULATOR_ID`, `com.merxus.mobile.qa` |
| Windows / SageSet | Firebase Auth/Firestore/Storage/Functions emulators, SageSet Maestro Metro (8081) | Android AVD selected by `SAGESET_ANDROID_AVD_NAME` (or the single installed AVD), serial from required `SAGESET_ANDROID_EMULATOR_ID`, QA app `com.workside.sageset`, actual `screen.auth.login` or `screen.today.ready` required |
| macOS / Merxus | Same Firebase/backend/Metro contracts through `qa:start` (from the configured local checkouts) | Configured iOS simulator; `xcrun` required, Android `adb` not required |
| macOS / SageSet | SageSet Firebase emulator contract and product services | Configured SageSet iOS simulator (`SAGESET_IOS_SIMULATOR_ID`); Android/ADB is not required |

## Ports

| Service | Merxus | SageSet |
| --- | ---: | ---: |
| Auth emulator | 9099 | 9099 |
| Firestore emulator | 8080 | 8080 |
| Storage emulator | 9199 | 9199 |
| Functions emulator | — | 5001 |
| QA backend | 8787 | product-defined |
| Metro | 8081 | 8081 (SageSet/Merxus are mutually exclusive) |

If a required port is occupied by the expected healthy WorksideQA service it is reused. An unexpected owner is a conflict; the launcher never kills or adopts it automatically.

## Health check only

Choose menu item 4, or run:

```text
npm run qa:mobile:health
npm run qa:doctor -- --product merxus --strict
```

This starts nothing, resets no fixtures, and reports PASS/FAIL for tools, paths, runtime configuration, services, identities, and device readiness.

## Certification status semantics

Reports distinguish the reason a check did not complete:

* **PRODUCT FAILURE** — the product, fixture, backend, or authoritative
  contract is incorrect.
* **QA INFRASTRUCTURE FAILURE** — tooling, emulator, ADB, Metro, Firebase, or
  Maestro cannot provide the required evidence.
* **MANUAL ACCEPTANCE REQUIRED** — the interaction belongs to the manual Tier 3
  policy even though the product is healthy.

An `OBSERVER_BUSY` result is always **QA INFRASTRUCTURE FAILURE**. It is never a
passing rendered-runtime result and never authorizes a certification claim.

## Troubleshooting

* **Port already occupied:** run `npm run qa:status`; inspect the PID and resolve a foreign process manually.
* **Metro wrong product:** stop only the recorded owner with `qa:stop`, then start the requested product. The runtime manifest is verified before READY.
* **Firebase wrong project:** restart the recorded service; the canonical project is `merxus-maestro-local` or `sageset-maestro-local`.
* **Simulator/emulator not booted:** `qa:start` automatically starts the configured Windows AVD and waits for ADB/boot completion. Set `MERXUS_ANDROID_AVD_NAME` or `SAGESET_ANDROID_AVD_NAME` in the ignored `.maestro.local.ps1` when multiple AVDs are installed. No arbitrary device is selected. If boot times out, inspect the reported AVD log, SDK/emulator path, serial, and ADB state.
* **Incompatible Android device:** an unexpected device is never killed or adopted. Remove the conflict manually, or correct the configured serial/AVD values, then rerun the launcher.
* **Expo Development Build launcher shown:** an installed APK is not sufficient. Ensure the product Metro service is running and rerun `qa:start`; it launches `exp+sageset://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081` automatically and waits for `screen.auth.login` or `screen.today.ready`.
* **App not installed:** SageSet requires the QA build `com.workside.sageset` on
  the configured emulator. `qa:start -- --product sageset` invokes the
  product-owned `npm run android:maestro` build/install contract when it is
  absent, then verifies the exact package. WorksideQA never substitutes the
  production `com.sageset.fitness` package.
* **Backend unavailable:** check the product backend path and health output.
* **Maestro/Java unavailable:** run Doctor; its central resolver reports the exact missing tool and supported fallback.
* **`OBSERVER_BUSY`:** do not modify application code. Follow this recovery:
  1. Stop the QA environment cleanly.
  2. Restart the canonical ADB daemon if necessary.
  3. Restart the emulator if ADB remains unhealthy.
  4. Run health/start again.
  5. If the actual application is required for release acceptance, perform the
     documented manual smoke check.
  6. Do not disable the observer or reinterpret `OBSERVER_BUSY` as readiness.

## Manual fallback commands

```text
npm run qa:start -- --product merxus
npm run qa:start -- --product sageset
npm run qa:status -- --product merxus
npm run qa:stop -- --product merxus
npm run qa:doctor -- --product merxus --strict
```

Merxus service definitions live in `packages/qa-core/src/orchestrator.js` and use existing backend fixture/reset commands. Do not mix production Metro or Firebase into a Maestro run.

## Logs and ownership

Runtime state and service logs are local and ignored under `.worksideqa/`. `runtime-state.json` records product, service, process identity, ports, working directory, generation, and runtime hash. `qa:stop` terminates only verified recorded trees and preserves ownership metadata when cleanup is incomplete.

## Known-good Windows prerequisites and commands

Use the canonical local configuration loader; do not export values manually.
Windows QA requires Firebase CLI `15.23.0`, Eclipse Temurin JDK 21, the
configured Android SDK/ADB, the pinned Maestro CLI, and product-specific
`.maestro.local.ps1` values. WorksideQA resolves Firebase deterministically and
uses the same executable for Doctor and service startup.

```powershell
Set-Location C:\Users\sjroy\Source\WorksideQA
npm run qa:start -- --product merxus
npm run qa:doctor -- --product merxus --strict
npm run qa:status -- --product merxus
```

Use `sageset` in place of `merxus` for SageSet. These commands do not claim
SageSet rendered-observer certification when `OBSERVER_BUSY` is reported.
