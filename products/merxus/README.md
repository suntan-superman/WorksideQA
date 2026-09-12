# Merxus QA

Merxus includes web, Firebase, Cloud Run, Twilio, and AI conversation validation targets.

## Expo Development Build Launch

The Android emulator and iOS Simulator descriptors own their Expo Development Client launch URIs. During execution, WorksideQA keeps the checked-in Maestro flows platform-neutral, performs the requested state clear through the selected device, opens the configured URI, and writes a runtime flow that waits for the React Native readiness selector instead of relaunching the package. This bypasses the development-server chooser deterministically.

Android uses the explicit serial for both `adb -s` and Maestro's `--device` argument. iOS preserves Maestro's `clearState` behavior in a generated prelaunch flow, then uses the explicit Simulator UDID with `xcrun simctl openurl`.

The Android URI targets `127.0.0.1:8081`, disables the first-launch Dev Menu onboarding overlay, and therefore requires the standard emulator reverse mapping:

```powershell
adb -s emulator-5554 reverse tcp:8081 tcp:8081
```

The iOS Simulator reaches Metro directly at `127.0.0.1:8081` and does not require Android port reversal.

## Review Canary

The Merxus product integration invokes the backend's provider-shaped Google Review Canary and retains Markdown/JSON evidence under `artifacts/merxus/reviews`.

```powershell
npm run qa:merxus:reviews:smoke
npm run qa:merxus:reviews:full -- --execute --cleanup
```

Execution remains fail-closed unless the backend staging safety variables and both QA tenant IDs are explicitly allowlisted. Agave & Oak and Legends Event Center are listed only as potential authorized live-certification businesses; synthetic fixtures never target them.
