# WorksideQA Technical Architecture Specification

**Version:** 1.0  
**Date:** June 29, 2026  
**Owner:** Workside Software LLC  
**Purpose:** Define the architecture, standards, and implementation roadmap for WorksideQA, an internal QA automation and intelligent testing platform for Workside web, mobile, API, Firebase, and AI-powered products.

---

## 1. Executive Summary

WorksideQA is a shared quality assurance platform designed to test and validate the full Workside Software product ecosystem, including RadiusIQ, Merxus, SageSet, Route Logistics, Workside Support Console, AnyRyde, and future products.

The goal is not to create isolated Playwright tests for each app. The goal is to build a reusable QA platform with shared testing capabilities, product-specific manifests, automated reporting, browser automation, mobile automation, Firebase verification, API testing, AI conversation validation, visual regression, performance checks, accessibility checks, and eventually an intelligent QA dashboard.

WorksideQA should be treated as a production-grade internal platform, maintained in its own GitHub repository and versioned independently from the applications it tests.

---

## 2. Core Objectives

WorksideQA should provide the following capabilities:

1. Run consistent smoke tests across all Workside products.
2. Automate browser testing with Playwright.
3. Support native mobile testing through Maestro in later phases.
4. Validate backend APIs and Cloud Run services.
5. Verify Firebase Auth, Firestore, Storage, and security rule behavior.
6. Capture screenshots, logs, traces, console errors, and network failures.
7. Generate human-readable HTML reports and machine-readable JSON/JUnit output.
8. Track historical test results and release readiness.
9. Support AI-assisted exploratory testing and persona-based testing.
10. Provide a foundation for a future WorksideQA dashboard.

---

## 3. Guiding Principles

### 3.1 Platform First

WorksideQA is not a folder of scripts. It is a reusable internal engineering platform.

### 3.2 Product-Agnostic Core

Shared packages must not hardcode RadiusIQ, Merxus, SageSet, or any other product. Product-specific details belong under `/products` and configuration manifests.

### 3.3 Configuration Over Duplication

Every product should register itself through a manifest that describes URLs, commands, credentials, Firebase projects, test suites, and supported workflows.

### 3.4 Local First, Cloud Later

The initial system should run locally on the development machine to minimize cost. CI/CD integration, cloud runners, and hosted dashboards can be added later.

### 3.5 Practical Before Perfect

The first successful milestone is a reliable smoke test for one product. More advanced testing layers should be added incrementally.

### 3.6 AI as an Amplifier, Not a Replacement

AI should assist with exploratory testing, usability observations, conversation evaluation, and bug report generation. Deterministic smoke tests remain the foundation.

---

## 4. Current Repository Structure

Recommended root structure:

```text
WorksideQA/
├── .git/
├── common/
├── configs/
├── dashboard/
├── docs/
├── node_modules/
├── packages/
├── products/
├── prompts/
├── reports/
├── screenshots/
├── templates/
├── package.json
├── package-lock.json
└── README.md
```

---

## 5. Recommended Folder Responsibilities

### 5.1 `/packages`

Reusable platform capabilities live here.

```text
packages/
├── qa-core/
├── qa-browser/
├── qa-mobile/
├── qa-api/
├── qa-firebase/
├── qa-openai/
├── qa-performance/
├── qa-accessibility/
├── qa-security/
├── qa-reporting/
├── qa-utils/
└── qa-config/
```

Each package should expose a clean public interface and avoid product-specific logic.

### 5.2 `/products`

Each product has its own folder and manifest.

```text
products/
├── anyryde/
├── merxus/
├── radiusiq/
├── route-logistics/
├── sageset/
└── support-console/
```

Each product folder should eventually contain:

```text
products/radiusiq/
├── product.manifest.json
├── smoke.test.js
├── workflows/
├── personas/
├── fixtures/
└── README.md
```

### 5.3 `/configs`

Global and provider-specific configuration.

