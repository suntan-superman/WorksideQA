# Merxus Review Canary QA Evidence

- Created: 2026-08-11T22:25:41.126Z
- Environment: staging
- Suite: full
- Mode: execute
- Provider writes: disabled
- External notifications: disabled
- Exit code: 0

## Scenarios

| Scenario | Run ID | Status | Assertions | Cleanup |
|---|---|---|---:|---|
| google-duplicate-poll | review-qa-20260811222314-ae25dc | passed | 32/32 | deleted 4 |
| google-edited-review | review-qa-20260811222323-f61618 | passed | 28/28 | deleted 3 |
| google-empty-page | review-qa-20260811222327-4639a8 | passed | 11/11 | deleted 1 |
| google-existing-reply | review-qa-20260811222329-b827a9 | passed | 15/15 | deleted 2 |
| google-missing-reviewer | review-qa-20260811222331-5c8474 | passed | 14/14 | deleted 2 |
| google-negative-new | review-qa-20260811222333-a23746 | passed | 17/17 | deleted 3 |
| google-negative-spike | review-qa-20260811222336-926f89 | passed | 19/19 | deleted 8 |
| google-neutral-new | review-qa-20260811222340-7c427d | passed | 14/14 | deleted 2 |
| google-pagination | review-qa-20260811222342-c3bd8e | passed | 15/15 | deleted 3 |
| google-positive-new | review-qa-20260811222344-1f4dc1 | passed | 16/16 | deleted 2 |
| google-rating-change-negative | review-qa-20260811222346-baaf08 | passed | 31/31 | deleted 4 |
| google-rating-only | review-qa-20260811222351-dc4deb | passed | 14/14 | deleted 2 |
| google-removed-retained | review-qa-20260811222354-2a2672 | passed | 28/28 | deleted 3 |
| google-reply-added | review-qa-20260811222357-685799 | passed | 30/30 | deleted 3 |
| google-two-star-new | review-qa-20260811222401-919cd0 | passed | 15/15 | deleted 3 |
| provider-401 | review-qa-20260811222404-39f206 | passed | 13/13 | deleted 2 |
| provider-403 | review-qa-20260811222406-62b3b0 | passed | 11/11 | deleted 2 |
| provider-404 | review-qa-20260811222408-cd62af | passed | 11/11 | deleted 2 |
| provider-429 | review-qa-20260811222411-902855 | passed | 13/13 | deleted 2 |
| provider-500 | review-qa-20260811222413-563ae1 | passed | 13/13 | deleted 2 |
| provider-malformed | review-qa-20260811222415-ed2862 | passed | 10/10 | deleted 2 |
| provider-refresh-failure | review-qa-20260811222417-426b46 | passed | 11/11 | deleted 2 |
| provider-refresh-success | review-qa-20260811222420-7f4c97 | passed | 14/14 | deleted 2 |
| provider-timeout | review-qa-20260811222422-2035c9 | passed | 10/10 | deleted 2 |
| tenant-isolation | review-qa-20260811222424-979304 | passed | 31/31 | deleted 7 |

Live certification was not performed by this deterministic canary run.
