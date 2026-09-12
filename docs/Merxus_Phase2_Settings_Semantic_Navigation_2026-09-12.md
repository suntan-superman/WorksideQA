# Phase 2 settings: Maestro-only navigation

## Change

The 180-second logical runtime remains appropriate. The subsequent live Android run exhausted both the available scrolling strategy and then failed a normal semantic assertion: Save was still outside the viewport. This change replaces the two long swipe loops; it does not add swipes or extend timeouts.

Merxus Mobile now provides two controls in a small QA toolbar outside the Settings ScrollView:

| QA navigation selector | Existing target |
| --- | --- |
| `settings.sms.qa-scroll-to-save` | `settings.sms.save` |
| `settings.sms.qa-scroll-to-business-name` | `settings.sms.business-name` |

The controls are rendered whenever the authoritative `RUNTIME_CONFIG` is Maestro and its existing runtime validation passes, using the same validator as `QaEnvironmentGate`. Exposure does not depend on SMS loading/expansion or tenant role: staff can see the navigation toolbar in Maestro too. Production, staging, development and malformed QA configurations never expose it. Direct calls recheck the runtime gate; action readiness depends only on mounted native scroll/anchor refs. A missing anchor returns false without changing anything.

Lifecycle correction: the original implementation incorrectly combined runtime exposure with transient SMS readiness. These are now separate. The toolbar remains mounted before SMS expansion; its existing ref objects become usable when the form mounts, and return to a no-op after unmount. No permission is granted by toolbar visibility. Authorization remains solely on the real input and Save handler/button.

## Native navigation, not a save shortcut

Each target has a zero-height, non-collapsible QA-only native anchor immediately before the existing control. On each press, the anchor measures its position relative to the existing ScrollView's native content view using `measureLayout`; the existing ScrollView is then sent `scrollTo({ y, animated: false })`. No cached screen coordinates or nested-card offsets are used. Fresh measurement handles layout changes after reload or expanded content changes.

Offscreen clipping is disabled only while this QA navigation is enabled, keeping distant anchors available for measurement. React Native documents that clipped offscreen views can be removed from native backing hierarchies; see [ScrollView clipping behavior](https://reactnative.dev/docs/0.81/scrollview#removeclippedsubviews). The installed React Native 0.81.5 ScrollView exposes `getInnerViewRef`, allowing measurement against content rather than the viewport.

The helper has no save, form-update, backend, Firestore, revision, operation-ID, credential or provider capability. Missing refs, invalid layout measurements and unmounted targets fail closed. The real field and Save button retain their original value binding, change handler, save handler and disabled/authorization conditions. Native configuration and dependencies are unchanged.

## WorksideQA flow

Only `21-tenant-settings-update-owner-a.yaml` changes:

1. After opening SMS, traverse to and explicitly wait for the real Business name field before editing. That field and the Save anchor mount together in the same non-virtualized form. After the unchanged edit and keyboard dismissal, tap `settings.sms.qa-scroll-to-save`.
2. Wait at most 5 seconds for `settings.sms.save`.
3. Assert visibility and `enabled: true`, then tap the real Save button by its semantic selector.
4. Preserve saved-result checks, request/operation correlation, screenshot and reload.
5. After reload completes, tap `settings.sms.qa-scroll-to-business-name`.
6. Wait at most 5 seconds for the real field and assert the exact persisted branding value.

No optional final assertion, coordinate tap, additional mutation, or reverse-swipe loop is introduced. The YAML remains common to Android and iOS; iOS split-flow generation retains the same shortcuts. No iOS certification or other Phase 2 workflow is started.

The earlier [watchdog report](Merxus_Phase2_Settings_Watchdog_2026-09-12.md) documents the unchanged 180-second logical / 195-second Android process watchdog and independent 90-second backend verifier budget. Its 12-swipe description records the previous implementation, now superseded by this navigation change.

## Repository scope

The mobile worktree initially contained the already-used Phase 2 save/API/selector implementation, not yet committed. It was preserved without alteration in prerequisite commit `ef3032b`; the new navigation work is a separate commit. No backend repository or rules were edited. The pre-existing mobile `.gitignore` change and WorksideQA `reports/` remain outside these commits.

## Validation and rerun

Unit coverage checks real component rendering against production/staging/development/Maestro app configurations for Android and iOS, both build identities, both tap handlers, fresh measurements, invalid configurations, missing/unmounted anchors, and unchanged Save/input wiring. WorksideQA tests verify exact shortcut/wait/assert/tap ordering and unchanged mutation/correlation contracts, including common iOS runtime transformation.

Validation completed:

- Mobile Phase 2 settings/navigation tests: 8 passed (including pre-expansion/staff visibility, missing-anchor no-op and mount/unmount lifecycle).
- Mobile Phase 1, including Phase 0 runtime safety and login reset: 14 passed.
- Existing mobile Node suite: 77 passed.
- Android Maestro offline Hermes export: passed (1,913 modules), with local QA environment and external providers disabled. This did not rebuild/install the native app or restart the existing Metro service.
- WorksideQA Phase 2 validation and full mobile suite: passed, including Phase 1, Windows launcher/watchdog/cancellation and SageSet release regressions.
- Git whitespace checks: passed in both repositories.

The existing QA development build can load these JavaScript-only changes from its already-running Maestro-configured Metro server. No native rebuild/reinstall, backend deployment, Firebase/Metro restart or emulator restart is required. If another workstation serves Metro, pull the mobile commit there as well; a normal application reload may be needed to receive the current bundle. The flow's ordinary relaunch requests the current Metro bundle.

From the existing configured Windows shell:

```powershell
Set-Location C:\Users\sjroy\Source\WorksideQA
npm run qa:merxus:maestro:phase2:settings:android
```

The next live acceptance criterion is: both shortcut taps reveal the real controls, Save executes normally, reload shows the exact persisted Business name, and the unchanged backend verifier passes. Live certification is not implied by unit or export validation.