Recommended structure:

```text
configs/
├── global/
├── firebase/
├── maestro/
├── openai/
├── playwright/
├── stripe/
└── twilio/
```

Avoid nested naming such as `configs/configs` unless there is a specific purpose.

### 5.4 `/dashboard`

Future web dashboard for QA history, pass/fail status, performance, screenshots, and release readiness.

Initial phase can be static HTML reports. Later phase can be a React/Vite dashboard.

### 5.5 `/reports`

Generated test output.

Recommended future structure:

```text
reports/
├── html/
├── json/
├── junit/
└── history/
```

### 5.6 `/screenshots`

Screenshots and visual regression artifacts.

Recommended future structure:

```text
screenshots/
├── baseline/
├── current/
└── diff/
```

### 5.7 `/prompts`

Reusable AI testing prompts and persona instructions.

Examples:

```text
prompts/
├── smoke-test.md
├── new-user-review.md
├── restaurant-owner.md
├── franchise-owner.md
├── real-estate-agent.md
├── frustrated-user.md
└── ai-conversation-evaluator.md
```

### 5.8 `/templates`

Reusable QA scaffolding templates.

Recommended structure:

```text
templates/
├── cloud-run/
├── expo/
├── firebase/
├── netlify/
├── new-product/
└── react/
```

Remove any unnecessary nested `templates/templates` folder unless it has a clear use.

### 5.9 `/common`

Common non-package assets, utilities, examples, or documentation snippets. If common code becomes important, move it into `/packages/qa-utils` or another formal package.

---

## 6. Package Architecture

### 6.1 `qa-core`

The orchestration engine.

Responsibilities:

- Load product manifests.
- Resolve environment settings.
- Select test suites.
- Invoke browser/mobile/API/Firebase modules.
- Manage lifecycle hooks.
- Aggregate results.
- Pass results to reporting.

Proposed public functions:

```js
loadProductManifest(productKey)
resolveProductConfig(manifest, environment)
runProductSuite(productKey, suiteName, options)
runAllProducts(options)
```

### 6.2 `qa-config`

Configuration and schema validation.

Responsibilities:

- Validate product manifests.
- Validate environment files.
- Load credentials safely.
- Enforce required fields.
- Prevent secrets from entering reports.

### 6.3 `qa-browser`

Playwright-based browser automation.

Responsibilities:

- Launch browsers.
- Navigate to product URLs.
- Login and logout.
- Fill forms.
- Capture screenshots.
- Capture console errors.
- Capture network failures.
- Run viewport/responsive checks.
- Support visual regression later.

### 6.4 `qa-mobile`

Mobile automation layer.

Initial recommendation: use Maestro for Expo/React Native testing.

Responsibilities:

- Run Maestro flows.
- Support iOS simulator/device testing on Mac.
- Support Android emulator/device testing later.
- Capture screenshots and logs.
- Validate push notification flows where practical.

### 6.5 `qa-api`

HTTP/API testing.

Responsibilities:

- Test Cloud Run endpoints.
- Test webhook endpoints.
- Validate response codes and payloads.
- Support authenticated requests.
- Track latency.
- Support retry/wait behavior for async workflows.

### 6.6 `qa-firebase`

Firebase verification.

Responsibilities:

- Verify Firestore writes.
- Verify expected documents exist.
- Validate document fields.
- Verify Auth users where appropriate.
- Validate Storage artifacts.
- Support emulator-based testing later.
- Avoid destructive production operations by default.

### 6.7 `qa-openai`

AI behavior validation.

Responsibilities:

- Evaluate AI chat/call responses.
- Run prompt-based conversation tests.
- Compare expected intent and actual response.
- Track hallucination risks.
- Validate product-specific AI flows such as Merxus call handling and SageSet coaching.

### 6.8 `qa-performance`

Performance testing.

Responsibilities:

