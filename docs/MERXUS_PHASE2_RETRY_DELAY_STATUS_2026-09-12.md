# Merxus Phase 2 third mutation — 2026-09-12

## Status

Implemented and regression-validated. **Live Android and iOS certification remain pending.** No fourth mutation or production deployment was performed.

Target: real SMS Policy notification retry delay, `15 -> 20` minutes. Retry processing remains disabled. The first two slices retain their separate suites, baselines and behavior.

## Implementation and commits

- Backend `959a336`: extend the existing protected transaction to retry delay; reuse Owner/Manager authorization, optimistic revision, field-specific audit and operation receipt. Legacy flat/nested SMS saves cannot change protected retry fields. Include the previously uncommitted retry-max dependency, independent fixture/verifier dispatch, and real emulator atomicity test. Unrelated existing backend edits were not committed; only the protected-field hunk of `smsRoutes.js` was staged.
- Mobile `13361b6`: attach `settings.sms.notification-retry-delay-minutes` to the real input, preserve role gating, validate and send one protected numeric mutation through real Save. No new QA helper or native change.
- Web `9a40af6`: keep existing full-form Settings compatible by routing retry changes through the protected API. Include the previously uncommitted retry-max adapter dependency and target-specific direct-write rules tests. Firestore rules themselves are unchanged.
- WorksideQA: flow `23-tenant-settings-retry-delay-owner-a`, case `phase2-settings-retry-delay-owner-a`, suite `phase2-retry-delay`. Reuse existing correlation artifact collection, Android navigation, iOS split stages and semantic keyboard dismissal. No generic runner changes. Logical timeout remains 180,000 ms with existing platform/startup allowances.

These are local commits; no push or deployment was performed in this task.

## Domain and safety

Both existing web Settings implementations specify delay bounds `min=1`, `max=1440`; those existing product limits are used. The protected API accepts integer JSON numbers only. Mobile converts validated integer input text into numeric JSON. Null, fractions, malformed input, negative, zero and out-of-range values fail before writes.

Fixtures reset independently for each slice: delay `15`, retry max `2`, daily digest `18:00`, retries and digest disabled. The third-slice verifier rejects inherited `3` or `18:30` baselines.

The verifier requires exactly the delay change plus revision/timestamp metadata; unchanged other SMS settings, account names, Tenant B, users and claims; one successful `sms.notificationRetryDelayMinutes.update` audit with before `15` / after `20`; one receipt; matching request/operation IDs; and zero provider events, blocked provider attempts, cross-tenant changes or unexpected domain records. The UI never enables retries or calls Send/scheduler/provider actions.

## Completed validation

| Validation | Result |
| --- | --- |
| Backend `npm run test:run` | 180 files, 1,278 tests passed |
| Targeted protected mutation and route tests | 103 passed; also included in full run |
| Targeted verifier, safety and Phase 1 contract tests | 93 passed; also included in full run |
| Real isolated Firestore rules test | Passed; Owner/Manager/Staff direct protected writes denied, read/tenant/audit/receipt boundaries preserved |
| Real Firestore transaction failure injection | Passed; audit-create collision leaves settings unchanged and receipt absent; subsequent success/replay leaves one audit, one receipt and revision 2 |
| Mobile `npm run test:maestro:phase2:settings` | 15 passed |
| Mobile `npm run test:node` | 77 passed |
| Mobile `npm run test:maestro:phase1` (includes Phase 0 runtime safety) | 14 passed |
| Web `node --test src/api/smsSettings.test.js` | 7 passed |
| Android and iOS Maestro exports | Both passed, offline and external providers disabled |
| WorksideQA Phase 1 / digest / retry-max / retry-delay validation | Passed: 4 / 1 / 1 / 1 flows respectively |
| WorksideQA `npm run test:mobile` | Passed, including process launch, explicit devices, timeout/cancellation/process-tree cleanup, Phase 0/1/2, correlation, runner and SageSet release regressions |
| Git whitespace checks for changed/staged files in all four repositories | Passed |

SageSet PASS/FAIL scenarios in regression output are harness test cases, not new live SageSet certification. No native build was performed or claimed.

The rules and atomicity scripts ran only against the isolated local `demo-merxus-phase2-rules` emulator at `127.0.0.1:18080`, not the active certification emulator. Temporary test records were removed and that dedicated emulator was stopped after testing.

## Live attempt and blockers

Android invocation reached Maestro 2.10.0 and then failed safely at required-environment preflight:

`Missing required environment variable for 23-tenant-settings-retry-delay-owner-a: MERXUS_MAESTRO_OWNER_A_EMAIL`

Artifact directory: `reports/mobile/merxus/maestro/2026-09-12T19-38-40-325Z/android`.

This tool shell does not have the existing Owner A/B fixture credential environment. No credential was invented, printed, or changed. No fixture reset or UI mutation ran. Run from the existing configured QA terminal with all four Owner A/B email/password variables available to the fixture process. Other emulator-only preflight requirements remain unchanged.

iOS was not attempted: Android must pass first, and this Windows host cannot run the selected Mac simulator. No live third-slice certification is claimed.

## Re-run only this slice

First load these commits into the corresponding local QA repositories. The existing local QA backend must load its updated source before certification (restart that QA backend process if it does not reload automatically). Keep its existing Maestro environment and provider isolation. No production deployment is needed.

No mobile rebuild/reinstall is required: the existing QA development build can load this JavaScript-only change from Metro. Reload the app with current Metro source; no Firebase/emulator restart or Metro restart is inherently required.

Android, from the existing QA-configured PowerShell terminal:

```powershell
Set-Location C:\Users\sjroy\Source\WorksideQA
$env:MERXUS_BACKEND_REPO = 'C:\Users\sjroy\Source\Merxus\merxus-ai-backend'
$env:MERXUS_ANDROID_EMULATOR_ID = 'emulator-5554'
npm run qa:merxus:maestro:phase2:retry-delay:android
```

After Android returns **UI PASS / BACKEND PASS**, on the Mac from the configured WorksideQA checkout and QA terminal (with `MERXUS_BACKEND_REPO` pointing to that Mac's backend checkout):

```bash
MERXUS_IOS_SIMULATOR_ID=3C029085-0B3D-49B6-AB7D-2943DA45F695 \
  npm run qa:merxus:maestro:phase2:retry-delay:ios
```

Use that explicit UDID only if it is still the dedicated QA simulator on the Mac. Do not fall back to simulator name or an arbitrary booted device.

## Remaining checklist

- [ ] Load backend/mobile/web/WorksideQA commits into the QA environment.
- [ ] Run only third-slice Android certification from the configured fixture-credential terminal.
- [ ] Confirm authoritative correlation and all isolation counters pass.
- [ ] Then run only third-slice iOS certification on the dedicated simulator.
- [ ] Record both live pass artifacts before considering a fourth mutation.
