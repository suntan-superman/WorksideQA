# Merxus iOS Maestro Simulator Preparation

## Purpose

Merxus Phase 1 uses a dedicated iOS Simulator. Password AutoFill must be disabled on that simulator so the system `Save Password?` sheet cannot block Maestro after login.

Apple exposes this as a user setting. Apple does not document a supported `simctl` or `defaults` command for changing or reading it. The managed-device `allowPasswordAutoFill` restriction requires supervised iOS and is not an appropriate substitute for a local QA simulator. WorksideQA therefore requires a one-time manual setting plus a UDID-bound acknowledgement; it does not write an undocumented simulator preference.

## One-time setup

Perform these steps on the exact simulator used for certification:

1. Boot the simulator identified by `MERXUS_IOS_SIMULATOR_ID`.
2. Open **Settings** inside that simulator.
3. Open **General > AutoFill & Passwords**.
4. Turn **AutoFill Passwords and Passkeys** off.
5. Close Settings.

For iOS 17 or earlier, use **Settings > Passwords > Password Options** and turn **AutoFill Passwords and Passkeys** off.

This is a simulator-wide setting. Clearing `com.merxus.mobile.qa` app state, reinstalling the QA app, or relaunching it does not reset the setting. Erasing/recreating the simulator or selecting a different simulator requires repeating this preparation.

## Bind the acknowledgement to the selected simulator

In the same Terminal session used to run WorksideQA, set both variables to the exact simulator UDID:

```bash
export MERXUS_IOS_SIMULATOR_ID='3C029085-0B3D-49B6-AB7D-2943DA45F695'
export MERXUS_IOS_AUTOFILL_DISABLED_SIMULATOR_ID="$MERXUS_IOS_SIMULATOR_ID"
```

The second variable is an operator acknowledgement, not a hidden inspection of iOS preferences. WorksideQA fails preflight if it is missing or does not exactly match the explicitly selected simulator UDID. This prevents an acknowledgement for one simulator from silently authorizing another.

## Verify persistence before certification

1. Run Phase 1 once and confirm login reaches `screen.dashboard.ready` without a `Save Password?` sheet.
2. Let WorksideQA perform its normal `clearState: true` relaunch.
3. Run Phase 1 again. The sheet must remain absent.
4. If the sheet returns, revisit the setting on the selected simulator and confirm the two UDID variables match.

## Run Phase 1

From the WorksideQA repository:

```bash
cd ~/Source/WorksideQA
npm run qa:merxus:maestro:phase1:ios
```

No Merxus rebuild/reinstall and no Metro, Firebase, or backend restart is required for this preparation.
