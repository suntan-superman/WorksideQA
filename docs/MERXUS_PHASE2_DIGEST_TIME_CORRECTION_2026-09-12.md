# Merxus Phase 2 first mutation: daily digest send time

Date: 2026-09-12

## Corrected architecture

The first and only implemented certification slice remains
`21-tenant-settings-update-owner-a`, but its mutation is now the real
Settings -> SMS Messaging -> SMS Policy -> Daily digest send time:
`18:00` -> `18:30`. This supersedes the branding target in the original
Phase 2 architecture/slice-status documents. Neither the account Business Name
nor the existing SMS branding override changes.

The existing protected `businessName` contract remains available. The protected
API now accepts exactly one of `businessName` or `dailyDigestTime`, with revision
and operationId. Time is strictly five-character 24-hour HH:mm, without trimming,
seconds or trailing newlines. Mutation, revision, audit and receipt are atomic.
The action is `sms.dailyDigestTime.update`, before `18:00`, after `18:30`.
Owner/manager authorization, staff denial, claims-derived tenant isolation,
exact replay, conflicting-payload rejection and stale-revision rejection remain.

Legacy SMS saves cannot change either protected property. Empty maps are no-ops;
non-object replacements are rejected, preventing erasure of protected fields.
The web full-form adapter also uses the protected route for digest time, so it
does not regress when legacy bypasses are blocked. No production deployment.

## Fixture and authoritative verification

The complete deterministic baseline is retained; `dailyDigestEnabled` remains
false and no delivery destination/provider is enabled. The verifier requires:

- Exactly `sms.dailyDigestTime` changed to `18:30`, revision incremented once,
  and a server timestamp; every other SMS property and both business names unchanged.
- Tenant B, tenant roots, users and claims unchanged.
- Exactly one successful audit and one operation receipt, matching actor,
  tenant, resource, exact values, revision and request/operation correlation.
- Zero external-provider invocations, zero blocked attempts, zero unexpected
  domain records and zero cross-tenant leakage.

Neither the flow nor mutation calls Send Digest, a scheduler, Twilio, OpenAI or
another provider. Real-emulator transaction checks use only a dedicated local
Firestore instance (`demo-merxus-phase2-rules`, 127.0.0.1:18080).

## Navigation and live evidence

The real input has `settings.sms.daily-digest-time`. The flow uses the real
`settings.sms.save`, save result/correlation markers, and reload action.
All three long traversals use semantic `scrollUntilVisible`, bounded to 20 seconds.
The existing per-flow logical timeout remains 180 seconds. Phase 1, device
selection, iOS orchestration, credentials and SageSet code are unchanged.

Read-only live checks on explicit Android `emulator-5554` first proved input ->
Save -> input navigation, followed by two more successful round trips. Only then
were both QA navigation helpers, measured anchors, fixed toolbar and its special
layout removed. A further live check with both helpers explicitly absent again
reached the real digest input, enabled Save button and returned to the input.
No live Save was tapped and no live setting was changed by these checks.

Local artifacts (not committed):

- `reports/digest-navigation-readonly/`
- `reports/digest-navigation-repeat-readonly/`
- `reports/digest-navigation-after-cleanup/`

## Validation

- Backend full suite: 180 files, 1,185 tests passed.
- Protected mutation, route and fixture/verifier positive/negative tests passed.
- Real isolated Firestore rules tests passed, including direct digest-time denial.
- Real Firestore transaction integration passed: concurrent exact replay,
  atomic audit/receipt, precise delta, unchanged Tenant B, authorization/stale/
  payload conflict rejection; existing branding integration also passed.
- Mobile unit tests: 77 passed; Phase 0/1: 14 passed; corrected settings: 7 passed.
- Final Android Maestro export passed (1,911 modules).
- WorksideQA Phase 2 validation and full mobile runner regressions passed,
  including process watchdog/cancellation/child cleanup, Phase 1 and SageSet
  release orchestration/report tests. No SageSet live certification was run.
- Web existing unit suite (122) and new SMS adapter tests (3) passed.
- Scoped Git whitespace checks passed.

Full credential-backed Android mutation certification is still OPEN: fixture
credentials were absent from this shell and WorksideQA's local environment file,
and no local backend was listening on 8787. Navigation evidence is not a claim
that the complete mutation/verification flow passed. The separate SageSet
validate-only command additionally required SAGESET_MOBILE_REPO; its shared
regression tests passed without that setting.

## Commit scope

The backend and web had previously uncommitted Phase 0/2 prerequisites. The
scoped commits include the existing QA fixture CLI, safety guard/local launcher,
SMS authorization/write-boundary rules and required test plumbing, preserving
current behavior. Unrelated backend, language, provider and other accumulated
work remains uncommitted; it was not swept into this change. Validation numbers
above describe the inspected working trees, not a fresh production deployment.

## Rerun only the corrected slice

Use the existing credential-configured QA terminal with the unchanged Owner A/B
fixture variables, MERXUS_MOBILE_REPO, MERXUS_BACKEND_REPO and explicit Android
serial configured. Keep the existing local Firebase emulator services and Metro.

Start (or reload, if running stale code) only the local guarded backend in its own terminal:

```powershell
Set-Location C:\Users\sjroy\Source\Merxus\merxus-ai-backend
npm run qa:maestro:serve
```

Then, in the credential-configured WorksideQA terminal:

```powershell
Set-Location C:\Users\sjroy\Source\WorksideQA
$env:MERXUS_ANDROID_EMULATOR_ID = 'emulator-5554'
npm run qa:merxus:maestro:phase2:settings:android
```

No native mobile rebuild/reinstall is required: Metro loaded the JS/layout changes
on the existing QA development build during these checks. No Firebase/Metro restart,
production deployment, iOS certification or additional Phase 2 mutation was performed.