- Page load timing.
- Core Web Vitals where available.
- API latency.
- Long-running task detection.
- Bundle size checks later.
- Historical regression tracking later.

### 6.9 `qa-accessibility`

Accessibility testing.

Responsibilities:

- Detect missing labels.
- Detect contrast issues.
- Validate keyboard navigation.
- Support axe-core integration later.

### 6.10 `qa-security`

Security-oriented checks.

Responsibilities:

- Confirm no secrets exposed in pages.
- Verify unsafe console logs are not present.
- Check basic auth-protected pages.
- Confirm unauthenticated users cannot access protected routes.
- Support dependency/security scanning later.

### 6.11 `qa-reporting`

Report generation.

Responsibilities:

- Produce HTML reports.
- Produce JSON output.
- Produce JUnit output for CI.
- Save screenshots and traces.
- Generate release readiness summaries.
- Support dashboard ingestion.

### 6.12 `qa-utils`

General-purpose helpers.

Responsibilities:

- Date/time utilities.
- Path utilities.
- Safe logging.
- Retry helpers.
- Environment helpers.
- File helpers.

---

## 7. Product Manifest Specification

Each product should define a manifest file.

Example:

```json
{
  "key": "radiusiq",
  "name": "RadiusIQ",
  "type": "react-vite",
  "status": "active",
  "baseUrl": {
    "local": "http://localhost:5173",
    "staging": "https://radiusiq-staging.netlify.app",
    "production": "https://radiusiq.ai"
  },
  "devServer": {
    "enabled": true,
    "workingDirectory": "C:/Users/sjroy/Source/RadiusIQ/apps/web",
    "command": "npm run dev",
    "port": 5173,
    "healthUrl": "http://localhost:5173"
  },
  "auth": {
    "strategy": "email-password",
    "demoUserEnvKey": "RADIUSIQ_DEMO_EMAIL",
    "demoPasswordEnvKey": "RADIUSIQ_DEMO_PASSWORD"
  },
  "firebase": {
    "enabled": true,
    "projectId": "radiusiq-prod"
  },
  "suites": {
    "smoke": ["login", "dashboard", "basic-navigation"],
    "regression": ["login", "dashboard", "competitor-scan", "alerts"],
    "release": ["smoke", "api", "firebase", "accessibility", "performance"]
  },
  "personas": [
    "restaurant-owner",
    "marketing-manager",
    "franchise-owner"
  ],
  "tags": ["web", "firebase", "cloud-run", "ai"]
}
```

---

## 8. Test Lifecycle

A standard test run should follow this lifecycle:

1. Parse command.
2. Load product manifest.
3. Resolve environment.
4. Validate required configuration.
5. Start dev server if requested.
6. Launch browser or mobile runner.
7. Execute selected suite.
8. Capture artifacts.
9. Verify backend/database state.
10. Aggregate results.
11. Generate reports.
12. Exit with proper status code.

---

## 9. Command Design

Initial package scripts should be simple.

Recommended `package.json` scripts:

```json
{
  "scripts": {
    "qa": "node packages/qa-core/src/cli.js",
    "qa:radiusiq": "node packages/qa-core/src/cli.js --product radiusiq --suite smoke",
    "qa:merxus": "node packages/qa-core/src/cli.js --product merxus --suite smoke",
    "qa:all": "node packages/qa-core/src/cli.js --all --suite smoke",
    "qa:report": "node packages/qa-reporting/src/open-latest-report.js"
  }
}
```

Future command examples:

```bash
npm run qa -- --product radiusiq --suite smoke
npm run qa -- --product merxus --suite regression
npm run qa -- --all --suite smoke
npm run qa -- --product sageset --persona new-user
npm run qa -- --product merxus --ai-review
```

---

## 10. Browser Testing Strategy

Initial browser automation should use Playwright.

First browser test capabilities:

