# WorksideQA Status Report - 2026-06-30

## Executive Summary

WorksideQA is at `0.1.0-alpha` and has matured into a shared QA automation, reporting, dashboard, and release-advisory platform for Workside Software products.

The platform currently supports six active products:

- AnyRyde
- Merxus
- RadiusIQ
- Route Logistics
- SageSet
- Workside Support Console

The latest fresh all-product smoke run completed with `39 passed`, `4 failed`, `0 warnings`, and `0 skipped`, for `67%` readiness. The failures are concentrated in AnyRyde startup timing and RadiusIQ smoke login API readiness. Product-specific RadiusIQ workflow testing is clean, and the latest standalone AnyRyde smoke run is clean.

Generated reports continue to mask configured secrets. The latest JSON and HTML reports were checked and contained no raw configured secrets.

## Current Platform Capabilities

### Core Orchestration

- Common CLI entry point through `packages/qa-core`.
- Manifest-driven product selection.
- Single-product and all-product suite execution.
- Local dev server startup with configured working directory, command, port, health URL, and timeout.
- Dev server stdout/stderr capture into JSON/HTML report artifacts.
- Suite-level result aggregation and release readiness scoring.

### Product Manifests

- Product configuration lives under `products/<product-key>/product.manifest.json`.
- Manifests define local/staging/production URLs, dev server startup, auth strategy, API health checks, Firebase settings, accessibility, performance, visual regression, AI, mobile, personas, tags, and suites.
- Shared packages remain product-agnostic; product behavior is declared in manifests or product-owned workflow modules.

### Browser Automation

- Playwright smoke runner.
- Product-specific workflow runner.
- Generic login helper for:
  - email/password login.
  - RadiusIQ demo email code flow using local debug codes from `/api/auth/demo-email/send`.
- Screenshot capture under `screenshots/current/<product>`.
- Console error capture.
- Network failure capture.
- Product-level ignore patterns for known benign network aborts.

### Product Workflow Assertions

- RadiusIQ workflow assertions under `products/radiusiq/workflows`.
- Merxus workflow assertions under `products/merxus/workflows`.
- Generic workflow orchestration in `packages/qa-browser`.
- `qa-core` only dispatches workflow suites and does not hardcode product behavior.
- Safe screenshots only; no baselines are created for screenshots that may contain private data.

### API, Firebase, Performance, Accessibility, Security

- Manifest-driven API health checks.
- Non-destructive Firebase readiness checks.
- Performance reliability budget based on browser network failures.
- Axe accessibility checks.
- Security runner shell.
- Mobile readiness runner shell.
- Push-token readiness configuration hooks.

### AI and Release Intelligence

- Credential-gated OpenAI integration.
- AI persona evaluation runner.
- AI release review generation.
- Daily engineering report generation.
- AI bug report generation.
- Release comparison output.
- OpenAI usage is currently blocked by quota until the account resets.

### Visual Regression

- Screenshot baseline support.
- Current, baseline, and diff screenshot directories.
- Visual regression thresholds configured per product.
- Baseline updates are intentionally explicit and review-driven.

### Reporting

- HTML reports.
- JSON reports.
- JUnit reports.
- Historical report summaries.
- Report paths printed after runs.
- Secret masking for email addresses, phone numbers, API-key-like values, and configured environment secrets.

### Dashboard

- Product-centered Dashboard V2 at `dashboard/index.html`.
- Overall readiness score.
- Product cards with status, icons, category rollups, and one-line status reasons.
- Historical data ingestion from JSON report history.
- Trend charts.
- Latest-vs-previous release comparison data.
- AI review metadata when generated.

### One-Command Release Workflow

Commands now include:

- `npm run qa:release`
- `npm run qa:release:no-open`
- `npm run qa:release:dry`
- `npm run qa:release:radiusiq`
- `npm run qa:release:merxus`

The release workflow runs smoke tests, rebuilds dashboard data, runs AI release review, generates the daily engineering report, prints the final summary, and can open the dashboard automatically on Windows.

## Current Product Status

### Fresh All-Product Smoke Run

Report: `reports/json/2026-06-30T22-47-00-866Z.json`

Overall:

- Status: `FAIL`
- Passed: `39`
- Failed: `4`
- Warnings: `0`
- Skipped: `0`
- Readiness: `67%`

Product results:

| Product | Status | Notes |
|---|---:|---|
| AnyRyde | Failing in all-product run | Dev server did not become healthy at `http://127.0.0.1:3000`; browser navigation then failed with connection refused. Standalone AnyRyde smoke passed immediately before this. |
| Merxus | Passing smoke | 8 checks passed. |
| RadiusIQ | Failing smoke | Web started, but smoke login hit `http://localhost:8080/api/auth/demo-email/send` before the API was reachable. Product workflow is clean. |
| Route Logistics | Passing smoke | 8 checks passed. |
| SageSet | Passing smoke | 8 checks passed. |
| Workside Support Console | Passing smoke | 8 checks passed. |

### Standalone Product Highlights

