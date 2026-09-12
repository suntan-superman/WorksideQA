# Merxus iOS Phase 2 — fixed keyboard dismissal

## Change

The old Maestro dismiss selector wrapped the Daily digest label inside Settings' ScrollView. Scrolling to retry fields and opening the numeric keyboard could move that target out of view.

Mobile now renders `settings.sms.qa-dismiss-keyboard` as a reserved 44-point, non-shrinking row below the Settings header, outside the ScrollView. It is not an overlay and does not cover real controls. It renders only on iOS with valid authoritative Maestro runtime configuration; production, staging, development, invalid Maestro and Android render nothing. The original Daily digest label is a plain Text again. The sole button action is `Keyboard.dismiss()`.

The existing shared `keyboardDismissAfterEdit` iOS-simulator transformation now generates:

1. Input the replacement text using the unchanged field entry sequence.
2. Wait at most 5 seconds for the fixed dismiss selector.
3. Tap that semantic selector.
4. Assert the original exact edited value.
5. Continue existing navigation, real Save, correlation and reload.

This applies to digest time, retry max and retry delay through existing device metadata. Merxus no longer requests scrolling to the dismiss control. The checked-in YAML, Android generation, iOS login/overlay split stages, application watchdog budgets and Phase 1 behavior are unchanged. No coordinates, arbitrary sleeps, new providers or mutation logic were added.

## Validation

- Mobile: 20 Phase 2 tests, 77 general tests, 14 Phase 1/runtime tests passed.
- Component tests execute the gate/action; AST/layout tests verify the row is a sibling of the flexing ScrollView, has non-shrinking reserved height, and contains no form descendants.
- iOS flow generation covers all three fields, explicit UDID, wait/tap/assert ordering, no helper scrolling, unchanged Android entry and unchanged Phase 1 stages.
- All three Phase 2 manifest/YAML validation commands passed.
- Full WorksideQA mobile suite passed, including device selection, timeout/cancellation/process-tree cleanup, correlation, Maestro runner and SageSet shared-harness release regressions.
- Android/iOS offline Maestro exports passed; external providers were disabled. Git whitespace checks passed.

## Mac retest

This change is JavaScript-only. Pull the changed Mobile and WorksideQA repositories on the Mac, then reload the existing QA development app from its updated Metro source. No native rebuild/reinstall, backend deployment/restart, Firebase restart or emulator restart is required. If Metro retains a stale module graph after the component rename, restart only Metro with its existing Maestro configuration and `--clear`.

From the Mac WorksideQA checkout, in the existing configured QA terminal with the explicit simulator UDID and fixture credentials:

```bash
npm run qa:merxus:maestro:phase2:retry-delay:ios
```

The implementation host is Windows and has no `xcrun` or Mac simulator access; live iOS execution is pending. Unit/generated-flow results are not live certification. No other mutation slice was run live.
