const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const {
  readAppState,
  verifyLaunchTarget,
  startApplication,
  hierarchySummary,
  captureObserverProcesses,
  inferFlowReadiness,
  waitForRenderedRuntime,
} = require('../src/rendered-runtime');

test('qa-root flow verifies terminal readiness in the same bounded Maestro observer', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'rendered-runtime-flows', 'qa-root.yaml'), 'utf8');
  assert.match(source, /id: qa-environment-root/);
  assert.match(source, /id: screen\.auth\.login/);
  assert.match(source, /id: screen\.dashboard\.ready/);
  assert.match(source, /while:/);
  assert.match(source, /worksideqaStableScreenAttempts < 200/);
});

test('SageSet rendered flow accepts only real login or Today markers', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'rendered-runtime-flows', 'sageset-root.yaml'), 'utf8');
  assert.match(source, /appId: com\.workside\.sageset/);
  assert.match(source, /id: screen\.auth\.welcome/);
  assert.match(source, /id: auth\.welcome\.login/);
  assert.match(source, /id: screen\.auth\.login/);
  assert.match(source, /id: screen\.today\.ready/);
  assert.match(source, /visible: "Connected to:"/);
  assert.match(source, /tapOn: "Connected to:"/);
  assert.doesNotMatch(source, /tapOn: "Connect"/);
});

test('SageSet launch target uses the canonical dev-client scheme and Metro port', () => {
  const result = verifyLaunchTarget('adb.exe', 'emulator-5554', 'com.workside.sageset', 'exp+sageset://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081', (_command, args) => {
    if (args.includes('pm')) return { status: 0, stdout: 'package:com.workside.sageset\n' };
    if (args.includes('dumpsys')) return { status: 0, stdout: 'com.sageset.fitness.MainActivity' };
    if (args.includes('resolve-activity')) return { status: 0, stdout: 'com.workside.sageset/com.sageset.fitness.MainActivity\n' };
    if (args.includes('--list')) return { status: 0, stdout: 'host-17 tcp:8081 tcp:8081\n' };
    return { status: 0, stdout: '' };
  }, {}, { expectedActivity: 'com.sageset.fitness.MainActivity', metroPort: 8081 });
  assert.equal(result.ok, true);
  assert.equal(result.reverse, 'tcp:8081 -> tcp:8081');
});

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
  assert.equal(calls[1].args.includes('-W'), false);
});

test('observer process snapshot captures device instrumentation without starting another UI observer', () => {
  const calls = [];
  const execute = (_command, args) => {
    calls.push(args);
    if (args.includes('ps')) return { status: 0, stdout: 'u0_a123 4321 dev.mobile.maestro.test\\n' };
    if (args.includes('accessibility')) return { status: 0, stdout: 'UiAutomationManager state\\n' };
    if (args.includes('dumpsys')) return { status: 0, stdout: 'Instrumentation: dev.mobile.maestro.test/androidx.test.runner.AndroidJUnitRunner\\n' };
    if (args.includes('pm')) return { status: 0, stdout: 'instrumentation:dev.mobile.maestro.test/androidx.test.runner.AndroidJUnitRunner\\n' };
    return { status: 0, stdout: '' };
  };
  const hostExecute = (_command, args) => ({ status: 0, stdout: '"java.exe","1234"\\n' });
  const snapshot = captureObserverProcesses('adb.exe', 'emulator-5554', execute, {}, hostExecute);
  assert.match(snapshot.deviceProcesses[0], /dev\.mobile\.maestro\.test/);
  assert.match(snapshot.instrumentationState, /AndroidJUnitRunner/);
  assert.match(snapshot.accessibilityState, /UiAutomationManager/);
  assert.match(snapshot.installedInstrumentation[0], /dev\.mobile\.maestro\.test/);
  assert.ok(calls.some((args) => args.includes('dumpsys') && args.includes('instrumentation')));
  assert.ok(calls.some((args) => args.includes('pm') && args.includes('instrumentation')));
  assert.ok(!calls.some((args) => args.includes('uiautomator')));
});