- Open product URL.
- Confirm app loads.
- Login with demo credentials.
- Confirm dashboard loads.
- Navigate primary menu.
- Capture screenshot.
- Fail on serious console errors.
- Fail on failed network requests unless ignored by config.

Recommended first target: RadiusIQ or SageSet web app, depending on which currently has the most stable demo login.

---

## 11. Mobile Testing Strategy

Mobile testing should not block the initial WorksideQA launch.

Recommended sequence:

1. Start with Playwright for web.
2. Add responsive browser tests using Playwright device emulation.
3. Add Maestro on Mac for iOS Expo testing.
4. Add Android testing later only when needed.

Important distinction:

- Playwright mobile emulation tests mobile web behavior.
- Maestro tests native Expo/React Native apps.
- Physical iOS device automation is possible but more complex than simulator testing.

---

## 12. Firebase Testing Strategy

Firebase verification should be implemented carefully.

Rules:

1. Never run destructive operations against production without explicit opt-in.
2. Prefer demo tenants and test users.
3. Use read-only verification where possible.
4. Mask secrets and PII from reports.
5. Separate local, staging, and production configs.

Example verification checks:

- User document exists after login.
- Competitor document exists after adding competitor.
- Scan status changes from queued to complete.
- Alerts collection receives expected document.
- Merxus call transcript appears after test call flow.
- SageSet coaching memory updates after weekly review.

---

## 13. API Testing Strategy

API tests should validate Cloud Run and backend service health.

Initial checks:

- `/healthz` returns 200.
- Authenticated endpoints reject anonymous users.
- Valid authenticated request returns expected shape.
- Async endpoints update status correctly.

Future checks:

- Stripe webhook simulation.
- Twilio webhook simulation.
- SendGrid event webhook handling.
- OpenAI response validation.

---

## 14. AI Testing Strategy

AI testing should be introduced after deterministic smoke tests are stable.

Examples:

### Merxus

- Customer asks restaurant hours.
- Customer asks for banquet room reservation.
- Customer asks to speak to a human.
- Customer asks unrelated or abusive question.

### SageSet

- User asks for workout modification.
- User asks about nutrition history.
- User requests weekly review celebration.
- User asks for unsafe health advice.

### RadiusIQ

- User asks what competitor changed.
- User asks what action to take next.
- User asks for explanation of an alert.

Evaluation criteria:

- Intent recognized.
- Response is relevant.
- No hallucinated business data.
- Workflow proceeds correctly.
- Sensitive topics handled safely.

---

## 15. Reporting Requirements

Each test run should produce:

1. Summary result.
2. Product name.
3. Suite name.
4. Environment.
5. Start/end time.
6. Duration.
7. Pass/fail count.
8. Warnings.
9. Screenshots.
10. Console errors.
11. Network failures.
12. Trace links where applicable.
13. Suggested next actions.

Example release readiness output:

```text
Product: RadiusIQ
Suite: Smoke
Environment: Local
Status: PASS
Duration: 2m 14s
Screenshots: 6
Console Errors: 0
Network Failures: 0
Warnings: 1
Release Readiness: 96%
```

---

## 16. Dashboard Vision

The dashboard should eventually provide:

- Product status cards.
- Latest test result.
- Historical pass/fail trends.
- Screenshots.
- Performance trends.
- Accessibility scores.
- Release readiness score.
- Failure details.
- AI-generated bug summaries.

Example dashboard sections:

```text
Dashboard
├── Overview
├── Products
├── Test Runs
├── Failures
├── Screenshots
├── Performance
├── Accessibility
├── AI Reviews
└── Release Readiness
```

---

## 17. Security and Secrets

Secrets must never be committed.

Use `.env.local` for local secrets and include `.env.example` for documentation.

Required `.gitignore` entries:

```gitignore
node_modules/
.env
.env.*
!.env.example
reports/
screenshots/current/
screenshots/diff/
playwright-report/
test-results/
```

Reports must mask:

