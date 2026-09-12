# Merxus Maestro Phase 0 Certification

**Overall:** PHASE 0 CERTIFIED

| Check | Result | Detail |
|---|---|---|
| QA app identity | PASS | com.merxus.mobile.qa != com.merxus.mobile |
| Production app rejection | PASS | Manifest identities are distinct and mobile contract tests enforce the rejection. |
| Production Firebase rejection | PASS | merxus-maestro-local |
| Production backend rejection | PASS | http://127.0.0.1:8787 |
| Auth emulator contract | PASS | 127.0.0.1:9099 |
| Firestore emulator contract | PASS | 127.0.0.1:8080 |
| Storage emulator contract | PASS | 127.0.0.1:9199 |
| Authoritative rules available | PASS | Merxus/web Firebase files found. |
| External providers disabled | PASS | All external providers disabled. |
| Fixture reset bounded | PASS | Bounded ID and dual-confirmation tests passed. |
| iOS explicit-device support | PASS | MERXUS_IOS_SIMULATOR_ID |
| Android explicit-device support | PASS | MERXUS_ANDROID_EMULATOR_ID |
| Notification security review | PASS | Authenticated user/tenant ownership tests passed. |