test('launch preflight validates package, MainActivity, deep-link resolution, and reverse mapping', () => {
  const calls = [];
  const execute = (_command, args) => {
    calls.push(args);
    if (args.includes('pm')) return { status: 0, stdout: 'package:com.merxus.mobile.qa\n' };
    if (args.includes('dumpsys')) return { status: 0, stdout: 'com.merxus.mobile.qa/com.merxus.mobile.MainActivity' };
    if (args.includes('resolve-activity')) return { status: 0, stdout: 'com.merxus.mobile.qa/com.merxus.mobile.MainActivity\n' };
    if (args.includes('--list')) return { status: 0, stdout: 'host-17 tcp:8081 tcp:8081\n' };
    return { status: 0, stdout: '' };
  };
  const result = verifyLaunchTarget('C:\\Android\\adb.exe', 'emulator-5554', 'com.merxus.mobile.qa', 'exp+merxus-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081', execute, {});
  assert.equal(result.ok, true);
  assert.equal(result.expectedComponent, 'com.merxus.mobile.qa/com.merxus.mobile.MainActivity');
  assert.ok(calls.some((args) => args.includes('resolve-activity')));
  assert.ok(calls.some((args) => args.includes('--list')));
  assert.equal(calls.some((args) => args.includes('reverse') && args.includes('tcp:8081') && args.includes('tcp:8081') && !args.includes('--list')), false);
});

