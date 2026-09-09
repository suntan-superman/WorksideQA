# WorksideQA Status Report - 2026-07-03

Generated from the current WorksideQA repository state, roadmap, README, product manifests, and latest available local report artifacts.

## Executive Summary

WorksideQA is in a strong `0.1.0-alpha` state. The platform has moved beyond a simple smoke-test runner into a multi-product QA platform with product manifests, browser automation, HTML/JSON/JUnit reporting, historical dashboard data, AI release review, visual checks, and product-specific workflow assertions.

The major platform foundation is complete. RadiusIQ and Merxus have deeper workflow coverage, and all six Workside products are represented by manifests. The remaining work is mostly reliability hardening, expanding workflow depth across the remaining products, and improving release intelligence.

## Current Product Coverage

- [x] RadiusIQ is configured with smoke, workflow, regression, and release suite support.
- [x] Merxus is configured with smoke, workflow, regression, and release suite support.
- [x] SageSet is configured for local smoke coverage.
- [x] Support Console is configured for local smoke coverage.
- [x] Route Logistics is configured for local smoke coverage.
- [x] AnyRyde is configured for local smoke, regression, and release coverage.
- [x] Product manifests are the source of truth for product paths, commands, ports, routes, and suite behavior.
- [x] Shared packages remain product-agnostic.

## What Has Been Done

### Platform Architecture

- [x] Created a modular package-based WorksideQA architecture.
- [x] Separated product-owned configuration from shared QA framework logic.
- [x] Added manifest-driven product discovery and validation.
- [x] Established `qa-core` as the orchestration layer.
- [x] Established `qa-browser` for reusable Playwright/browser helpers.
- [x] Preserved product-specific behavior under product folders.
- [x] Added environment-based configuration through `.env.local` and `.env.example`.
- [x] Protected local credentials and generated artifacts from source control.

### Core CLI and Orchestration

- [x] Added CLI support for individual product runs.
- [x] Added CLI support for all-product runs.
- [x] Added suite selection.
- [x] Added dry-run support.
- [x] Added optional dev-server startup with `--start-server`.
- [x] Added local dev command handling from product manifests.
- [x] Added health checking for started dev servers.
- [x] Added child process output capture for troubleshooting.
- [x] Added secret masking in command output and reports.
- [x] Added one-command release orchestration through `npm run qa:release`.

### Browser QA

- [x] Added browser smoke-test execution.
- [x] Added login flow support using environment-provided demo credentials.
- [x] Added screenshot capture.
- [x] Added console error capture.
- [x] Added network failure capture.
- [x] Added page title checks.
- [x] Added route and selector checks.
- [x] Added safe screenshot handling rules.
- [x] Added protection against creating baselines from screenshots containing private data.

### Product Workflow Assertions

- [x] Added RadiusIQ workflow command: `npm run qa:radiusiq:workflow`.
- [x] Added Merxus workflow command: `npm run qa:merxus:workflow`.
- [x] Added combined workflow command: `npm run qa:workflows`.
- [x] Added RadiusIQ workflow coverage for login, dashboard load, dashboard markers, and key areas.
- [x] Added Merxus workflow coverage for login, dashboard load, tenant/call/transcript/lead areas, and serious console errors.
- [x] Kept workflow assertions product-owned rather than hardcoded into `qa-core`.
- [ ] Expand workflow assertions to SageSet.
- [ ] Expand workflow assertions to AnyRyde.
- [ ] Expand workflow assertions to Route Logistics.
- [ ] Expand workflow assertions to Support Console.

### Reporting

- [x] Added HTML reports.
- [x] Added JSON reports.
- [x] Added JUnit reports.
- [x] Added historical report data.
- [x] Added version metadata to reports.
- [x] Added pass/fail/warning/skipped counts.
- [x] Added product-level result summaries.
- [x] Added captured console and network findings.
- [x] Added report secret masking.
- [x] Added screenshot references.
- [x] Added release comparison support.
- [x] Added daily engineering report generation.

### Dashboard

- [x] Added dashboard data generation.
- [x] Added Dashboard V2 readiness view.
- [x] Added clean/failing product counts.
- [x] Added product card summaries.
- [x] Added historical result visibility.
- [x] Added release-oriented summaries.
- [x] Added workflow results to dashboard data.
- [ ] Expand dashboard category coverage for reliability, performance, security, accessibility, visual, and AI scoring.
- [ ] Add stronger product card visual status treatment.
- [ ] Add "why this status" explanations to each product card.
- [ ] Add product-level timeline views for release events.

### AI and Release Intelligence

- [x] Added AI review command.
- [x] Added AI release review as part of release workflow.
- [x] Added daily engineering report generation.
- [x] Added release advisor direction in roadmap.
- [x] Added failure inclusion for workflow results.
- [x] Added masking to avoid exposing raw credentials or secrets.
- [ ] Re-run AI-heavy checks after OpenAI quota reset.
- [ ] Add an optional `qa:release:no-ai` command for quota-limited days.
- [ ] Add stronger release risk scoring.
- [ ] Add executive summary email delivery.

### API, Firebase, Performance, Accessibility, Security, and Mobile