#### AnyRyde

Latest standalone smoke:

- Report: `reports/json/2026-06-30T18-54-04-331Z.json`
- Status: `PASS`
- Result: `8 passed`, `0 failed`, `0 warnings`, `0 skipped`
- Screenshots captured: `2`
- No console errors.
- No network failures.
- No raw configured secrets found in JSON/HTML reports.

Current concern:

- AnyRyde still appears sensitive to startup timing in all-product runs. The standalone run passed, but the all-product run timed out waiting for `http://127.0.0.1:3000`.

#### RadiusIQ

Latest workflow:

- Report: `reports/json/2026-06-30T18-08-44-435Z.json`
- Status: `PASS`
- Result: `15 passed`, `0 failed`, `0 warnings`, `0 skipped`

Validated flow:

- Starts RadiusIQ API and web app locally.
- Selects `Demo email`.
- Submits seeded demo email.
- Reads local `debugCode`.
- Enters code in the UI.
- Reaches `/app`.
- Verifies dashboard, competitor, scan, and alert areas.
- Captures safe public screenshot only.

Current concern:

- The smoke suite does not wait for RadiusIQ API readiness before attempting demo email login. The workflow suite does wait for the API dependency and passes.

#### Merxus

Latest smoke:

- Passing in the all-product smoke run.

Latest release-suite result:

- Report: `reports/json/2026-06-30T18-22-51-440Z.json`
- Status: `FAIL`
- Result: `9 passed`, `4 failed`, `1 skipped`

Known release-suite issues:

- API health URL mismatch: `https://api.merxus.ai/api/health` returns `404`.
- Working endpoint observed: `https://api.merxus.ai/health`.
- Accessibility: Axe reported `button-name` and `color-contrast`.
- AI checks failed because OpenAI quota was exceeded.

Merxus AI status:

- Not currently clean.
- Failure is external quota-related, not a Merxus app assertion failure.
- Re-test after OpenAI usage resets.

#### Route Logistics

Latest all-product smoke:

- Passing.
- 8 checks passed.

#### SageSet

Latest all-product smoke:

- Passing.
- 8 checks passed.

Operational note:

- Separate SageSet product UX issues were discussed previously, but they belong to the SageSet app project, not WorksideQA. They are not part of this WorksideQA status report unless brought back into this repository as QA assertions.

#### Workside Support Console

Latest all-product smoke:

- Passing.
- 8 checks passed.

## Outstanding Action Items

### High Priority

1. Fix AnyRyde startup reliability in all-product runs.
   - Standalone smoke passes.
   - All-product smoke timed out waiting for `http://127.0.0.1:3000`.
   - Recommended fix: increase AnyRyde `healthTimeoutMs`, verify no stale process conflicts, and consider using a deterministic local port/start command if CRA startup varies.

2. Make RadiusIQ smoke wait for API readiness.
   - RadiusIQ workflow is clean because it waits for `http://localhost:8080/health`.
   - RadiusIQ smoke can fail when the web app is healthy but the API is not yet ready.
   - Recommended fix: add manifest-driven dependency health checks for browser smoke startup, or move RadiusIQ release coverage to the workflow suite where dependency readiness is already represented.

3. Correct Merxus API health URL.
   - Current expected path should be `https://api.merxus.ai/health`.
   - `https://api.merxus.ai/api/health` returns `404`.
   - Update `.env.local` and `.env.example` if needed.

4. Re-test OpenAI-backed features after quota reset.
   - `npm run qa:ai-review` currently fails due to OpenAI quota.
   - Merxus AI release checks currently fail for the same reason.

### Medium Priority

5. Fix Merxus accessibility issues.
   - Axe violations: `button-name`, `color-contrast`.
   - These should be addressed in the Merxus app, then release-suite should be rerun.

6. Validate Merxus workflow after Firebase auth/network dependencies are stable.
   - Merxus smoke is passing.
   - Product workflow previously remained on `/login` because Firebase auth calls failed with `auth/network-request-failed`.
   - Re-run `npm run qa:merxus:workflow` after confirming auth connectivity.

7. Refresh dashboard data after fixing Merxus health URL and OpenAI quota.
   - Dashboard data currently reflects recent mixed report history.
   - Once API and AI checks are corrected, run:
     - `npm run qa:release:no-open`
     - `npm run qa:dashboard:data`

8. Review generated dashboard data tracking policy.
   - `dashboard/data/*.json` and `dashboard/data/history.js` are generated but currently appear as working-tree modifications after runs.
   - Decide whether these should be tracked snapshots or ignored generated artifacts.

### Lower Priority

9. Expand release-suite category coverage.
   - Many products still have categories marked `not evaluated`.
   - Add API, accessibility, performance, visual, Firebase, and AI coverage product by product as credentials and stable assertions become available.

10. Add workflow tests beyond RadiusIQ and Merxus.
   - Candidate next products: AnyRyde and SageSet.
   - Keep workflows product-owned under `products/<product-key>/workflows`.

