# Merxus Phase 2 settings watchdog — 2026-09-12

## Scope and diagnosis

Only `21-tenant-settings-update-owner-a` receives a longer declared runtime: 180,000 ms, previously 90,000 ms. The user-provided live trace ends during a running swipe, after successful credential entry and branding edit; it does not show a subsequent UI assertion failure.

The runner already added startup grace and the manifest device multiplier. No separate Phase-1-sized ceiling was found on this CLI execution path. The insufficient per-flow declaration and discarded `timedOut` outcome were the defects addressed here.

No workflow YAML changed. Both 12-iteration semantic swipe loops, final Save selector/tap, business-name edit, reload/persisted-value check, fixtures, credentials, provider isolation, and backend verification contract remain intact. No Merxus Mobile, backend, authorization, rules, audit, or idempotency code changed.

## Budget contract

`effectiveWatchdogMs = ceil(declaredFlowTimeoutMs * runtimeMultiplier) + startupGraceMs`

| Execution | Logical runtime | Multiplier | Startup grace | Process watchdog |
| --- | ---: | ---: | ---: | ---: |
| Phase 2 settings, Android | 180,000 ms | 1 | 15,000 ms | 195,000 ms |
| Phase 2 settings, iOS simulator (calculation only) | 180,000 ms | 1.5 | 15,000 ms | 285,000 ms |
| Phase 1 launch, Android | 60,000 ms | 1 | 15,000 ms | 75,000 ms |
| Phase 1 launch, iOS simulator | 60,000 ms | 1.5 | 15,000 ms | 105,000 ms |
| Other Phase 1 flows, Android | 90,000 ms | 1 | 15,000 ms | 105,000 ms |
| Other Phase 1 flows, iOS simulator | 90,000 ms | 1.5 | 15,000 ms | 150,000 ms |

The runtime process gets its entire budget after fixture/reset and targeted clear-state/deep-link commands finish. Startup grace is added once per Maestro process. Expo preparation commands inside generated YAML remain part of that process's runtime. Existing sequential iOS split stages retain individual watchdogs; this is not a single end-to-end suite deadline.

Fixture reset and backend verification retain independent 90,000 ms process budgets for Merxus. SageSet's undeclared timeout retains the historical ten-minute process default; explicitly declared SageSet budgets are unchanged. Invalid, infinite, nonpositive, or overflowing Node timer budgets are rejected. No unlimited test or new timeout multiplier was added.

## Timeout reporting and cleanup

`runner.log` records each runtime stage's budget before execution. When WorksideQA's timer expires, it records an explicit diagnostic before terminating the child. `result.json` and the summary carry `errorCode: WORKSIDEQA_PROCESS_TIMEOUT` plus a `timeout` object, for example:

```json
{
  "code": "WORKSIDEQA_PROCESS_TIMEOUT",
  "declaredFlowTimeoutMs": 180000,
  "startupGraceMs": 15000,
  "effectiveWatchdogMs": 195000,
  "runtimeMultiplier": 1,
  "stage": "application",
  "stageName": "application"
}
```

`failureStage: ui` remains for report compatibility, but the reason is explicitly a WorksideQA timeout rather than a Maestro assertion. Ordinary nonzero UI exits are not marked as watchdog timeouts. A timed-out or cancelled child cannot be treated as successful even if its termination handler returns exit code zero. Backend verification is not started after UI timeout/cancellation.

Windows retains targeted process-tree termination. Ctrl+C stops the active child; timer/listener cleanup occurs on process close or spawn error. POSIX termination retains the bounded SIGKILL escalation, also used for cancellation, with the escalation timer cleared on close.

## Separate heartbeat investigation — no workaround applied

The audited runner awaits version detection, preparation commands, and every Maestro stage sequentially. The mobile and release-certification entry points likewise execute their Maestro work sequentially. WorksideQA does not set `MAESTRO_HOME` or start a concurrent heartbeat helper. Separate user-launched CLI/Studio sessions can still share Maestro's default storage; this audit cannot identify the lock owner during the earlier live run.

Maestro 2.10.0 schedules session heartbeats every five seconds and catches/logs heartbeat exceptions. This is consistent with the user's observation that commands continued after warnings. See [MaestroSessionManager source](https://github.com/mobile-dev-inc/Maestro/blob/cli-2.10.0/maestro-cli/src/main/java/maestro/cli/session/MaestroSessionManager.kt).

The session database is based on Java `user.home` at `.maestro/sessions`, not a `MAESTRO_HOME` environment lookup. It is also used to detect existing device sessions and decide session shutdown. Therefore merely setting a per-run `MAESTRO_HOME` is not a demonstrated session-storage fix. See [SessionStore source](https://github.com/mobile-dev-inc/Maestro/blob/cli-2.10.0/maestro-cli/src/main/java/maestro/cli/session/SessionStore.kt).

The database implementation holds a file-channel lock, then reads/writes the file through separate file helpers. Inference: Windows locking semantics could cause a conflict even without two WorksideQA Maestro processes. This is a candidate explanation, not a reproduced root cause. See [KeyValueStore source](https://github.com/mobile-dev-inc/Maestro/blob/cli-2.10.0/maestro-cli/src/main/java/maestro/cli/db/KeyValueStore.kt).

No safe, supported session-only override was established in that source. Do not change Java user-home, delete session files, or isolate state on the certification path without separately validating driver installation, device-session ownership and cleanup. If warnings persist, capture their full stack trace and concurrent Maestro/Studio process identities during a dedicated investigation, then reproduce against the pinned CLI before proposing an upstream fix or isolated-storage experiment. Heartbeat cleanup is not a prerequisite for this rerun.

## Validation and next step

- Passed Phase 2 settings YAML/manifest validation.
- Passed the complete WorksideQA mobile suite: Windows command shims, device selection, Maestro launcher, watchdog/cancellation, Merxus Phase 0/1/2 contracts, mobile runner, SageSet release orchestration and report regressions.
- New tests verify actual timeout/cancellation cleanup with disposable Windows Node process trees and artifact serialization with simulated Maestro children, including distinct UI versus backend watchdog budgets. They do not execute product fixtures or contact providers.
- Passed Git whitespace validation.
- No live Phase 1 rerun, other Phase 2 flow, or iOS certification was executed. Live success of this settings flow remains to be verified.

From the existing configured Windows certification shell:

```powershell
Set-Location C:\Users\sjroy\Source\WorksideQA
npm run qa:merxus:maestro:phase2:settings:android
```

This selects only the settings flow. Keep the existing device selection and fixture credential environment variables. No mobile rebuild/reinstall, deployment, or service restart is required.