- [x] Added manifest-driven API health checks.
- [x] Added Firebase readiness checks.
- [x] Added performance checks.
- [x] Added axe accessibility checks.
- [x] Added basic security checks.
- [x] Added mobile runner support.
- [ ] Harden API readiness when a product has both web and API dev servers.
- [ ] Add explicit required-service startup dependencies to manifests.
- [ ] Add clearer local dependency diagnostics before browser login begins.

### Visual Regression

- [x] Added visual screenshot capture.
- [x] Added visual baseline support.
- [x] Added visual diff checks.
- [x] Added rules to avoid baselining screenshots with emails, tokens, customer names, phone numbers, transcripts, or private data.
- [ ] Add automatic privacy classification for screenshots before baseline creation.
- [ ] Add clearer review queue for screenshots that need human approval.

## Latest Known Test Status

The newest all-product JSON artifact found locally is:

`reports/json/2026-06-30T22-47-00-866Z.json`

Latest all-product smoke result:

- Status: FAIL
- Passed: 39
- Failed: 4
- Warnings: 0
- Skipped: 0
- Readiness score: 67

Known failures in that artifact:

- [ ] AnyRyde dev server health did not pass at `http://127.0.0.1:3000`.
- [ ] AnyRyde browser navigation failed because the local app was not reachable.
- [ ] RadiusIQ reported a console error against `/api/auth/demo-email/send`.
- [ ] RadiusIQ reported a network failure against `/api/auth/demo-email/send`.

Additional known product-specific status:

- [x] RadiusIQ workflow previously passed with 15 passing checks.
- [x] AnyRyde standalone smoke previously passed with 8 passing checks.
- [x] Merxus smoke coverage has been clean in recent runs.
- [x] Route Logistics smoke coverage has been clean in recent runs.
- [x] SageSet smoke coverage has been clean in recent runs.
- [x] Support Console smoke coverage has been clean in recent runs.
- [ ] Merxus release/AI checks need re-validation after OpenAI quota reset.
- [ ] Merxus API health URL should use the confirmed endpoint rather than the previously failing path.

## Remaining Work Checklist

### Immediate

- [ ] Re-run all-product smoke with `--start-server` after AnyRyde demo login updates.
- [ ] Re-run RadiusIQ workflow with both RadiusIQ web and API services available.
- [ ] Add or confirm RadiusIQ API readiness before demo email login attempts.
- [ ] Update Merxus API health check to the confirmed working endpoint.
- [ ] Re-run Merxus release checks after OpenAI usage resets.
- [ ] Confirm Merxus AI checks no longer fail due quota exhaustion.
- [ ] Confirm all generated HTML and JSON reports continue to mask credentials.
- [ ] Confirm no screenshots containing private data are baselined.

### Short Term

- [ ] Add manifest support for required local services, such as separate API and web dev servers.
- [ ] Add preflight dependency checks for products that require API, Firebase, or external AI availability.
- [ ] Add `npm run qa:release:no-ai` for local release runs when AI quota is unavailable.
- [ ] Add `npm run qa:env:health` to validate configured URLs, ports, env vars, and external dependencies.
- [ ] Improve AnyRyde startup detection so the smoke runner waits for the actual reachable local app.
- [ ] Fix or document Merxus accessibility issues if still present after the next release run.
- [ ] Refresh dashboard data after the next clean all-product run.
- [ ] Refresh AI release review after the next clean all-product run.

### Medium Term

- [ ] Add deeper workflow assertions for AnyRyde.
- [ ] Add deeper workflow assertions for SageSet.
- [ ] Add deeper workflow assertions for Route Logistics.
- [ ] Add deeper workflow assertions for Support Console.
- [ ] Add product-specific workflow maturity levels to the dashboard.
- [ ] Add release timeline view per product.
- [ ] Add product card status colors and product icons.
- [ ] Add one-sentence failure explanations on dashboard product cards.
- [ ] Add category scoring for reliability, performance, security, accessibility, visual, and AI.
- [ ] Add automatic screenshot privacy classification.
- [ ] Add report retention and cleanup policy.

### Longer Term

- [ ] Add CI profile for non-local release checks.
- [ ] Add deployment recommendation output: deploy, hold, or investigate.
- [ ] Add executive-friendly daily engineering email.
- [ ] Add comparison against the previous release by product and category.
- [ ] Add trend analysis for startup time, console errors, accessibility, and performance.
- [ ] Add external dependency classification for failures caused by OpenAI, Firebase, APIs, or local service availability.
- [ ] Add product owner summary sections to generated reports.

## Recommended Next Run Sequence

```powershell
node packages/qa-core/src/cli.js --product anyryde --suite smoke --start-server
npm run qa:radiusiq:workflow
npm run qa:merxus:workflow
node packages/qa-core/src/cli.js --all --suite smoke --start-server
npm run qa:release:no-open
npm run qa:dashboard:data
```

## Bottom Line

- [x] WorksideQA has a working multi-product QA platform foundation.
- [x] The product manifest model is working.
- [x] Release orchestration exists.
- [x] Dashboard and AI reporting exist.
- [x] RadiusIQ and Merxus have first-pass workflow assertions.
- [ ] The latest all-product run is not yet clean.
- [ ] Remaining work is centered on service readiness, AI quota re-validation, workflow expansion, and richer release intelligence.