11. Improve page titles where generic titles remain.
   - AnyRyde currently reports `React App`.
   - Product-specific titles improve report readability and smoke-test signal.

## Recommendations for System Improvements

### 1. Add Manifest-Driven Service Dependencies

Add a `dependencies` or `requiredServices` block to product manifests, for example:

```json
{
  "requiredServices": [
    {
      "name": "api",
      "healthUrl": "http://localhost:8080/health",
      "timeoutMs": 60000
    }
  ]
}
```

Then have smoke and workflow runners wait for those dependencies before login. This would prevent the RadiusIQ smoke race where the web server is healthy but the API is not.

### 2. Separate Browser Smoke From Auth Workflow

Use smoke for:

- app loads
- title exists
- public route opens
- console/network sanity

Use workflow for:

- login
- dashboard assertions
- deeper product navigation
- safe screenshots

This would reduce false failures in smoke while preserving deeper product confidence in workflow suites.

### 3. Make AI Quota Failures Non-Catastrophic for Local Release

AI checks should still fail when required, but the local release workflow could distinguish:

- product regression
- external provider quota
- missing credentials
- skipped by policy

Recommendation:

- Add an `external-blocked` or `warning` mode for OpenAI quota errors in local release review.
- Keep CI/release gates stricter if desired.

### 4. Add a No-AI Release Command

Add:

```bash
npm run qa:release:no-ai
```

This would allow a complete local product-health pass when OpenAI quota is exhausted.

### 5. Normalize API Health URLs

Add a small utility command:

```bash
npm run qa:env:health
```

It should validate every configured `*_API_HEALTH_URL` and print status codes without secrets.

### 6. Add Product Workflow Maturity Levels

Track each product by workflow maturity:

- Level 0: manifest only
- Level 1: smoke
- Level 2: login
- Level 3: dashboard assertions
- Level 4: product workflow areas
- Level 5: API/Firebase/accessibility/performance/visual/AI release coverage

This would make roadmap progress clearer than pass/fail alone.

### 7. Add Safe Screenshot Classification

Each screenshot artifact could include a privacy classification:

- `public`
- `masked`
- `private`
- `do-not-baseline`

This would formalize the current rule that screenshots containing emails, tokens, customer names, phone numbers, transcripts, or private data must not become baselines.

### 8. Improve Dashboard Actionability

Recommended dashboard additions:

- Product-specific next action.
- External dependency failures grouped separately.
- Workflow maturity level.
- Last clean run timestamp.
- Last failure cause.
- Release blocking vs informational flags.

### 9. Add Report Retention Controls

Generated reports and screenshots will grow quickly. Add configurable retention:

- keep last N HTML/JSON/JUnit reports.
- keep last N screenshots per product.
- preserve explicitly pinned baselines.

### 10. Add CI Readiness Profile

Create a stricter CI profile separate from local development:

- deterministic headless runs.
- no dashboard auto-open.
- no private screenshot baselines.
- explicit environment validation.
- controlled AI behavior.

## Recommended Next Execution Plan

1. Update Merxus health URL to `https://api.merxus.ai/health`.
2. Re-run Merxus release without AI, or wait for OpenAI reset and run full Merxus release.
3. Add service dependency readiness for RadiusIQ API before smoke login.
4. Increase or tune AnyRyde startup health timeout for all-product runs.
5. Re-run:

```bash
node packages/qa-core/src/cli.js --all --suite smoke --start-server
npm run qa:radiusiq:workflow
npm run qa:merxus:workflow
npm run qa:release:no-open
```

6. Refresh dashboard data and AI release review after OpenAI quota resets.

## Current Command Reference

Primary commands:

```bash
npm run qa:radiusiq
npm run qa:merxus
npm run qa:sageset
npm run qa:all
npm run qa:radiusiq:workflow
npm run qa:merxus:workflow
npm run qa:workflows
npm run qa:release
npm run qa:release:no-open
npm run qa:release:dry
npm run qa:release:radiusiq
npm run qa:release:merxus
npm run qa:dashboard:data
npm run qa:ai-review
npm run qa:bug-report
npm run qa:report
npm run qa:env
```

Direct CLI examples:

```bash
node packages/qa-core/src/cli.js --product radiusiq --suite smoke --start-server
node packages/qa-core/src/cli.js --product radiusiq --suite workflow --start-server
node packages/qa-core/src/cli.js --product merxus --suite release --start-server
node packages/qa-core/src/cli.js --all --suite smoke --start-server
```

## Bottom Line

WorksideQA is functional as a shared QA platform and has strong foundations: manifests, smoke tests, product workflows, reporting, dashboarding, AI review, visual support, release orchestration, and secret-safe artifacts.

The platform is ready for continued expansion, but the current release picture is not fully clean until these items are addressed:

- AnyRyde all-product startup timing.
- RadiusIQ smoke API readiness race.
- Merxus API health URL correction.
- Merxus accessibility fixes.
- OpenAI quota reset/re-test.

Once those are cleared, WorksideQA should return to a clean six-product local release baseline.
