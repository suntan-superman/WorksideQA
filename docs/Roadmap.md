Phase 1
☑ qa-core CLI skeleton
☑ qa-browser Playwright smoke runner
☑ configuration loader
☑ product manifest schema reference
☑ HTML reporting
☑ JSON reporting
☑ JUnit reporting
☑ historical run summaries
☑ `.gitignore` and `.env.example`
☑ RadiusIQ manifest
☑ multi-product manifests

Phase 2
☑ Firebase non-destructive readiness runner
☑ API health check runner
☑ Performance reliability budget runner
☑ Accessibility readiness runner
☑ Firebase read-only service-account adapter
☑ Product-specific API endpoint registration
☑ Axe-core integration

Phase 3
☑ Mobile runner shell
☑ Maestro availability detection
☑ Push notification readiness checks
☑ Product-specific Maestro flow registration

Phase 4
☑ AI persona prompt library
☑ AI evaluation runner shell
☑ Visual regression
☑ AI bug reports
☑ Credential-gated live model evaluation

Phase 5
☑ Local dashboard shell
☑ Release readiness score in reports
☑ Historical trend data files
☑ Dashboard ingestion from report history
☑ Trend table
☑ Trend charts
# Dashboard V2 Progress

- [x] Add WorksideQA platform version `0.1.0-alpha`.
- [x] Include platform version in JSON and HTML reports.
- [x] Generate normalized `dashboard/data/dashboard-summary.json`.
- [x] Replace dashboard homepage with product-centered Dashboard V2.
- [x] Add category-based readiness scoring.
- [x] Add credential-gated AI release review command and outputs.
- [x] Add product card icons, status coloring, and one-line status reasons.
- [x] Add category rollups for reliability, performance, security, accessibility, visual, and AI.
- [x] Add latest-vs-previous release comparison data.
- [x] Add workflow maturity, startup trend, and release advisor data.
- [x] Add local daily engineering report output.
- [x] Add one-command local release workflow.
- [x] Ignore generated `reports/ai` artifacts.
- [ ] Expand release-suite category coverage as product credentials become available.

# Phase 6 Product Workflow Assertions

- [x] Add generic browser workflow runner in `packages/qa-browser`.
- [x] Add RadiusIQ product workflow assertions.
- [x] Add Merxus product workflow assertions.
- [x] Add `qa:radiusiq:workflow`, `qa:merxus:workflow`, and `qa:workflows` commands.
- [x] Keep workflow behavior product-owned and manifest-driven.
- [ ] Validate RadiusIQ and Merxus workflow suites as clean after real demo auth dependencies are reachable.
- [x] Add first-pass workflow coverage for SageSet.
- [x] Add first-pass workflow coverage for Route Logistics.
- [x] Add first-pass workflow coverage for Support Console.
- [x] Add first-pass workflow coverage for AnyRyde.
- [ ] Validate all six workflow suites as clean after local product dependencies are reachable.
- [ ] Expand product workflows after additional safe non-private assertions are identified.

# Phase 7 Platform Maturity

- [x] Add `npm run qa:env:health`.
- [x] Add manifest-derived dependency graph validation for web, API, Firebase, OpenAI, auth, and push-token prerequisites.
- [x] Run suite-aware preflight checks before product tests begin.
- [x] Add workflow commands for SageSet, Route Logistics, Support Console, and AnyRyde.
- [x] Expand Dashboard V3 data with workflow maturity, timelines, failure explanations, startup trends, category scorecards, and release comparison.
- [x] Add deterministic Intelligent Release Advisor with deploy, hold, or investigate recommendation.
- [x] Keep AI release prose optional so quota or service errors do not break the local release workflow.
- [x] Add local safety gate command for secret scanning and generated artifact validation.
- [x] Add CI-safe local profile and GitHub Actions workflow.
- [x] Add executive engineering email draft generation.
- [x] Add credential-gated executive engineering email delivery support.
- [ ] Configure production email provider credentials when ready to send reports externally.
