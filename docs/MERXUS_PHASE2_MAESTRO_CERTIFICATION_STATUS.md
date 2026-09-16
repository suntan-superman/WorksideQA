# Merxus Maestro Phase 2 certification status

Updated 2026-09-16 from the authoritative Mac certification result and current
WorksideQA validation runs. Generation/export results are not treated as live
platform certification.

| Slice | Scenario | Android | iOS | Backend | Status | Blocker | Next action |
|------:|----------|---------|-----|---------|--------|---------|-------------|
| 21 | Tenant settings update (Owner A) | PASS | NOT RUN | PASS | BLOCKED | iOS requires the Mac simulator | Run the iOS slice on the configured simulator |
| 22 | SMS notification retry max attempts | PASS | NOT RUN | PASS | BLOCKED | iOS requires the Mac simulator | Run the iOS slice on the configured simulator |
| 23 | SMS notification retry delay | PASS | NOT RUN | PASS | BLOCKED | iOS requires the Mac simulator | Run the iOS slice on the configured simulator |
| 24 | Daily digest enabled round-trip | PASS | NOT RUN | PASS | BLOCKED | iOS requires the Mac simulator | Run the iOS slice on the configured simulator |
| 25 | Unsaved retry-delay reload (non-mutation) | PASS | NOT RUN | PASS | BLOCKED | iOS requires the Mac simulator | Run Slice 25 first on the configured simulator |
| 28 | Owner B / Tenant B retry-max persistence | NOT RUN | PASS | PASS | CERTIFIED | None | Frozen; no further Maestro scope |

Slice 28 iOS used the approved hybrid evidence model:

- Component A: Maestro proved the iOS SMS settings surface was reachable and
  exposed the authoritative retry-max oracle (`2`).
- Component B: authenticated Owner B integration used the production SMS
  settings GET/PATCH contract and authoritative readback (`2` → `3`).
- Mobile tests proved TextInput/draft/handler wiring and QA helper delegation.
- The backend verifier proved persistence, Tenant A isolation, revision,
  audit, receipt, correlation, and provider-zero invariants.

All six contracts passed: iOS surface, persistence integration, backend
verification, tenant isolation, revision/audit/receipt, and provider-zero.

Certification date: 2026-09-16 (iOS, PASS).

Authoritative Mac artifact:

`/Users/stanleyroy/Desktop/Development/worksideQA/reports/mobile/merxus/maestro/slice28-composite/2026-09-16T00-52-37-135Z`

Relevant implementation baseline: WorksideQA `4288516` and Mobile `83c5e86`.

Slice 28 is frozen. Do not restore the former iOS monolithic Save/Reload UI
flow or direct iOS TextInput typing.

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
