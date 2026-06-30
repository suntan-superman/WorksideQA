You are working in the WorksideQA repository.

Goal:
Implement Dashboard V2, app versioning, and AI Release Review for the WorksideQA Platform.

Do not rewrite the whole project. Build on the existing architecture.

Core requirements:

1. App Versioning
- Add a clear WorksideQA platform version.
- Start at v0.1.0-alpha.
- Store version in package.json.
- Display version in dashboard header.
- Include version in every JSON and HTML report.
- Include version in AI release review output.
- Add docs/VERSIONING.md explaining:
  - alpha/beta/stable versioning
  - when to bump patch/minor/major
  - how releases are tagged

2. Dashboard V2
Replace the current dashboard homepage with a product-centered view.

Dashboard should show:
- WorksideQA Platform name
- Version number
- Last dashboard data refresh timestamp
- Overall company readiness score
- Product status cards for:
  - RadiusIQ
  - Merxus
  - SageSet
  - Support Console
  - Route Logistics
  - AnyRyde

Each product card should show:
- Product name
- Latest run status
- Latest readiness score
- Last successful clean run
- Failed checks count
- Warning count
- Last run timestamp
- Link or button to view latest report if available

Important:
The homepage should not only reflect the latest global run. It should aggregate latest status per product.

3. Product Detail View
Create product-level sections or pages.

For each product show:
- Smoke test status
- Browser status
- API status
- Firebase status
- Accessibility status
- Performance status
- Security status
- AI status
- Visual regression status
- Recent runs table
- Latest screenshots if available
- Latest report links

Keep it static/local for now. Do not introduce a backend server unless absolutely necessary.

4. Dashboard Data Model
Update dashboard ingestion so it produces a normalized dashboard data file.

Suggested output:
dashboard/data/dashboard-summary.json

It should include:
- platformVersion
- generatedAt
- overallReadiness
- products[]
- recentRuns[]

Each product object should include:
- productKey
- productName
- latestStatus
- latestReadiness
- latestRunStartedAt
- lastCleanRunStartedAt
- failedChecks
- warningChecks
- skippedChecks
- reportLinks
- categoryScores
- latestArtifacts

5. AI Release Review
Add an AI review generator that reads recent report history and produces a concise executive QA summary.

Command:
npm run qa:ai-review

or:
node packages/qa-core/src/cli.js --ai-review

The AI review should:
- Use OPENAI_API_KEY or OPENAI_KEY from .env.local
- Be credential-gated
- Never send secrets to the model
- Read sanitized JSON reports only
- Summarize:
  - current release readiness
  - products that are clean
  - products that are failing
  - major regressions
  - warnings
  - recommended next actions
  - deploy/no-deploy recommendation

Output files:
reports/ai/latest-release-review.md
reports/ai/latest-release-review.json

Dashboard should display the latest AI review summary if available.

6. AI Review Safety
Before sending data to OpenAI:
- Strip emails
- Strip phone numbers
- Strip API keys
- Strip tokens
- Strip URLs with sensitive query strings
- Strip environment variable values
- Do not include screenshot image data
- Do not include raw console output unless sanitized

Add a clear sanitizer utility if one does not already exist.

7. Release Readiness Scoring
Improve scoring so it is category-based.

Suggested weights:
- Browser / smoke reliability: 25%
- API health: 15%
- Firebase readiness: 15%
- Accessibility: 10%
- Performance: 10%
- Security: 10%
- Visual regression: 10%
- AI checks: 5%

If a category is unavailable or credential-gated, mark it as “not evaluated” instead of failing the product.

Dashboard should show:
- Overall readiness
- Product readiness
- Category readiness

8. Visual Design
Keep design simple, clean, and local-file friendly.

No heavy UI framework.
No external CDN dependencies.
Use plain HTML/CSS/JS unless the existing dashboard already uses another approach.

Dashboard layout:
- Header
- Summary cards
- Product cards
- Trend chart
- Recent runs table
- AI review panel
- Framework coverage / next steps

9. Reports and History
Do not break existing report generation.

Existing outputs must continue:
- reports/html
- reports/json
- reports/junit
- reports/history

Additive changes only.

10. Git Hygiene
Ensure generated artifacts remain ignored:
- reports/html
- reports/json
- reports/junit
- reports/history
- reports/ai
- screenshots/current
- screenshots/diff

Do not commit .env.local.
Do not commit secrets.
Do not commit private screenshots.

11. Acceptance Criteria
Implementation is complete when:

- npm install succeeds
- npm run qa:radiusiq passes
- npm run qa:dashboard:data generates dashboard-summary.json
- dashboard/index.html displays Dashboard V2
- package/version appears in dashboard and reports
- npm run qa:ai-review works when OPENAI key exists
- AI review gracefully skips when no OPENAI key exists
- no raw secrets appear in generated reports
- RadiusIQ and Merxus still show clean smoke status
- Dashboard shows latest per-product status, not only latest global run

12. Do Not Do
- Do not add paid services.
- Do not require a hosted backend.
- Do not add Appium.
- Do not add Android emulator requirements.
- Do not move product-specific logic into shared packages.
- Do not hardcode RadiusIQ or Merxus logic inside qa-core.
- Do not expose credentials in reports, screenshots, dashboard data, or AI prompts.

Implementation order:
1. Add versioning.
2. Normalize dashboard data model.
3. Build Dashboard V2 UI.
4. Improve readiness scoring.
5. Add AI Release Review.
6. Update README and Roadmap.
7. Run validation commands.
8. Report results and any remaining issues.