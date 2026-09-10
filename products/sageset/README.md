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
| `32-member-paused` | `member-paused` | Reuses User A | Paused User B membership and retained challenge |
| `33-member-resumed` | `member-resumed` | Reuses User A | Resumed User B membership and retained 5-rep progress |
| `34-progress-recorded` | `progress-recorded` | Reuses User A | User B's 10 recorded reps and non-verified classification |
| `35-member-removed` | `member-removed` | Reuses User A | User B absent while User A's group/challenge persists |

The ordered suite intentionally logs in as User B for the incoming-invitation
view, then clears app state and logs in as User A for the remaining lifecycle
views. Later flows reuse User A's authenticated state. Run the complete ordered
suite rather than an individual reuse-dependent flow on a fresh simulator.

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
