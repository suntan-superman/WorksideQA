# Merxus Maestro Phase 2 certification status

Updated 2026-09-14 from the current WorksideQA artifacts and validation runs.
Generation/export results are not treated as live platform certification.

| Slice | Scenario | Android | iOS | Backend | Status | Blocker | Next action |
|------:|----------|---------|-----|---------|--------|---------|-------------|
| 21 | Tenant settings update (Owner A) | PASS | NOT RUN | PASS | BLOCKED | iOS requires the Mac simulator | Run the iOS slice on the configured simulator |
| 22 | SMS notification retry max attempts | PASS | NOT RUN | PASS | BLOCKED | iOS requires the Mac simulator | Run the iOS slice on the configured simulator |
| 23 | SMS notification retry delay | PASS | NOT RUN | PASS | BLOCKED | iOS requires the Mac simulator | Run the iOS slice on the configured simulator |
| 24 | Daily digest enabled round-trip | PASS | NOT RUN | PASS | BLOCKED | iOS requires the Mac simulator | Run the iOS slice on the configured simulator |
| 25 | Unsaved retry-delay reload (non-mutation) | PASS | NOT RUN | PASS | BLOCKED | iOS requires the Mac simulator | Run Slice 25 first on the configured simulator |

## Evidence

The latest Android Slice 25 artifact is:

`reports/mobile/merxus/maestro/2026-09-14T20-11-51-654Z/android/25-tenant-settings-unsaved-reload-owner-a/result.json`

It records runtime-flow, Android IME dismissal, and runtime-resume success, the
authoritative reload result (`15`), and the non-mutation backend invariants.
The latest Android artifacts for slices 21–24 likewise record UI and backend
passes; their paths are retained under `reports/mobile/merxus/maestro/`.

All five suites validate successfully offline, including the iOS-generated
stages and explicit simulator metadata. This is generation coverage only.

The configured iOS simulator is selected by `MERXUS_IOS_SIMULATOR_ID`:

`3C029085-0B3D-49B6-AB7D-2943DA45F695`

The iOS run was not attempted here because this Windows host has no `xcrun`.
The exact command to run on the Mac is:

```bash
npm run qa:merxus:maestro:phase2:unsaved-reload:ios
```

Run that Slice 25 command first and record its UI and authoritative backend
result before advancing to slices 21–24. No next mutation is authorized until
the required platform certification is complete.