test('launch preflight reports an installed-package failure without attempting launch', () => {
  const calls = [];
  const execute = (_command, args) => { calls.push(args); return { status: 0, stdout: 'package:other.app\n' }; };
  const result = verifyLaunchTarget('adb.exe', 'emulator-5554', 'com.merxus.mobile.qa', 'exp+merxus-mobile://invalid', execute, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APP_PACKAGE_MISSING');
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
});

test('launch preflight configures a missing reverse mapping and preserves the URI as one argument', () => {
  const calls = [];
  const execute = (_command, args) => {
    calls.push(args);
    if (args.includes('pm')) return { status: 0, stdout: 'package:com.merxus.mobile.qa\n' };
    if (args.includes('dumpsys')) return { status: 0, stdout: 'com.merxus.mobile.MainActivity' };
    if (args.includes('resolve-activity')) return { status: 0, stdout: 'com.merxus.mobile.qa/com.merxus.mobile.MainActivity' };
    if (args.includes('--list')) return { status: 0, stdout: '' };
    return { status: 0, stdout: '' };
  };
  const uri = 'exp+merxus-mobile://expo-development-client/?url=http%3A%2F%2Fhost%20with%20space%3A8081';
  const result = verifyLaunchTarget('adb.exe', 'emulator-5554', 'com.merxus.mobile.qa', uri, execute, {});
  assert.equal(result.ok, true);
  const reverse = calls.find((args) => args.includes('reverse') && args.includes('tcp:8081') && !args.includes('--list'));
  assert.deepEqual(reverse.slice(-3), ['reverse', 'tcp:8081', 'tcp:8081']);
  const resolve = calls.find((args) => args.includes('resolve-activity'));
  assert.equal(resolve.at(-1), uri);
});

test('launch preflight rejects a deep link that resolves to another activity', () => {
  const execute = (_command, args) => {
    if (args.includes('pm')) return { status: 0, stdout: 'package:com.merxus.mobile.qa\n' };
    if (args.includes('dumpsys')) return { status: 0, stdout: 'com.merxus.mobile.MainActivity' };
    if (args.includes('resolve-activity')) return { status: 0, stdout: 'com.merxus.mobile.qa/expo.modules.devlauncher.launcher.DevLauncherActivity' };
    return { status: 0, stdout: 'host-17 tcp:8081 tcp:8081' };
  };
  const result = verifyLaunchTarget('adb.exe', 'emulator-5554', 'com.merxus.mobile.qa', 'exp+merxus-mobile://wrong', execute, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DEEPLINK_RESOLUTION_FAILED');
  assert.match(result.resolvedOutput, /DevLauncherActivity/);
});

test('launch command timeout is reported distinctly from an adb exit failure', () => {
  const result = startApplication('adb.exe', 'emulator-5554', 'com.merxus.mobile.qa', 'exp+merxus-mobile://timeout', (_command, args) => {
    if (args.includes('force-stop')) return { status: 0, stdout: '' };
    const error = new Error('spawnSync adb ETIMEDOUT');
    error.code = 'ETIMEDOUT';
    return { error };
  }, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LAUNCH_COMMAND_TIMEOUT');
  assert.equal(result.exitCode, null);
});

test('launch command returns raw nonzero result and a specific failure code', () => {
  const result = startApplication('adb.exe', 'emulator-5554', 'com.merxus.mobile.qa', 'exp+merxus-mobile://invalid', (_command, args) => {
    if (args.includes('force-stop')) return { status: 0, stdout: '' };
    return { status: 1, stdout: 'Starting: Intent {}', stderr: 'Error: Activity not started' };
  }, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ADB_LAUNCH_FAILED');
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Activity not started/);
  assert.match(result.error, /ADB_LAUNCH_FAILED/);
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

test('foreground detection ignores a historical QA task when the launcher is resumed', () => {
  const execute = (_command, args) => args.includes('pidof')
    ? { status: 0, stdout: '4321\n' }
    : { status: 0, stdout: 'Task com.merxus.mobile.qa hidden\ntopResumedActivity: ActivityRecord{abc com.google.android.apps.nexuslauncher/.NexusLauncherActivity}' };
  const state = readAppState('adb.exe', 'emulator-5554', 'com.merxus.mobile.qa', execute, {});
  assert.equal(state.appPid, 4321);
  assert.equal(state.appForeground, false);
  assert.equal(state.launcherForeground, true);
});

test('hierarchy summary identifies the intermediate QA-root-only state', () => {
  const summary = hierarchySummary('<hierarchy><node resource-id="qa-environment-root" class="android.view.View" text="" content-desc=""/></hierarchy>');
  assert.deepEqual(summary.resourceIds, ['qa-environment-root']);
  assert.deepEqual(summary.visibleText, []);
  assert.deepEqual(summary.contentDescriptions, []);
});

test('single readiness flow reports whether QA root was reached from its terminal assertion', () => {
  assert.deepEqual(inferFlowReadiness('Assert that id: qa-environment-root is visible... FAILED'), {
    qaRootSeen: false,
    lastKnownSelector: null,
  });
  assert.deepEqual(inferFlowReadiness('Assert that id: qa-environment-root is visible... COMPLETED\nAssertion is false: id: screen.auth.login is visible'), {
    qaRootSeen: true,
    lastKnownSelector: 'qa-environment-root',
  });
});

test('foreground app failure includes root/last-selector diagnostics without another observer', async () => {
  const report = await waitForRenderedRuntime(readinessOptions({
    runFlowImplementation: async () => ({
      ok: false,
      code: 1,
      signal: null,
      timedOut: false,
      output: 'Assert that id: qa-environment-root is visible... COMPLETED\nAssertion is false: id: screen.auth.login is visible',
    }),
  }));
  assert.equal(report.reason, 'APP_FOREGROUND_AND_NOT_READY');
  assert.equal(report.qaRootSeen, true);
  assert.equal(report.lastKnownSelector, 'qa-environment-root');
  assert.equal(report.observerAttempts.length, 1);
});

test('foreground app failure distinguishes a root that never rendered', async () => {
  const report = await waitForRenderedRuntime(readinessOptions({
    runFlowImplementation: async () => ({
      ok: false,
      code: 1,
      signal: null,
      timedOut: false,
      output: 'Assert that id: qa-environment-root is visible... FAILED',
    }),
  }));
  assert.equal(report.reason, 'APP_FOREGROUND_AND_NOT_READY');
  assert.equal(report.qaRootSeen, false);
  assert.equal(report.lastKnownSelector, null);
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
    execute, spawn, terminate: () => {}, env: {}, timeoutMs: 60000, pollMs: 1, preflight: false,
    observerProcessSnapshot: () => ({ hostProcesses: [], deviceProcesses: [], activeDriverProcesses: [] }),
    // This test exercises the optional diagnostic hierarchy reader. The
    // production path now verifies terminal readiness inside qa-root.yaml's
    // single Maestro observer and does not issue a second uiautomator dump.
    readHierarchy: () => '<node resource-id="qa-environment-root"/><node resource-id="screen.auth.login"/>',
  });
  assert.equal(report.ok, true);
  assert.equal(report.readySelector, 'screen.auth.login');
  assert.equal(report.appPid, 4321);
  assert.ok(report.probeStart);
  assert.ok(report.probeEnd);
  assert.equal(report.logicalBudgetMs, 60000);
  assert.equal(report.observerFailureAt, null);
  assert.equal(calls.some((args) => args.includes('pm')), false);
  assert.equal(calls.some((args) => args.includes('force-stop')), true);
});

test('normal rendered readiness does not start a second adb hierarchy observer', async () => {
  const calls = [];
  const execute = (_command, args) => {
    calls.push(args);
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
  const report = await waitForRenderedRuntime({
    adb: 'adb.exe', maestro: 'maestro.bat', deviceId: 'emulator-5554', appId: 'com.merxus.mobile.qa',
    launchUri: 'exp+merxus-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081',
    execute, spawn, terminate: () => {}, env: {}, timeoutMs: 60000, pollMs: 1, preflight: false,
    observerProcessSnapshot: () => ({ hostProcesses: [], deviceProcesses: [], activeDriverProcesses: [] }),
  });
  assert.equal(report.ok, true);
  assert.equal(report.readySelector, 'screen.auth.login|screen.dashboard.ready');
  assert.equal(calls.some((args) => args.includes('uiautomator')), false);
});

test('single-observer readiness still rejects a dead app after Maestro exits', async () => {
  let stateReads = 0;
  const report = await waitForRenderedRuntime(readinessOptions({
    readState: () => {
      stateReads += 1;
      return stateReads < 3
        ? { appPid: 4321, appForeground: true, launcherForeground: false, activityText: 'com.merxus.mobile.qa' }
        : { appPid: null, appForeground: false, launcherForeground: false, activityText: '' };
    },
  }));
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'APP_PROCESS_EXITED');
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
    execute, spawn, terminate: () => {}, env: {}, timeoutMs: 100, pollMs: 10, preflight: false,
    now: () => fakeNow,
    observerProcessSnapshot: () => ({ hostProcesses: [], deviceProcesses: [], activeDriverProcesses: [] }),
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
  assert.equal(report.reason, 'STABLE_SCREEN_NOT_READY');
  assert.equal(report.logicalBudgetMs, 35);
  assert.ok(report.probeStart);
  assert.ok(report.probeEnd);
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
  assert.equal(report.reason, 'APP_PROCESS_EXITED');
});

test('rendered probe rejects a launcher that replaces the QA app', async () => {
  const report = await waitForRenderedRuntime(readinessOptions({
    readState: () => ({ appPid: 4321, appForeground: false, launcherForeground: true, activityText: 'NexusLauncherActivity' }),
    readHierarchy: () => '<node resource-id="qa-environment-root"/>',
  }));
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'LAUNCHER_FOREGROUND');
  assert.equal(report.foregroundConfirmation.length, 2);
});

test('rendered probe distinguishes an unavailable hierarchy observer from app readiness failure', async () => {
  const report = await waitForRenderedRuntime(readinessOptions({
    readHierarchyResult: () => ({ xml: '', status: 137, error: 'UiAutomationService already registered' }),
  }));
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'UI_HIERARCHY_UNAVAILABLE');
  assert.match(report.hierarchyError, /already registered/);
});

test('UiAutomation registration collision with a live QA process is classified as observer conflict', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-observer-conflict-'));
  const lockPath = path.join(directory, 'observer.lock');
  let fakeNow = 0;
  let observerBudget = null;
  const calls = [];
  const execute = (_command, args) => {
    calls.push(args);
    if (args.includes('pidof')) return { status: 0, stdout: '4321' };
    return { status: 0, stdout: 'mResumedActivity: ActivityRecord{abc com.merxus.mobile.qa/com.merxus.mobile.MainActivity}' };
  };
  const report = await waitForRenderedRuntime({
    adb: 'adb.exe', maestro: 'maestro.bat', deviceId: 'emulator-5554', appId: 'com.merxus.mobile.qa',
    launchUri: 'exp+merxus-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081',
    execute, runFlowImplementation: async (_maestro, _device, _flow, _env, timeoutMs) => {
      observerBudget = timeoutMs;
      fakeNow = 60_000;
      return { ok: false, code: 143, signal: 'SIGTERM', timedOut: true, output: 'UiAutomationService already registered' };
    }, env: {}, timeoutMs: 60_000, pollMs: 1, now: () => fakeNow, preflight: false, observerLockPath: lockPath,
  });
  assert.equal(report.reason, 'OBSERVER_CONFLICT');
  assert.equal(observerBudget, 60_000);
  assert.equal(report.appPid, 4321);
  assert.equal(report.observerAttempts.length, 1);
  assert.match(report.observerAttempts[0].output, /UiAutomationService already registered/);
  assert.equal(report.observerConflict.source, 'maestro_observer_registration');
  assert.ok(report.elapsedMs <= report.logicalBudgetMs);
  assert.ok(calls.some((args) => args.includes('force-stop')));
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a successful launch with no observed app PID is classified as APP_PROCESS_NOT_STARTED', async () => {
  const report = await waitForRenderedRuntime(readinessOptions({
    runFlowImplementation: async () => ({ ok: false, code: 1, signal: null, timedOut: false, output: 'observer could not inspect hierarchy' }),
    readState: () => ({ appPid: null, appForeground: false, launcherForeground: false, activityText: '' }),
  }));
  assert.equal(report.reason, 'APP_PROCESS_NOT_STARTED');
  assert.equal(report.launchDiagnostics.preparation.skipped, true);
});

