# SageSet QA

SageSet includes web, Firebase, mobile, and AI coaching validation targets.

WorksideQA is the authoritative home for SageSet Maestro orchestration and flow definitions. The SageSet repository owns only app selectors, the `maestro-simulator` build configuration, and emulator-safe fixture/reset support. Do not copy WorksideQA flow definitions into SageSet.

The iOS simulator contract is:

- app id: `com.workside.sageset`;
- app environment: `maestro`;
- Firebase project id: `sageset-maestro-local`;
- backend: local Firebase Auth, Firestore, Functions, and Storage emulators;
- external notifications: disabled.

Set `SAGESET_MOBILE_REPO` to the local `SageSet/mobile` directory on each runner. WorksideQA owns flow selection and supplies the credential environment keys declared in `product.manifest.json`; SageSet's fixture command remains the only reset implementation.

## Maestro Phase 1

The first simulator certification suite is intentionally read-only after login:

1. `00-launch-smoke`
2. `01-login-smoke`
3. `10-gamification-progression`
4. `20-groups-challenges`

Run configuration/YAML validation on any platform:

```sh
npm run qa:sageset:maestro:validate
```

Run a single flow or the ordered suite on the Mac with the QA app installed and
the Firebase emulator stack running:

```sh
npm run qa:sageset:maestro -- --flow 00-launch-smoke
npm run qa:sageset:maestro:phase1
```

The login flow requires `SAGESET_MAESTRO_USER_A_EMAIL` and
`SAGESET_MAESTRO_USER_A_PASSWORD` in the shell. The runner passes only the
variables declared by each flow, disables Maestro analytics and update checks,
and writes JUnit output plus failure artifacts beneath
`reports/mobile/sageset/maestro`. Reports are ignored by Git. Actual execution
fails closed on non-macOS hosts.
