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

## Maestro Phase 2

Phase 2 validates deterministic social and gamification state without mutating
that state from Maestro:

| Flow | SageSet fixture scenario | Authenticated account | Validation |
| --- | --- | --- | --- |
| `30-invitation-pending` | `invitation-pending` | User B | Pending invitation, inviter, and group identity |
| `31-member-active` | `member-active` | User A | Active group membership and initial challenge participants |
| `32-member-paused` | `member-paused` | User A | Paused User B membership and retained challenge |
| `33-member-resumed` | `member-resumed` | User A | Resumed User B membership and retained 5-rep progress |
| `34-progress-recorded` | `progress-recorded` | User A | User B's 10 recorded reps and non-verified classification |
| `35-member-removed` | `member-removed` | User A | User B absent while User A's group/challenge persists |

Every Phase 2 flow clears app state and establishes a fresh deterministic
session after its fixture reset. No flow depends on an authentication session
or state mutation from an earlier flow, so individual flows are safe to run.

Before every Phase 2 flow, WorksideQA invokes SageSet's
`reset:maestro-fixtures` npm script through `SAGESET_MOBILE_REPO`, passing the
flow's declared scenario plus the SageSet reset confirmation flags. WorksideQA
does not contain fixture data or reset logic. The runner forces the local
`sageset-maestro-local` project, loopback emulator hosts, and external
notifications off. It fails before Maestro starts if the repository path,
credential environment variables, or reset command fails.

The following shell-only values are required for Phase 2 fixture resets:

```sh
export SAGESET_MOBILE_REPO=/absolute/path/to/SageSet/mobile
export SAGESET_MAESTRO_USER_A_EMAIL=maestro.a@example.test
export SAGESET_MAESTRO_USER_A_PASSWORD='replace-with-local-fixture-password'
export SAGESET_MAESTRO_USER_B_EMAIL=maestro.b@example.test
export SAGESET_MAESTRO_USER_B_PASSWORD='replace-with-local-fixture-password'
export SAGESET_MAESTRO_QA_EMAIL_ALLOWLIST="$SAGESET_MAESTRO_USER_A_EMAIL,$SAGESET_MAESTRO_USER_B_EMAIL"
```

Do not commit these values. The fixture reset enforces two distinct allowlisted
users and 12-character minimum passwords.

Validate Phase 2 configuration and YAML on any platform:

```sh
npm run qa:sageset:maestro:phase2:validate
npm run test:mobile
```

With the SageSet Firebase emulator stack running and `SageSet QA` installed on
the booted iOS Simulator, execute the Mac-only suite:

```sh
npm run qa:sageset:maestro:phase2
```

Every scenario is independently reset before its flow. JUnit, runner logs, and
Maestro failure artifacts use the existing timestamped directory beneath
`reports/mobile/sageset/maestro`.

Phase 2 navigation uses stable SageSet `testID` values. Exact text assertions
are limited to deterministic fixture output (handles, group association,
progress, leaderboard values, and the recorded/non-verified classification).
No SageSet mobile selector change is required for this phase.

## Maestro Phase 3

Phase 3 performs real social actions through the SageSet QA UI and then asks a
SageSet-owned verifier to assert the resulting Firestore emulator state:

| Flow | Fixture | Account | UI mutation | Backend verification |
| --- | --- | --- | --- | --- |
| `40-accept-invitation` | `invitation-pending` | User B | Accept Maestro Group invitation | Invitation accepted; User B added and active; no challenge or unrelated record created |
| `41-pause-member` | `member-active` | User A | Pause User B | User B paused but retained; group/challenge baseline preserved |
| `42-resume-member` | `member-paused` | User A | Resume User B | User B active; membership, 5-rep progress, and prior contribution retained |
| `43-remove-member` | `member-active` | User A | Remove User B | Membership/status/participation removed; User A and group retained |
| `44-join-challenge` | `member-active` | User B | Join Maestro Weekly Squats | Participant created at zero; counts updated; no contribution or verified result created |

The runner resets the declared fixture before every flow. Only after Maestro
passes does it execute SageSet's `verify:maestro-mutation` command through
`SAGESET_MOBILE_REPO`. The verifier requires the exact
`sageset-maestro-local` project and loopback emulators and rejects external
notifications. It never contains or accepts production fallback behavior.

Each timestamped report directory contains the existing JUnit and Maestro
artifacts plus per-flow `result.json` and a suite `summary.json`. Stage data
distinguishes fixture setup/reset failures, Maestro UI failures, and backend
verification failures. Successful mutation flows report
`UI PASS / BACKEND PASS`; a mismatched emulator state reports
`UI PASS / BACKEND FAIL` and fails the suite.

Phase 3 uses stable IDs for every mutation action. SageSet adds member row and
status IDs and, only in the fail-closed Maestro environment, an in-app member
confirmation surface with stable confirm IDs. Normal production/device builds
retain the native confirmation alerts and unchanged mutation behavior.

Validate Phase 3 configuration, mappings, verifier contracts, and YAML on any
platform:

```sh
npm run qa:sageset:maestro:phase3:validate
npm run test:mobile
```

With the same fixture environment variables configured, the emulator stack
running, and the current SageSet QA build installed, execute on macOS:

```sh
npm run qa:sageset:maestro:phase3
```

The QA app must be rebuilt and reinstalled once for the Phase 3 member row,
status, and stable confirmation selectors to be present.

### Deferred flow 45: record progress

