const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const {
  readAppState,
  startApplication,
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
  assert.deepEqual(readAppState('adb.exe', 'emulator-5554', 'com.merxus.mobile.qa', execute, {}), {
    appPid: 4321, appForeground: true, launcherForeground: false,
  });
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