test('a normal root observer receives only the remaining logical deadline, without the former grace extension', async () => {
  let observedTimeout = null;
  const report = await waitForRenderedRuntime(readinessOptions({
    timeoutMs: 20,
    runFlowImplementation: async (_maestro, _device, _flow, _env, timeoutMs) => {
      observedTimeout = timeoutMs;
      return { ok: true, code: 0, signal: null, output: '' };
    },
    readHierarchy: () => '<node resource-id="qa-environment-root"/><node resource-id="screen.auth.login"/>',
  }));
  assert.equal(report.ok, true);
  assert.equal(observedTimeout, 20);
});

test('rendered observer lock is released after a successful observer run', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-rendered-lock-'));
  const lockPath = path.join(directory, 'observer.lock');
  const report = await waitForRenderedRuntime(readinessOptions({
    observerLockPath: lockPath,
    runFlowImplementation: async () => ({ ok: true, code: 0, signal: null, output: '' }),
    readHierarchy: () => '<node resource-id="qa-environment-root"/><node resource-id="screen.auth.login"/>',
  }));
  assert.equal(report.ok, true);
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('rendered probe refuses to start when an instrumentation process is already active', async () => {
  let observerStarted = false;
  const report = await waitForRenderedRuntime(readinessOptions({
    observerProcessSnapshot: () => ({ hostProcesses: [], deviceProcesses: ['u0_a123 1234 dev.mobile.maestro.test'], activeDriverProcesses: ['u0_a123 1234 dev.mobile.maestro.test'] }),
    runFlowImplementation: async () => { observerStarted = true; return { ok: true, code: 0, output: '' }; },
  }));
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'OBSERVER_BUSY');
  assert.equal(observerStarted, false);
  assert.match(report.observerProcessesBefore.activeDriverProcesses[0], /dev\.mobile\.maestro\.test/);
});

