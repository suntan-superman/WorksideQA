# Merxus QA

Merxus includes web, Firebase, Cloud Run, Twilio, and AI conversation validation targets.

## Review Canary

The Merxus product integration invokes the backend's provider-shaped Google Review Canary and retains Markdown/JSON evidence under `artifacts/merxus/reviews`.

```powershell
npm run qa:merxus:reviews:smoke
npm run qa:merxus:reviews:full -- --execute --cleanup
```

Execution remains fail-closed unless the backend staging safety variables and both QA tenant IDs are explicitly allowlisted. Agave & Oak and Legends Event Center are listed only as potential authorized live-certification businesses; synthetic fixtures never target them.
