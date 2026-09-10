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
