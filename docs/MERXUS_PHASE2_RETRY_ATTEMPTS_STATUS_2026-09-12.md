# Merxus Phase 2 — notification retry max attempts

Implementation complete locally; live certification remains OPEN.

## Contract

- Real field: `settings.sms.notification-retry-max-attempts`.
- Isolated mutation: `sms.notificationRetryMaxAttempts`, integer `2` -> `3`.
- Existing product bounds: 1–10 (both existing web SMS settings layouts).
- `notificationRetryEnabled` stays false. No retry processing or provider action.
- Reuses the existing protected transaction, Owner/Manager policy, revision,
  audit and operation receipt. Audit action: `sms.notificationRetryMaxAttempts.update`.
- Exact replay succeeds; conflicting payload, stale revision, Staff and client
  tenant overrides fail. Legacy saves cannot bypass the protected field.
- Verifier compares the complete tenant settings snapshot except the target,
  one revision increment and `updatedAt`; both business names, digest settings,
  unrelated SMS fields, Tenant B, users and claims remain unchanged.
- Requires one success audit, one operation receipt, exact before/after and
  request/operation correlation, no unexpected records, zero provider calls,
  zero blocked provider attempts and zero cross-tenant changes.
- Existing digest slice and Phase 1 remain separate and unchanged.

## Platform behavior

Android retains the common semantic navigation and `hideKeyboard` sequence.
iOS retains the split flow and existing `settings.sms.qa-dismiss-keyboard`
target. A bounded 5-second semantic upward scroll reaches that existing label
before dismissal. No new mobile QA helper, coordinates, sleeps or timeout
inflation. Logical runtime is 180 seconds, with existing platform allowances.

## Validation

- [x] Backend transaction/validation/route tests: 79 passed.
- [x] Rules: real isolated Firestore emulator, direct SMS/revision, deletion,
  replacement, Staff, cross-tenant, audit and receipt write denials passed.
  Existing rules required no changes. The temporary rules emulator was stopped.
- [x] Fixture/verifier, Phase 1 backend and isolation tests: 69 passed.
- [x] Mobile Phase 2: 13 passed; mobile general: 77; Phase 1: 14.
- [x] Web protected-save adapter compatibility: 5 passed.
- [x] Android and iOS Maestro exports passed, providers disabled.
- [x] WorksideQA Phase 2 validation and full mobile suite passed, including
  Phase 1, correlation artifacts, timeout/cancellation and SageSet regressions.
- [ ] Android live certification: attempted, preflight blocked. After selecting
  the installed `emulator-5554` and locating Maestro 2.10.0, this shell lacked
  `MERXUS_MAESTRO_OWNER_A_EMAIL`. Owner A/B credential variables were not present.
  No fixture reset or application flow ran.
- [ ] iOS live certification: intentionally not attempted before Android passes.
- [ ] A third Phase 2 mutation: blocked until BOTH platforms pass.

## Next executable steps

Use the existing configured QA terminal with Owner A/B email/password variables,
`MERXUS_BACKEND_REPO`, local Auth/Firestore emulators, the Maestro-isolated backend
on port 8787 and Maestro Metro configuration. Do not use production credentials
or services. Load the updated backend code in the local QA server before testing;
reload mobile JavaScript through Metro. No native build/reinstall is needed.

From WorksideQA on Windows:

```powershell
$env:MERXUS_ANDROID_EMULATOR_ID = 'emulator-5554'
npm run qa:merxus:maestro:phase2:retry:android
```

Only after Android passes, on the Mac with an explicitly selected booted QA
simulator (`MERXUS_IOS_SIMULATOR_ID`) and the same isolated prerequisites:

```bash
npm run qa:merxus:maestro:phase2:retry:ios
```

Backend pre-existing changes and web `.gitignore` changes were preserved.
Changes are local; this task has not committed, pushed or deployed them.
