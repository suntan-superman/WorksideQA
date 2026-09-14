const assert = require('node:assert/strict');
const test = require('node:test');
const { dismissAndroidIme, parseAndroidImeState } = require('../src/android-ime');

function stateOutput(visible) {
  return {
    input: [
      'mCurMethodId=com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME',
      `mInputShown=${visible}`,
    ].join('\n'),
    window: [
      'mCurrentFocus=Window{abc u0 com.merxus.mobile.qa/com.merxus.mobile.MainActivity}',
      '  Window #7 Window{def u0 InputMethod}:',
      `    isOnScreen=${visible}`,
      `    isVisible=${visible}`,
      '  Window #8 Window{abc u0 com.merxus.mobile.qa/com.merxus.mobile.MainActivity}:',
    ].join('\n'),
  };
}

function createHarness({ initiallyVisible = true, closeOnEscape = true, keyEventStatus = 0 } = {}) {
  let visible = initiallyVisible;
  let nowMs = 0;
  const calls = [];
  return {
    calls,
    now: () => nowMs,
    wait: async (milliseconds) => { nowMs += milliseconds; },
    execute: async (command, args) => {
      calls.push({ command, args: [...args] });
      if (args.includes('input_method')) return { status: 0, stdout: stateOutput(visible).input, stderr: '' };
      if (args.at(-1) === 'window') return { status: 0, stdout: stateOutput(visible).window, stderr: '' };
      if (args.includes('keyevent')) {
        if (keyEventStatus === 0 && closeOnEscape) visible = false;
        return { status: keyEventStatus, stdout: '', stderr: keyEventStatus === 0 ? '' : 'keyevent failed' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected command' };
    },
  };
}

test('parses current Android IME and focused-window state without UiAutomation', () => {
  const visible = stateOutput(true);
  assert.deepEqual(parseAndroidImeState(visible.input, visible.window), {
    visibilityKnown: true,
    imeVisible: true,
    inputShown: true,
    windowOnScreen: true,
    windowVisible: true,
    activeImePackage: 'com.google.android.inputmethod.latin',
    focusedWindow: 'Window{abc u0 com.merxus.mobile.qa/com.merxus.mobile.MainActivity}',
  });
});

test('visible IME receives KEYCODE_ESCAPE and is verified closed', async () => {
  const harness = createHarness();
  const result = await dismissAndroidIme({
    deviceId: 'emulator-5554', adbPath: 'C:/Android/adb.exe',
    execute: harness.execute, wait: harness.wait, now: harness.now,
  });
  assert.equal(result.keyboardDismissStrategy, 'android-keyevent-escape');
  assert.equal(result.imeVisibleBefore, true);
  assert.equal(result.imeVisibleAfter, false);
  assert.equal(result.attempted, true);
  assert.equal(result.keyEvent, 'KEYCODE_ESCAPE');
  assert.ok(harness.calls.some(({ args }) => args.join(' ') === '-s emulator-5554 shell input keyevent KEYCODE_ESCAPE'));
  assert.ok(harness.calls.every(({ args }) => !/uiautomator|hierarchy|maestro/i.test(args.join(' '))));
});

test('already-closed IME returns immediately without a key event', async () => {
  const harness = createHarness({ initiallyVisible: false });
  const result = await dismissAndroidIme({
    deviceId: 'emulator-5554', adbPath: 'adb',
    execute: harness.execute, wait: harness.wait, now: harness.now,
  });
  assert.equal(result.attempted, false);
  assert.equal(result.imeVisibleBefore, false);
  assert.equal(result.imeVisibleAfter, false);
  assert.equal(harness.calls.some(({ args }) => args.includes('keyevent')), false);
});

test('successful key event that leaves IME visible fails at the bounded deadline', async () => {
  const harness = createHarness({ closeOnEscape: false });
  await assert.rejects(
    dismissAndroidIme({
      deviceId: 'emulator-5554', adbPath: 'adb', timeoutMs: 750, pollIntervalMs: 250,
      execute: harness.execute, wait: harness.wait, now: harness.now,
    }),
    (error) => error.code === 'ANDROID_IME_DISMISS_FAILED' &&
      error.diagnostics.imeVisibleAfter === true && error.diagnostics.dismissElapsedMs === 750
  );
});

test('ADB key-event failure is reported distinctly and safely', async () => {
  const harness = createHarness({ keyEventStatus: 1 });
  await assert.rejects(
    dismissAndroidIme({
      deviceId: 'emulator-5554', adbPath: 'adb',
      execute: harness.execute, wait: harness.wait, now: harness.now,
    }),
    (error) => error.code === 'ANDROID_IME_DISMISS_FAILED' &&
      error.diagnostics.exitCode === 1 && error.diagnostics.reason === 'KEYCODE_ESCAPE command failed'
  );
});

test('explicit device identity and supported visibility evidence are mandatory', async () => {
  await assert.rejects(dismissAndroidIme({ adbPath: 'adb' }), /explicit Android device ID is required/);
  const harness = createHarness();
  harness.execute = async (command, args) => {
    harness.calls.push({ command, args: [...args] });
    return { status: 0, stdout: '', stderr: '' };
  };
  await assert.rejects(
    dismissAndroidIme({ deviceId: 'emulator-5554', adbPath: 'adb', execute: harness.execute }),
    (error) => error.code === 'ANDROID_IME_DISMISS_FAILED' && /visibility signal/.test(error.message)
  );
});
