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

## Quick start — Mac

```bash
cd /Users/stanleyroy/Desktop/Development/worksideQA
./start-mobile-qa.sh
```

Choose the same menu. The script delegates to `qa:start` and the product-scoped strict Doctor. Unsupported platform prerequisites are reported as NOT READY rather than silently substituted.

## After reboot

1. Start Firebase, backend, Metro, and the configured device only through the launcher.
2. Wait for the product `READY` summary.
3. Inspect ownership with `npm run qa:status -- --product merxus` (or `sageset`).
4. Run the displayed certification command.

Healthy WorksideQA-owned services are reused. `qa:start` starts only missing services in dependency order, waits on readiness probes, configures Android reverse for Merxus, prewarms canonical Metro, and runs strict product Doctor. It does not launch a feature flow.

## Environment inventory

| Environment | Required services | Device/runtime |
| --- | --- | --- |
| Windows / Merxus | Firebase Auth/Firestore/Storage, QA backend, canonical Maestro Metro | Android emulator from `MERXUS_ANDROID_EMULATOR_ID`, `com.merxus.mobile.qa` |
| Windows / SageSet | Firebase Auth/Firestore/Storage/Functions emulators | Device requirements are checked by the selected flow |
| macOS / Merxus | Same Firebase/backend/Metro contracts through `qa:start` | Configured iOS simulator for iOS flows |
| macOS / SageSet | SageSet Firebase emulator contract and product services | Configured SageSet simulator/device |

## Ports

| Service | Merxus | SageSet |
| --- | ---: | ---: |
| Auth emulator | 9099 | 9099 |
| Firestore emulator | 8080 | 8080 |
| Storage emulator | 9199 | 9199 |
| Functions emulator | — | 5001 |
| QA backend | 8787 | product-defined |
| Metro | 8081 | product-defined |

If a required port is occupied by the expected healthy WorksideQA service it is reused. An unexpected owner is a conflict; the launcher never kills or adopts it automatically.

## Health check only

Choose menu item 4, or run:

```text
npm run qa:mobile:health
npm run qa:doctor -- --product merxus --strict
```

This starts nothing, resets no fixtures, and reports PASS/FAIL for tools, paths, runtime configuration, services, identities, and device readiness.

## Troubleshooting

* **Port already occupied:** run `npm run qa:status`; inspect the PID and resolve a foreign process manually.
* **Metro wrong product:** stop only the recorded owner with `qa:stop`, then start the requested product. The runtime manifest is verified before READY.
* **Firebase wrong project:** restart the recorded service; the canonical project is `merxus-maestro-local` or `sageset-maestro-local`.
* **Simulator/emulator not booted:** boot the configured device and rerun the health check; no arbitrary device is selected.
* **App not installed:** install the QA app matching the manifest app ID.
* **Backend unavailable:** check the product backend path and health output.
* **Maestro/Java unavailable:** run Doctor; its central resolver reports the exact missing tool and supported fallback.

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
