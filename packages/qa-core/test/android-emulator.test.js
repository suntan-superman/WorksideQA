const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ensureAndroidEmulator,
  ensureAdbCommunication,
  canonicalAdbServerOwner,
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

test('retries a transient canonical ADB client handshake without declaring the emulator offline', async () => {
  let probes = 0;
  const result = await ensureAdbCommunication('C:/Android/platform-tools/adb.exe', {
    platform: 'win32', adbRecoveryTimeoutMs: 50, adbRecoveryPollMs: 1, adbRestartAfterMs: 100,
    execute: (_command, args) => {
      if (args[0] === 'devices') {
        probes += 1;
        return probes === 1 ? { status: 1, stdout: '', stderr: 'cannot connect to daemon' } : { status: 0, stdout: 'List of devices attached\n' };
      }
      return { status: 0, stdout: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.recovered, false);
  assert.equal(result.attempts, 2);
});

test('restarts only a positively identified canonical ADB daemon and then recovers', async () => {
  let probes = 0;
  const calls = [];
  const adbPath = 'C:/Android/platform-tools/adb.exe';
  const result = await ensureAdbCommunication(adbPath, {
    platform: 'win32', adbRecoveryTimeoutMs: 100, adbRecoveryPollMs: 1, adbRestartAfterMs: 0,
    adbPortOwner: 44992,
    adbProcessInfo: () => ({ ProcessId: 44992, ParentProcessId: null, ExecutablePath: adbPath, Name: 'adb.exe', CommandLine: `${adbPath} -L tcp:5037 fork-server server` }),
    execute: (command, args) => {
      calls.push({ command, args });
      if (args[0] === 'devices') {
        probes += 1;
        return probes < 2 ? { status: 1, stdout: '', stderr: 'could not read ok from ADB Server' } : { status: 0, stdout: 'List of devices attached\n' };
      }
      return { status: 0, stdout: 'OK\n' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.ok(calls.some((call) => call.command === adbPath && call.args[0] === 'kill-server'));
  assert.ok(calls.some((call) => call.command === adbPath && call.args[0] === 'start-server'));
});

test('does not kill an unknown ADB port owner and fails within the recovery budget', async () => {
  const calls = [];
  const result = await ensureAdbCommunication('C:/Android/platform-tools/adb.exe', {
    platform: 'win32', adbRecoveryTimeoutMs: 10, adbRecoveryPollMs: 1, adbRestartAfterMs: 0,
    adbPortOwner: 12345,
    adbProcessInfo: () => ({ ProcessId: 12345, ExecutablePath: 'C:/Other/adb.exe', Name: 'adb.exe' }),
    execute: (command, args) => { calls.push({ command, args }); return args[0] === 'devices' ? { status: 1, stderr: 'cannot connect to daemon' } : { status: 0, stdout: '' }; },
  });
  assert.equal(result.ok, false);
  assert.equal(calls.some((call) => call.args[0] === 'kill-server'), false);
});

test('accepts a canonical orphaned ADB daemon after its launcher parent exits', () => {
  const result = canonicalAdbServerOwner(44992, 'C:/Android/platform-tools/adb.exe', {
    platform: 'win32', adbProcessInfo: () => ({ ProcessId: 44992, ParentProcessId: 34072, ExecutablePath: 'C:/Android/platform-tools/adb.exe', Name: 'adb.exe' }),
  });
  assert.equal(result.verified, true);
});

test('continues emulator startup after safely recovering a wedged canonical daemon', async () => {
  let devicePolls = 0;
  let adbProbes = 0;
  const adbPath = 'C:/Android/platform-tools/adb.exe';
  const result = await ensureAndroidEmulator({
    platform: 'win32', product: 'merxus', env: baseEnv, adbPath,
    emulatorPath: 'C:/Android/emulator/emulator.exe', timeoutMs: 100, pollIntervalMs: 1,
    adbRecoveryTimeoutMs: 20, adbRecoveryPollMs: 1, adbRestartAfterMs: 0,
    adbPortOwner: 44992,
    adbProcessInfo: () => ({ ProcessId: 44992, ExecutablePath: adbPath, Name: 'adb.exe', CommandLine: `${adbPath} -L tcp:5037 fork-server server` }),
    spawn: fakeSpawn,
    fs: { existsSync: () => true, mkdirSync() {}, openSync: () => 1, closeSync() {} },
    execute: (command, args) => {
      if (args[0] === 'devices') {
        adbProbes += 1;
        if (adbProbes === 1) return { status: 1, stderr: 'cannot connect to daemon' };
        devicePolls += 1;
        return { status: 0, stdout: devicePolls > 1 ? 'List of devices attached\nemulator-5554 device\n' : 'List of devices attached\n' };
      }
      if (args.at(-1) === 'sys.boot_completed') return { status: 0, stdout: '1\n' };
      return { status: 0, stdout: 'OK\n' };
    },
  });
  assert.equal(result.ready, true);
  assert.equal(result.started, true);
});