`45-record-progress` is intentionally not registered or executed. SageSet's QA
simulator build does not compile the physical AR tracking implementation, and
the current joined-challenge UI correctly shows `Tracking Unavailable`. There
is no legitimate simulator-safe UI route for choosing and submitting a saved
AR session. WorksideQA must not invent fixture mutation logic, call the backend
directly as a substitute for a UI action, or create a fake SageSet Verified
result.

Before flow 45 can be added, SageSet must own a narrow QA-safe product seam that
exposes a deterministic, already-saved eligible session through the normal
record-progress UI and submits it through the production mutation contract.
That seam must remain emulator-only, preserve recorded/not-verified
classification, reject duplicate session submission, and keep all production
AR behavior unchanged. WorksideQA can then orchestrate the flow and invoke a
SageSet-owned post-mutation verifier.

## Maestro Phase 4

Phase 4 proves rejected, cancelled, duplicate, and recoverable operations do
not corrupt deterministic social/gamification state:

| Flow | Fixture | Account | Negative behavior |
| --- | --- | --- | --- |
| `50-invalid-login-recovery` | `clean` | User A | Wrong password is rejected, then the correct login succeeds |
| `51-cancel-member-pause` | `member-active` | User A | Cancelling pause leaves User B active |
| `52-cancel-member-remove` | `member-active` | User A | Cancelling removal preserves User B |
| `53-paused-member-cannot-join` | `member-paused` | User B | Paused membership exposes a disabled challenge action |
| `54-duplicate-challenge-join` | `member-resumed` | User B | Existing participation cannot issue another join |
| `55-duplicate-invitation-accept` | `member-active` | User B | Accepted invitation no longer exposes an Accept action |
| `56-unauthorized-member-management` | `member-active` | User B | Non-owner cannot see owner-only member controls |
| `57-backend-error-recovery` | `backend-error-once` | User A | One deterministic dashboard failure is recoverable by retry |

Every flow receives an independent fixture reset and fresh login. After the UI
passes, WorksideQA invokes SageSet's `verify:maestro-negative` command. A
backend pass means the prohibited mutation did not occur and fixture ownership,
membership, participant counts, contributions, and zero-verified-result state
remain correct. Reports distinguish `FIXTURE FAIL`, `UI NEGATIVE-PATH FAIL`,
and `UI PASS / BACKEND NON-MUTATION FAIL`.

The `backend-error-once` fixture is the only new scenario. It creates a
single-use dashboard failure record for User A. The Functions implementation
will consume it only when `FUNCTIONS_EMULATOR=true` and the project is exactly
`sageset-maestro-local`; production cannot activate this seam. The Maestro UI
shows stable `social.dashboard.error` and `social.dashboard.retry` controls,
while non-Maestro builds retain the existing native error alert.

Validate on any platform:

```sh
npm run qa:sageset:maestro:phase4:validate
npm run test:mobile
```

Execute on macOS with the same fixture environment, running emulator stack,
and current SageSet QA app installed:

```sh
npm run qa:sageset:maestro:phase4
```

## Maestro Phase 5

Phase 5 validates the production workout lifecycle through the SageSet QA UI
and then delegates Firestore verification to SageSet's
`verify:maestro-workout` command:

| Flow | Fixture | Account | UI behavior | Backend case |
| --- | --- | --- | --- | --- |
| `60-workout-plan-visible` | `workout-ready` | User A | Deterministic workout, exercises, prescriptions, and incomplete status | `workout-ready` |
| `61-start-workout` | `workout-ready` | User A | Open and close the first exercise log | `workout-started` |
| `62-adjust-sets-reps` | `workout-ready` | User A | Change achieved Squat reps and verify recovery | `sets-reps-adjusted` |
| `63-complete-workout` | `workout-ready` | User A | Complete all three exercises and dismiss the reward summary | `workout-completed` |
| `64-exercise-history-carryover` | `workout-history` | User A | Verify prior Dumbbell Row load/reps and current defaults | `history-carryover` |
| `65-plan-pause` | `active-plan` | User A | Pause the plan using the normal break UI | `plan-paused` |
| `66-plan-resume` | `paused-plan` | User A | Resume the same paused plan | `plan-resumed` |
| `67-workout-progression-impact` | `workout-ready-progress-baseline` | User A | Complete workout and verify SageScore 100 / XP 500 | `progression-impact` |
| `68-incomplete-workout-recovery` | `workout-ready` | User A | Save partial values, reopen, and verify no completion | `incomplete-workout-recovery` |

Every flow resets its declared fixture and performs a fresh User A login. The
runner then reports fixture failures, workout UI failures, and post-UI backend
failures separately. JUnit, Maestro debug output, per-flow results, and the
suite summary remain in the existing timestamped
`reports/mobile/sageset/maestro` structure.

SageSet currently starts workout activity by opening an exercise log; it does
not create a separate workout-level session or `startedAt`. The log supports
editing achieved reps and load but does not provide a control for changing the
prescribed number of sets. Individual set checkbox state is also not persisted
unless the exercise is completed. Phase 5 preserves and verifies those real
semantics instead of introducing test-only workout behavior. Prescribed
set-count customization and incomplete checkbox restoration remain product
gaps, not hidden test substitutions.

Validate all Phase 5 flow/config mappings on any platform:

```sh
npm run qa:sageset:maestro:phase5:validate
npm run test:mobile
```

With the SageSet emulator stack running and the current SageSet QA build
installed on the booted iOS Simulator, execute on macOS:

```sh
npm run qa:sageset:maestro:phase5
```

WorksideQA only orchestrates the scenario name and backend case. Fixture data,
reset behavior, workout verification, and safety enforcement remain owned by
SageSet. The suite cannot use production Firebase, external notifications,
physical AR, or SageSet Verified results.
