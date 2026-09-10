# Codex Next Actions — SageSet Maestro Pilot

## Objective

Make the WorksideQA Maestro bootstrap execute reliably against the SageSet iOS Simulator without requiring Codex on the Mac.

## Phase A — inspect, do not redesign

1. Inspect SageSet navigation and authentication screens.
2. Identify existing React Native `testID` / accessibility labels.
3. Map starter Maestro selectors to current controls.
4. Add missing stable `testID` values only where needed.
5. Do not change production behavior or layout simply for testing.

## Phase B — smoke certification

Make these pass in sequence:

1. `00-launch-smoke.yaml`
2. `01-login-smoke.yaml`
3. `10-gamification-progression.yaml`
4. `20-groups-challenges.yaml`

Initial certification target: iOS Simulator.

## Phase C — deterministic QA state

Add or reuse a QA-safe reset method that prepares:
- QA User A;
- QA User B;
- gamification access enabled;
- known SageScore/XP/achievement state;
- predictable group/invitation state.

Safeguards:
- explicit environment check;
- Firebase project allowlist;
- QA user allowlist;
- fail closed if environment is ambiguous.

## Phase D — two-account group lifecycle

Automate:
- A creates group;
- A invites B;
- B accepts;
- B joins challenge;
- A pauses B;
- B is blocked;
- A resumes B;
- B participates again;
- A removes B;
- leaderboard no longer treats B as active.

Use fixture/reset helpers between flows.

## Phase E — reporting

Mac runner should:
- exit non-zero on failure;
- save reports under `mobile/maestro/reports`;
- preserve Maestro failure artifacts/screenshots when available;
- print failed flow names clearly.

## Hard boundaries

- Do not automate actual human AR rep recognition as a simulator requirement.
- Do not create fake production SageSet Verified results.
- Do not commit QA passwords.
- Do not require a separate Mac codebase.
- Do not introduce TypeScript into SageSet mobile code merely for tests.
