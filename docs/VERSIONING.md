# WorksideQA Versioning

WorksideQA uses semantic versioning with prerelease labels while the platform is still maturing across all Workside Software products.

Current platform version: `0.1.0-alpha`

## Release Channels

- `alpha`: Internal platform development. APIs, manifests, dashboard data, and report shapes may still change.
- `beta`: Feature-complete enough for regular product release checks, with only low-risk report or dashboard changes expected.
- `stable`: Production release gate for Workside products. Breaking changes require a major version bump and migration notes.

## Version Bumps

- Patch: bug fixes, report masking fixes, dashboard display fixes, manifest validation improvements, and non-breaking runner behavior changes.
- Minor: new QA capability, new report field, new dashboard panel, new product template field, or additive CLI command.
- Major: breaking manifest schema changes, removed report fields, changed CLI defaults that affect automation, or incompatible dashboard data changes.

Prerelease versions use this pattern:

```text
<major>.<minor>.<patch>-alpha
<major>.<minor>.<patch>-beta
<major>.<minor>.<patch>
```

## Release Tags

Releases are tagged from the repository root:

```bash
git tag v0.1.0-alpha
git push origin v0.1.0-alpha
```

Each release should include:

- `package.json` version update.
- `package-lock.json` version update.
- Dashboard and report version verification.
- A clean smoke status for baseline products.
- Notes for any products that remain credential-gated or not evaluated.
