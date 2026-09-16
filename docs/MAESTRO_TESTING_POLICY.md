# Maestro Testing Policy

> **The QA system exists to protect the product. The product must not be redesigned merely to satisfy the QA system.**

This policy governs WorksideQA mobile automation for Merxus AI and SageSet.
Operational startup is maintained in [MOBILE_QA_STARTUP_GUIDE.md](./MOBILE_QA_STARTUP_GUIDE.md).

## Certification tiers

### Tier 1 — Automated and authoritative

These contracts are authoritative: Firebase/emulator isolation, fixture setup,
authentication identities, API/backend behavior, persistence, tenant isolation,
revision/audit/receipt contracts, provider-zero contracts, and deterministic
runtime configuration.

### Tier 2 — Maestro stable smoke coverage

Maestro covers app launch, navigation, major screen availability, stable
semantic controls, and selected high-value workflows. An observer failure is
infrastructure evidence, never a product pass.

### Tier 3 — Manual mobile acceptance

Manual acceptance covers fragile text-entry/focus behavior, OS overlays, visual
correctness, and workflows affected by Maestro or ADB instrumentation
instability.

We will not spend engineering time attempting to make every mobile interaction
deterministic under Maestro. Move automation-limited assertions to the
appropriate tier instead of redesigning the product.

## Windows implementation status (2026-09-16)

Windows Merxus automated environment startup is operational. Windows SageSet
automated startup is operational through Firebase, fixtures, Metro, emulator,
QA application installation/reuse, and application launch. SageSet's actual
login screen has also been manually observed; WorksideQA reported
`appState=actual-sageset-application` and `READY` in that run.

The Windows toolchain is pinned to Firebase CLI `15.23.0` and Eclipse Temurin
JDK 21. Firebase executable resolution is deterministic. Service logs are
product-specific, and stale process ownership reconciliation, Metro process
handoff validation, and bounded canonical ADB recovery are implemented.

Known limitation: intermittent Maestro rendered-observer `OBSERVER_BUSY` has
coincided with periods of unresponsive ADB; causal direction has not been
proven. `OBSERVER_BUSY` remains fail-closed and must never be treated as
certification success. SageSet is not described as fully automated
rendered-observer certified while this condition remains intermittent.

## Purpose

Maestro is for externally observable journeys: launch, login/logout, onboarding, navigation, major actions, permissions, system overlays, background/resume, major user-visible outcomes, and short stable cross-screen workflows. It is not intended to prove every React Native implementation detail, internal state transition, or difficult TextInput gesture.

## Four testing layers

1. **Maestro** — stable user journeys and major observable outcomes.
2. **Mobile automated tests** — TextInput state, change/focus/blur, validation, formatting, component state, callback wiring, QA gating, and local rules.
3. **Backend/integration tests** — authenticated APIs, persistence, authorization, tenant isolation, revisions, audit, receipts, correlation, retries, provider invocation, and data integrity.
4. **Manual QA** — proportionate checks such as ordinary typing, keyboard appearance, minor scrolling, visual alignment, and cosmetic behavior.

## The 60–90 minute rule

When a Maestro-specific issue consumes approximately 60–90 minutes and evidence points primarily to accessibility-tree discovery, ScrollView traversal, keyboard automation, selector instability, element materialization, simulator interaction, or XCUITest behavior, stop. Classify it as **PRODUCT DEFECT** or **AUTOMATION LIMITATION**, then move an automation-limited assertion to the appropriate layer. Do not redesign the product to satisfy Maestro.

## Slice 28 hybrid certification

Slice 28 is frozen and certified with this evidence model:

* Maestro proves the iOS SMS settings surface is reachable.
* Mobile automated tests prove TextInput/state/handler wiring.
* Authenticated integration proves the production API mutation and readback.
* The backend verifier proves persistence, tenant isolation, revision, audit, receipt, correlation, and provider-zero.

Evidence must state which layer proved each contract; Maestro must not be credited for backend actions it did not perform.

## QA-only helpers

Helpers may expose read-only semantic state, delegate to an existing production handler, provide a stable invocation surface for an existing operation, or expose diagnostic state. They must never duplicate business logic, bypass authorization or validation, fabricate success or IDs, directly mutate authoritative persistence, or silently change production behavior. Every helper is strictly runtime gated and fails closed.

Merxus iOS Maestro gating is:

* `Platform.OS === 'ios'`
* `RUNTIME_CONFIG.isMaestro === true`
* `environment === 'maestro'`
* `appId === 'com.merxus.mobile.qa'`
* `RUNTIME_CONFIG_VALIDATION.ok === true`

Feature-specific authorization remains mandatory.

## Platform strategy and oracles

Android may retain direct Maestro interaction where stable. iOS may use integration evidence or a narrowly scoped semantic helper when platform accessibility makes direct TextInput interaction disproportionate. Business contracts and backend assertions remain equivalent. Prefer low-cost semantic oracles that expose real state (retry value, reload hydration, Save result/correlation) over elaborate UI accommodations.

## Cleanup review

* **KEEP** — retry-value oracle, reload hydration state, and real Save result/correlation markers: they expose real state and protect evidence.
* **KEEP** — `MaestroSmsFocus` reveal/focus machinery and readiness marker while registered diagnostic workflows depend on them; they are strictly gated and outside the frozen composite path.
* **KEEP** — QA draft setup, Save delegation, and Reload delegation: they delegate to production handlers and remain useful for focused diagnostics.
* **KEEP** — registered diagnostic workflows and tests: they preserve historical evidence and are read-only unless explicitly invoking a protected handler.
* **REMOVE** — no temporary Mobile machinery was removed in this closeout; deleting the accumulated focus/reveal helpers would break registered diagnostic workflows and alter shared SettingsScreen code. Retention is intentional and documented rather than cosmetic cleanup.

No new Maestro slices or generic automation infrastructure should be added as part of this closeout. Further Maestro work requires an explicit product-testing need.
