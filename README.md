# WorksideQA

Shared QA automation platform for Workside Software products.

## Current Capabilities

- Product manifest loading and validation.
- Playwright smoke runner for web products.
- Screenshot capture under `screenshots/current/<product>`.
- Console error and network failure capture.
- Manifest-driven API health check runner.
- Non-destructive Firebase readiness checks.
- Performance, Axe accessibility, security, AI, visual regression, and mobile runner support.
- HTML, JSON, JUnit, and historical report output with platform version metadata.
- Product-centered Dashboard V2 at `dashboard/index.html`.
- Credential-gated AI release review output.
- Release comparison and daily engineering report generation.
- Product-specific workflow assertions for all six active products.
- Environment health validation with product dependency graphs.
- Deterministic Release Advisor with deploy, hold, or investigate recommendation.
- Local safety gate for secret scanning and generated artifact checks.
- CI-safe profile for platform validation without launching product apps.
- Executive engineering email draft generation and credential-gated SendGrid delivery.

## Commands

```bash
npm install
npm run qa:radiusiq
npm run qa:radiusiq:workflow
npm run qa:merxus:workflow
npm run qa:sageset:workflow
npm run qa:route-logistics:workflow
npm run qa:support-console:workflow
npm run qa:anyryde:workflow
npm run qa:workflows
npm run qa:radiusiq:dry
npm run qa:all:dry
npm run qa:env:health
npm run qa:env:health:offline
npm run qa:safety:gate
npm run qa:ci
npm run qa:release
npm run qa:release:no-open
npm run qa:release:dry
npm run qa:release:radiusiq
npm run qa:release:merxus
node packages/qa-core/src/cli.js --product radiusiq --suite smoke
npm run qa:dashboard:data
npm run qa:ai-review
npm run qa:executive-email
npm run qa:executive-email:send
npm run qa:bug-report
npm run qa:report
```

Use `--start-server` when you want WorksideQA to start the product's configured local dev server before browser checks.

```bash
node packages/qa-core/src/cli.js --product radiusiq --suite smoke --start-server
```

Use workflow commands for product-specific happy-path assertions that go deeper than smoke tests while keeping shared packages product-agnostic.

```bash
npm run qa:radiusiq:workflow
npm run qa:merxus:workflow
npm run qa:sageset:workflow
npm run qa:route-logistics:workflow
npm run qa:support-console:workflow
npm run qa:anyryde:workflow
npm run qa:workflows
```

Use `npm run qa:env:health` before a release run to validate local prerequisites, manifest dependency graphs, demo credential presence, API health URLs, Firebase credentials, OpenAI configuration, and push-token readiness without printing secret values. The command exits non-zero only for required dependencies: demo credentials, required API health URLs, and required local service health. Firebase read-only credentials, push notification test tokens, and OpenAI credentials are warnings unless explicitly required.

```bash
npm run qa:env:health
npm run qa:env:health -- --product radiusiq
npm run qa:env:health -- --require-ai
npm run qa:env:health:offline
```

Use `--update-baselines` after reviewing a clean screenshot to create missing visual regression baselines.

```bash
node packages/qa-core/src/cli.js --product radiusiq --suite smoke --start-server --update-baselines
```

Use `npm run qa:release` for the local release workflow. It runs smoke tests, rebuilds dashboard data, generates the AI release review and daily engineering report, prints the release summary, and opens `dashboard/index.html` automatically on Windows.

```bash
npm run qa:release
npm run qa:release:no-open
npm run qa:release:dry
npm run qa:release:radiusiq
npm run qa:release:merxus
```

Use `npm run qa:ci` for CI-safe platform validation. It runs the safety gate, offline environment health, smoke/workflow dry runs, dashboard data generation, and the deterministic Release Advisor without starting product dev servers.

## Local Secrets

Copy `.env.example` to `.env.local` and fill only the demo credentials needed for a local run. Reports mask email addresses, phone numbers, and common API-key formats.

Optional checks are credential-gated:

- `OPENAI_API_KEY` enables live AI persona evaluations.
- `WORKSIDEQA_FIREBASE_CREDENTIALS_DIR`, `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_SERVICE_ACCOUNT_JSON`, or `FIREBASE_ACCESS_TOKEN` enables read-only Firebase checks.
- Product-specific Firebase service account files are resolved from `WORKSIDEQA_FIREBASE_CREDENTIALS_DIR` using each manifest's `firebase.credentialFile`.
- Product API health URLs use `*_API_HEALTH_URL` environment variables.
- Mobile push checks use product-specific `*_PUSH_TEST_TOKEN` variables.
- Executive email delivery uses `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, optional `SENDGRID_FROM_NAME`, and `WORKSIDEQA_EXECUTIVE_EMAIL_TO`. `WORKSIDEQA_EMAIL_PROVIDER=sendgrid` is optional when a SendGrid key is present.

## Product Manifests

Each product lives under `products/<product-key>/product.manifest.json`. Shared QA packages must stay product-agnostic; product URLs, credentials, Firebase projects, API endpoints, personas, and suites belong in manifests.

Product-specific workflow modules live under `products/<product-key>/workflows`. Shared browser helpers live in `packages/qa-browser`; `qa-core` only orchestrates suites.

## Reports

Generated reports are intentionally ignored by Git:

- `reports/html`
- `reports/json`
- `reports/junit`
- `reports/history`
- `reports/ai`
- `screenshots/current`
- `screenshots/diff`

/////////////////////////////////////////////////////////////////
npm run qa:release
Open dashboard: dashboard/index.html
////////////////////////////////////////////////////////////////

## Versioning

The WorksideQA platform version is stored in `package.json`, displayed in the dashboard, and written into JSON, HTML, dashboard, and AI release review outputs. See `docs/VERSIONING.md`.

## Intelligent Release Advisor

`npm run qa:dashboard:data` builds:

- `dashboard/data/dashboard-summary.json`
- `dashboard/data/release-comparison.json`

Dashboard data includes workflow maturity, product timelines, category scorecards, failure explanations, startup trend samples, release comparison, and the deterministic Release Advisor.

`npm run qa:ai-review` builds:

- `reports/ai/latest-release-review.md`
- `reports/ai/latest-release-review.json`
- `reports/ai/latest-release-comparison.json`
- `reports/ai/latest-release-advisor.json`
- `reports/ai/daily-engineering-report.md`
- `reports/ai/daily-engineering-report.json`
- `reports/ai/executive-engineering-email.md`
- `reports/ai/executive-engineering-email.json`
- `reports/ai/executive-engineering-email.eml`

The Release Advisor is deterministic and still runs when OpenAI prose generation is unavailable. AI-generated review text is credential-gated and never receives raw secrets.

`npm run qa:executive-email` always writes a local draft. `npm run qa:executive-email:send` sends only when the SendGrid provider variables and recipient are configured; otherwise it reports delivery as skipped and leaves the draft in `reports/ai`.
//////////////////////////////////////////////////////////////
WorksideQA Platform v0.1.0-alpha

The unified quality assurance, release readiness, and AI-assisted testing platform for all Workside Software applications.
/////////////////////////////////////////////////////////////
npm run qa:release
npm run qa:release:no-open
npm run qa:release:dry
npm run qa:release:radiusiq
npm run qa:release:merxus
////////////////////////////////////////////////////////////
