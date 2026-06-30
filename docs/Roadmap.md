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
- [x] Add local daily engineering report output.
- [x] Add one-command local release workflow.
- [x] Ignore generated `reports/ai` artifacts.
- [ ] Expand release-suite category coverage as product credentials become available.
