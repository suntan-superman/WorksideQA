# Merxus Review Canary QA Evidence

- Created: 2026-08-11T22:19:33.274Z
- Environment: staging
- Suite: smoke
- Mode: execute
- Provider writes: disabled
- External notifications: disabled
- Exit code: 1

## Scenarios

| Scenario | Run ID | Status | Assertions | Cleanup |
|---|---|---|---:|---|
| google-duplicate-poll | review-qa-20260811221845-ed5e38 | passed | 32/32 | deleted 4 |
| google-existing-reply | review-qa-20260811221853-ae8fc4 | passed | 15/15 | deleted 2 |
| google-negative-new | review-qa-20260811221856-3067be | passed | 17/17 | deleted 3 |
| google-positive-new | review-qa-20260811221859-e0dc95 | passed | 16/16 | deleted 2 |
| provider-401 | review-qa-20260811221901-50fe77 | passed | 13/13 | deleted 2 |
| provider-429 | review-qa-20260811221904-3bbe0e | failed | 11/12 | deleted 1 |
| tenant-isolation | review-qa-20260811221906-91f8dc | failed | 30/31 | deleted 8 |

Live certification was not performed by this deterministic canary run.