- API keys.
- Firebase private keys.
- Stripe keys.
- Twilio tokens.
- OpenAI keys.
- User emails where appropriate.
- Phone numbers where appropriate.

---

## 18. Cost-Efficient Implementation Strategy

The lowest-cost path is:

1. Local Playwright browser testing.
2. Local HTML/JSON reports.
3. Firebase read-only verification.
4. Local Maestro testing on Mac for iOS.
5. GitHub Actions only after local reliability is proven.
6. Cloud mobile testing only when business need justifies the cost.

Do not start with paid mobile device farms or complex CI infrastructure.

---

## 19. Phased Roadmap

### Phase 1: Foundation

- Finalize repository structure.
- Add `.gitignore` and `.env.example`.
- Add product manifest schema.
- Implement `qa-core` CLI skeleton.
- Implement basic `qa-reporting` output.

### Phase 2: First Web Smoke Test

- Implement Playwright integration in `qa-browser`.
- Add first product manifest.
- Add login helper.
- Add dashboard smoke test.
- Generate screenshots and HTML report.

### Phase 3: Multi-Product Smoke Testing

- Add manifests for Merxus, RadiusIQ, SageSet, Support Console, Route Logistics.
- Standardize login flows.
- Add `qa:all` command.
- Add consolidated report.

### Phase 4: Firebase and API Verification

- Add Firebase read-only checks.
- Add API health checks.
- Add async workflow validation.
- Add environment separation.

### Phase 5: Mobile Testing

- Install Maestro on Mac.
- Add `qa-mobile` package.
- Add iOS Expo smoke flows.
- Add Android later if needed.

### Phase 6: AI and Persona Testing

- Add prompt library.
- Add AI conversation tests.
- Add persona-based exploratory testing.
- Add AI-generated usability observations.

### Phase 7: Dashboard

- Build local dashboard.
- Add historical run storage.
- Add release readiness scoring.
- Add screenshots and trend charts.

### Phase 8: CI/CD Integration

- Add GitHub Actions.
- Add deploy-preview testing.
- Add pull request reports.
- Add nightly smoke tests.

### Phase 9: Workside Support Console Integration

- Create support tickets from failed test runs.
- Attach screenshots, logs, traces, and reproduction steps.
- Notify the appropriate owner.

---

## 20. Initial Codex Implementation Order

Codex should not attempt to implement everything at once.

Recommended first implementation sequence:

1. Create `.gitignore` and `.env.example`.
2. Add product manifest schema.
3. Add `products/radiusiq/product.manifest.json` example.
4. Build `qa-core` CLI skeleton.
5. Build `qa-config` manifest loader.
6. Build `qa-browser` Playwright smoke runner.
7. Build `qa-reporting` basic HTML/JSON report.
8. Add first smoke test.
9. Add README instructions.
10. Run locally and verify.

---

## 21. Definition of Done for Phase 1

Phase 1 is complete when:

- `npm install` works.
- `npm run qa -- --product radiusiq --suite smoke` runs.
- Product manifest loads successfully.
- Browser opens product URL.
- Screenshot is captured.
- Basic report is generated.
- Failed tests return non-zero exit code.
- No secrets are committed.

---

## 22. Long-Term Vision

WorksideQA should eventually answer:

- Is this release safe to deploy?
- What broke since the last release?
- Which product is least stable?
- Which workflows are slow or confusing?
- Did the AI behavior change?
- Are users likely to complete onboarding?
- Are protected pages secure?
- Did mobile push notifications work?
- Did the dashboard update after backend changes?

The platform should become a core Workside Software asset and may eventually evolve into a commercial product or internal managed QA service.

---

## 23. Immediate Next Step

The next task is to give Codex a focused implementation prompt for Phase 1 only.

Codex should build the skeleton and first runnable smoke test, not the entire platform.

Recommended next prompt title:

**WorksideQA Phase 1: Core CLI, Product Manifest, Playwright Smoke Runner, and Basic Report**
