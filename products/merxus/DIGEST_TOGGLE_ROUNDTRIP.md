# Phase 2 fourth slice: daily digest enabled round-trip

Implementation date: 2026-09-12. Status: implemented and regression-tested; live Android and iOS certification OPEN. Do not start a fifth slice until both pass.

## Safety review before implementation

- API: `PATCH /api/sms/settings`, `sms.dailyDigestEnabled` (strict boolean).
- Firestore: tenant collection (`offices`, `restaurants`, or `agents`) / tenant ID / `meta/settings`, nested `sms.dailyDigestEnabled`.
- Previously an ordinary legacy SMS save property. Now uses the existing one-field protected transaction with revision and operation ID, alongside branding/time/retry fields. Owner/Manager allowed; Staff denied. No role expansion or rules change.
- The real mobile switch changes local form state only. Saving updates configuration, revision, audit and receipt atomically. Neither path sends, enqueues, creates notification events, or starts a scheduler.
- `runScheduledDailyDigestBatch` reads enabled/time from persisted profiles only when independently invoked. It can create `notification_job_runs`, `notification_digest_runs`, and `notification_events`. The new flow NEVER invokes this scheduler or Send Digest.
- The dedicated Maestro backend uses only loopback emulators and blocks external network/provider calls. This is **not** a claim that the network guard prevents local scheduler writes: an independently invoked scheduler could still create local records. Run only the dedicated QA backend, without notification workers/scheduler invocations. Any provider attempt (including blocked), digest record, notification job/event, SMS, or unexpected tenant subcollection fails verification.
- No native dependency, production deployment, Phase 1, Android device-selection, iOS split-stage, or SageSet behavior changes.

## Contract

`false -> true -> false`; baseline revision 1, final 3. Each leg has its own request ID, operation ID, audit and receipt. Both actions are `sms.dailyDigestEnabled.update` with exact false/true before/after pairs. Exact replay adds nothing; conflicting replay and stale revision fail.

The real switch selector is `settings.sms.daily-digest-enabled`. The common flow asserts boolean state with Maestro's documented `checked` selector, uses the real Save, captures both correlation pairs, reloads after each save, and asserts persisted state. No settings keyboard interaction or new QA helper.

Reference: [Maestro state selectors](https://docs.maestro.dev/reference/selectors/state-selectors).

The verifier orders receipts by revision and proves both committed intermediate/final values from transaction receipts/audits, plus the final authoritative settings snapshot. The intermediate reload UI independently proves true. It does not claim a separate backend snapshot was sampled between legs.

The final snapshot must match the fixture baseline except revision and allowed `updatedAt`: digest time, retry configuration, names, all other SMS fields, users/claims and Tenant B remain unchanged. Exactly two audits/receipts and two distinct UI/backend correlation pairs are required. Existing slices still require exactly one unique correlation.

## Validation completed

- Backend: 247 targeted transaction, validation, authorization, route, fixture/verifier, Phase 1, provider-isolation and scheduler/digest regression tests passed.
- Dedicated disposable Firestore emulator: real transaction rollback on **both** legs; replay; final revision 3; exactly two receipts/audits; no digest/event/job/SMS records. Emulator project `demo-merxus-phase2-rules`, port 18080, separate from certification Firebase.
- Real Firestore rules tests: Owner/Manager/Staff direct writes to either boolean value denied; protected SMS/revision/audit/receipt and cross-tenant boundaries retained. Rules unchanged.
- Mobile: 22 Phase 2 tests, 14 Phase 1 tests, 77 general unit tests passed; Android/iOS QA exports passed.
- Web SMS adapter: 8 tests passed. Adapter updated to avoid breaking its existing full-form save now that boolean changes require the protected contract.
- WorksideQA: fourth-slice validation; full mobile runner suite, correlation tests, device/timeout/cancellation tests, Phase 1 and SageSet release harness regressions passed. Harness simulations are not live certification.

## Load changes and certify

No native rebuild/reinstall required. Metro can load the mobile JavaScript changes. Restart only the **local Maestro backend** in its existing terminal using `npm run qa:maestro:serve` so it loads the expanded allowlist; do not deploy production. Existing Firebase/Metro/emulator do not need restarting solely for this change.

Use the existing credential-configured certification terminal. This execution session had none of the four required `MERXUS_MAESTRO_OWNER_A_EMAIL`, `MERXUS_MAESTRO_OWNER_A_PASSWORD`, `MERXUS_MAESTRO_OWNER_B_EMAIL`, `MERXUS_MAESTRO_OWNER_B_PASSWORD` variables. Do not paste credentials into logs or commit them. The attempted Android run stopped at missing Owner A email before fixture reset or UI execution.

Android first, from WorksideQA:

```powershell
Set-Location C:\Users\sjroy\Source\WorksideQA
$env:MERXUS_MOBILE_REPO = 'C:\Users\sjroy\Source\Merxus\mobile'
$env:MERXUS_BACKEND_REPO = 'C:\Users\sjroy\Source\Merxus\merxus-ai-backend'
$env:MERXUS_ANDROID_EMULATOR_ID = 'emulator-5554'
npm run qa:merxus:maestro:phase2:digest-toggle:android
```

Only after Android UI PASS / BACKEND PASS, use the credential-configured Mac terminal from its WorksideQA repository. Retain its existing Mac `MERXUS_MOBILE_REPO` and `MERXUS_BACKEND_REPO` paths:

```sh
MERXUS_IOS_SIMULATOR_ID=3C029085-0B3D-49B6-AB7D-2943DA45F695 npm run qa:merxus:maestro:phase2:digest-toggle:ios
```

Expected result: UI PASS / BACKEND PASS, revision 3, final enabled false, audit/receipt/correlation counts 2, matched correlations, all isolation/delivery counters zero. A failed run may leave the intermediate true value in the **isolated fixture**; the next scenario reset restores false. Do not run delivery workers against fixtures or assume a failed flow completed the return leg.
