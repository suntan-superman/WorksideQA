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

## Commands

```bash
npm install
npm run qa:radiusiq
npm run qa:radiusiq:dry
npm run qa:all:dry
node packages/qa-core/src/cli.js --product radiusiq --suite smoke
npm run qa:dashboard:data
npm run qa:ai-review
npm run qa:bug-report
npm run qa:report
```

Use `--start-server` when you want WorksideQA to start the product's configured local dev server before browser checks.

```bash
node packages/qa-core/src/cli.js --product radiusiq --suite smoke --start-server
```

Use `--update-baselines` after reviewing a clean screenshot to create missing visual regression baselines.

```bash
node packages/qa-core/src/cli.js --product radiusiq --suite smoke --start-server --update-baselines
```

## Local Secrets

Copy `.env.example` to `.env.local` and fill only the demo credentials needed for a local run. Reports mask email addresses, phone numbers, and common API-key formats.

Optional checks are credential-gated:

- `OPENAI_API_KEY` enables live AI persona evaluations.
- `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_SERVICE_ACCOUNT_JSON`, or `FIREBASE_ACCESS_TOKEN` enables read-only Firebase checks.
- Product API health URLs use `*_API_HEALTH_URL` environment variables.
- Mobile push checks use product-specific `*_PUSH_TEST_TOKEN` variables.

## Product Manifests

Each product lives under `products/<product-key>/product.manifest.json`. Shared QA packages must stay product-agnostic; product URLs, credentials, Firebase projects, API endpoints, personas, and suites belong in manifests.

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
node packages/qa-core/src/cli.js --all --suite smoke --start-server

npm run qa:dashboard:data
npm run qa:ai-review

Open dashboard: dashboard/index.html
////////////////////////////////////////////////////////////////

## Versioning

The WorksideQA platform version is stored in `package.json`, displayed in the dashboard, and written into JSON, HTML, dashboard, and AI release review outputs. See `docs/VERSIONING.md`.
//////////////////////////////////////////////////////////////
WorksideQA Platform v0.1.0-alpha

The unified quality assurance, release readiness, and AI-assisted testing platform for all Workside Software applications.