test('rendered probe waits for the observer driver to exit before a second hierarchy read', async () => {
  let phase = 0;
  let hierarchyRead = false;
  const snapshots = [
    { hostProcesses: [], deviceProcesses: [], activeDriverProcesses: [] },
    { hostProcesses: [], deviceProcesses: ['dev.mobile.maestro.test'], activeDriverProcesses: ['dev.mobile.maestro.test'] },
    { hostProcesses: [], deviceProcesses: [], activeDriverProcesses: [] },
  ];
  const report = await waitForRenderedRuntime(readinessOptions({
    observerProcessSnapshot: () => snapshots[Math.min(phase++, snapshots.length - 1)],
    runFlowImplementation: async () => ({ ok: true, code: 0, signal: null, output: '' }),
    readHierarchy: () => { hierarchyRead = true; return '<node resource-id="qa-environment-root"/><node resource-id="screen.auth.login"/>'; },
  }));
  assert.equal(report.ok, true);
  assert.equal(hierarchyRead, true);
  assert.equal(report.observerAttempts[0].observerCleanupVerified, true);
});

test('failed observer with lingering instrumentation is classified as an observer failure after cleanup inspection', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-observer-failure-'));
  const lockPath = path.join(directory, 'observer.lock');
  let phase = 0;
  const report = await waitForRenderedRuntime(readinessOptions({
    observerLockPath: lockPath,
    observerProcessSnapshot: () => phase++ === 0
      ? { hostProcesses: [], deviceProcesses: [], activeDriverProcesses: [] }
      : { hostProcesses: [], deviceProcesses: ['dev.mobile.maestro.test'], activeDriverProcesses: ['dev.mobile.maestro.test'] },
    runFlowImplementation: async () => ({ ok: false, code: 143, signal: 'SIGTERM', timedOut: true, output: 'observer timed out' }),
  }));
  assert.equal(report.reason, 'OBSERVER_FAILURE');
  assert.equal(report.observerProcessesAfter.activeDriverProcesses.length, 1);
  assert.equal(report.observerConflict.source, 'maestro_observer_teardown');
  assert.equal(report.observerCleanupVerified, undefined);
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(directory, { recursive: true, force: true });
});
