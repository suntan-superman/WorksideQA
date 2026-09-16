const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ensureAndroidEmulator,
  parseAdbDevices,
  resolveAndroidEmulator,
} = require('../src/android-emulator');

const baseEnv = {
  MERXUS_ANDROID_EMULATOR_ID: 'emulator-5554',
  MERXUS_ANDROID_AVD_NAME: 'Merxus_Maestro_35',
  USERPROFILE: 'C:/qa-user',
  LOCALAPPDATA: 'C:/qa-user/AppData/Local',
};

function fakeSpawn() {
  return { pid: 9001, exitCode: null, unref() {} };
}

test('parses online, offline, and unauthorized ADB devices', () => {
  assert.deepEqual(parseAdbDevices('List of devices attached\nemulator-5554 device product:qa\nphone-1 unauthorized\n'), [
    { serial: 'emulator-5554', state: 'device', details: 'product:qa' },
    { serial: 'phone-1', state: 'unauthorized', details: '' },
  ]);
});

test('reuses an already running and booted configured emulator', async () => {
  const calls = [];
  const result = await ensureAndroidEmulator({
    platform: 'win32', product: 'merxus', env: baseEnv, adbPath: 'adb.exe',
    execute: (_command, args) => {
      calls.push(args);
      if (args[0] === 'devices') return { status: 0, stdout: 'List of devices attached\nemulator-5554 device\n' };
      if (args.at(-1) === 'sys.boot_completed') return { status: 0, stdout: '1\n' };
      if (args.includes('emu')) return { status: 0, stdout: 'Merxus_Maestro_35\nOK\n' };
      return { status: 0, stdout: 'device\n' };
    },
  });
  assert.equal(result.ready, true);
  assert.equal(result.reused, true);
  assert.equal(calls.some((args) => args.includes('-list-avds')), false);
});

test('starts the configured AVD, waits for ADB, then waits for boot completion', async () => {
  let devicePolls = 0;
  let bootPolls = 0;
  const result = await ensureAndroidEmulator({
    platform: 'win32', product: 'merxus', env: baseEnv, adbPath: 'C:/Android/platform-tools/adb.exe',
    emulatorPath: 'C:/Android/emulator/emulator.exe', timeoutMs: 1000, pollIntervalMs: 1,
    spawn: fakeSpawn,
    fs: { existsSync: () => true, mkdirSync() {}, openSync: () => 1, closeSync() {} },
    execute: (_command, args) => {
      if (args[0] === '-list-avds') return { status: 0, stdout: 'Merxus_Maestro_35\n' };
      if (args[0] === 'devices') {
        devicePolls += 1;
        return { status: 0, stdout: devicePolls > 1 ? 'List of devices attached\nemulator-5554 device\n' : 'List of devices attached\n' };
      }
      if (args.at(-1) === 'sys.boot_completed') {
        bootPolls += 1;
        return { status: 0, stdout: bootPolls > 1 ? '1\n' : '0\n' };
      }
      return { status: 0, stdout: 'device\n' };
    },
  });
  assert.equal(result.ready, true);
  assert.equal(result.started, true);
  assert.equal(result.avdName, 'Merxus_Maestro_35');
  assert.equal(result.pid, 9001);
});

test('reuses the shared configured AVD for SageSet without product-specific launcher logic', async () => {
  const env = {
    SAGESET_ANDROID_EMULATOR_ID: 'emulator-5554',
    SAGESET_ANDROID_AVD_NAME: 'Merxus_Maestro_35',
  };
  const result = await ensureAndroidEmulator({
    platform: 'win32', product: 'sageset', env, adbPath: 'adb.exe',
    execute: (_command, args) => {
      if (args[0] === 'devices') return { status: 0, stdout: 'List of devices attached\nemulator-5554 device\n' };
      if (args.at(-1) === 'sys.boot_completed') return { status: 0, stdout: '1\n' };
      if (args.includes('emu')) return { status: 0, stdout: 'Merxus_Maestro_35\nOK\n' };
      return { status: 0, stdout: 'device\n' };
    },
  });
  assert.equal(result.ready, true);
  assert.equal(result.reused, true);
  assert.equal(result.avdName, 'Merxus_Maestro_35');
});

test('fails with AVD and ADB diagnostics when boot times out', async () => {
  await assert.rejects(() => ensureAndroidEmulator({
    platform: 'win32', product: 'merxus', env: baseEnv, adbPath: 'adb.exe', emulatorPath: 'C:/Android/emulator/emulator.exe',
    timeoutMs: 5, pollIntervalMs: 1, spawn: fakeSpawn,
    fs: { existsSync: () => true, mkdirSync() {}, openSync: () => 1, closeSync() {} },
    execute: (_command, args) => {
      if (args[0] === 'devices') return { status: 0, stdout: 'List of devices attached\n' };
      if (args[0] === '-list-avds') return { status: 0, stdout: 'Merxus_Maestro_35\n' };
      return { status: 0, stdout: '0\n' };
    },
  }), /Merxus_Maestro_35: timed out.*emulator\.exe.*emulator-5554/);
});

test('fails clearly for an incompatible configured device without killing it', async () => {
  await assert.rejects(() => ensureAndroidEmulator({
    platform: 'win32', product: 'merxus', env: { ...baseEnv, MERXUS_ANDROID_EMULATOR_ID: 'usb-device-1' }, adbPath: 'adb.exe',
    execute: (_command, args) => args[0] === 'devices'
      ? { status: 0, stdout: 'List of devices attached\nusb-device-1 device model:phone\n' }
      : { status: 0, stdout: 'device\n' },
  }), /usb-device-1 is incompatible/i);
});

test('reports a missing SDK emulator executable with recovery inputs', async () => {
  await assert.rejects(() => ensureAndroidEmulator({
    platform: 'win32', product: 'merxus', env: baseEnv, adbPath: 'C:/missing/platform-tools/adb.exe',
    fs: { existsSync: () => false },
    execute: (_command, args) => args[0] === 'devices' ? { status: 0, stdout: 'List of devices attached\n' } : { status: 0, stdout: '' },
  }), /emulator executable not found.*ANDROID_HOME.*WORKSIDEQA_ANDROID_EMULATOR_BIN/);
});

test('resolves emulator from the SDK fallback without PATH changes', () => {
  const resolved = resolveAndroidEmulator({
    platform: 'win32', env: { LOCALAPPDATA: 'C:/qa/AppData/Local' },
    fs: { existsSync: (candidate) => candidate.toLowerCase() === 'c:\\qa\\appdata\\local\\android\\sdk\\emulator\\emulator.exe' },
  });
  assert.equal(resolved.toLowerCase(), 'c:\\qa\\appdata\\local\\android\\sdk\\emulator\\emulator.exe');
});
