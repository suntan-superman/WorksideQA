const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const {
  readAppState,
  startApplication,
  hierarchySummary,
  waitForRenderedRuntime,
} = require('../src/rendered-runtime');

test('rendered probe launches the manifest URI with the explicit Android device', () => {
  const calls = [];
  const execute = (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: '' };
  };
  const result = startApplication('adb.exe', 'emulator-5554', 'com.merxus.mobile.qa', 'exp+merxus-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081', execute, {});
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].args, ['-s', 'emulator-5554', 'shell', 'am', 'force-stop', 'com.merxus.mobile.qa']);
  assert.deepEqual(calls[1].args, ['-s', 'emulator-5554', 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'exp+merxus-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081', '-p', 'com.merxus.mobile.qa']);
});

test('rendered probe recognizes the selected app foreground and PID', () => {
  const execute = (_command, args) => args.includes('pidof')
    ? { status: 0, stdout: '4321\n' }
    : { status: 0, stdout: 'mResumedActivity: ActivityRecord{abc com.merxus.mobile.qa/com.merxus.mobile.MainActivity}' };
  const state = readAppState('adb.exe', 'emulator-5554', 'com.merxus.mobile.qa', execute, {});
  assert.equal(state.appPid, 4321);
  assert.equal(state.appForeground, true);
  assert.equal(state.launcherForeground, false);
  assert.match(state.activityText, /com\.merxus\.mobile\.qa/);
});

test('hierarchy summary identifies the intermediate QA-root-only state', () => {
  const summary = hierarchySummary('<hierarchy><node resource-id="qa-environment-root" class="android.view.View" text="" content-desc=""/></hierarchy>');
  assert.deepEqual(summary.resourceIds, ['qa-environment-root']);
  assert.deepEqual(summary.visibleText, []);
  assert.deepEqual(summary.contentDescriptions, []);
});

test('rendered probe reports root and auth readiness timings without login or reset', async () => {
  const calls = [];
  const execute = (_command, args) => {
    calls.push(args);
    if (args.includes('pidof')) return { status: 0, stdout: '4321' };
    if (args.includes('cat')) return { status: 0, stdout: '<node resource-id="qa-environment-root"/><node resource-id="screen.auth.login"/>' };
    return { status: 0, stdout: 'mResumedActivity: ActivityRecord{abc com.merxus.mobile.qa/com.merxus.mobile.MainActivity}' };
  };
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => child.stdout.emit('data', 'Assert that id: qa-environment-root is visible... COMPLETED\nAssert that id: screen.auth.login is visible... COMPLETED\n'));
    process.nextTick(() => child.emit('close', 0, null));
    return child;
  };
  const report = await waitForRenderedRuntime({
    adb: 'adb.exe', maestro: 'maestro.bat', deviceId: 'emulator-5554', appId: 'com.merxus.mobile.qa',
    launchUri: 'exp+merxus-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081',
    execute, spawn, terminate: () => {}, env: {}, timeoutMs: 60000, pollMs: 1,
  });
  assert.equal(report.ok, true);
  assert.equal(report.readySelector, 'screen.auth.login');
  assert.equal(report.appPid, 4321);
  assert.equal(calls.some((args) => args.includes('pm')), false);
  assert.equal(calls.some((args) => args.includes('force-stop')), true);
});

function readinessOptions(overrides = {}) {
  let fakeNow = 0;
  const execute = (_command, args) => {
    if (args.includes('pidof')) return { status: 0, stdout: '4321' };
    return { status: 0, stdout: 'mResumedActivity: ActivityRecord{abc com.merxus.mobile.qa/com.merxus.mobile.MainActivity}' };
  };
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => child.emit('close', 0, null));
    return child;
  };
  return {
    adb: 'adb.exe', maestro: 'maestro.bat', deviceId: 'emulator-5554', appId: 'com.merxus.mobile.qa',
    launchUri: 'exp+merxus-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081',
    execute, spawn, terminate: () => {}, env: {}, timeoutMs: 100, pollMs: 10,
    now: () => fakeNow,
    sleep: async (ms) => { fakeNow += ms; },
    ...overrides,
  };
}

test('rendered probe polls a legitimate intermediate state until login resolves', async () => {
  let hierarchyReads = 0;
  const report = await waitForRenderedRuntime(readinessOptions({
    readHierarchy: () => {
      hierarchyReads += 1;
      return hierarchyReads === 1
        ? '<node resource-id="qa-environment-root"/>'
        : '<node resource-id="qa-environment-root"/><node resource-id="screen.auth.login"/>';
    },
  }));
  assert.equal(report.ok, true);
  assert.equal(report.readySelector, 'screen.auth.login');
  assert.equal(report.intermediateStateKind, 'APP_BOOTSTRAP_NO_CONTENT');
  assert.ok(report.intermediateStateAt);
  assert.ok(hierarchyReads >= 2);
});

test('rendered probe captures a bounded unresolved intermediate state', async () => {
  const report = await waitForRenderedRuntime(readinessOptions({
    timeoutMs: 35,
    readHierarchy: () => '<hierarchy><node resource-id="qa-environment-root" text="Loading workspace"/></hierarchy>',
  }));
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'AUTH_OR_DASHBOARD_NOT_READY');
  assert.equal(report.intermediateStateKind, 'APP_BOOTSTRAP_LOADING');
  assert.equal(report.intermediateState.visibleText[0], 'Loading workspace');
  assert.ok(report.intermediateStateDurationMs >= 0);
});

test('rendered probe fails immediately when the app dies after QA root', async () => {
  let reads = 0;
  const report = await waitForRenderedRuntime(readinessOptions({
    readState: (_adb, _device, _app, execute) => {
      reads += 1;
      if (reads === 1) return { appPid: 4321, appForeground: true, launcherForeground: false, activityText: 'com.merxus.mobile.qa' };
      return { appPid: null, appForeground: false, launcherForeground: false, activityText: '' };
    },
    readHierarchy: () => '<node resource-id="qa-environment-root"/>',
  }));
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'APP_EXITED');
});

test('rendered probe rejects a launcher that replaces the QA app', async () => {
  const report = await waitForRenderedRuntime(readinessOptions({
    readState: () => ({ appPid: 4321, appForeground: false, launcherForeground: true, activityText: 'NexusLauncherActivity' }),
    readHierarchy: () => '<node resource-id="qa-environment-root"/>',
  }));
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'APP_NOT_FOREGROUND');
});
