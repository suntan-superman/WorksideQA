const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('cross-spawn');
const { spawnCommandSync, fromRoot } = require('../../qa-utils/src');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_POLL_MS = 1000;

const MOBILE_QA_ENVIRONMENTS = require('../../../configs/mobile-qa-environments.json');
const DEVICE_CONTRACTS = Object.freeze(Object.fromEntries(Object.entries(MOBILE_QA_ENVIRONMENTS.products || {}).map(([product, config]) => [product, {
  idEnvKey: config.device?.envKey,
  avdEnvKey: config.device?.avdNameEnvKey,
}]).filter(([, contract]) => contract.idEnvKey)));

function sdkRoots(env = process.env, platform = process.platform, adbPath = '') {
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT];
  if (platform === 'win32') roots.push(path.join(env.LOCALAPPDATA || path.join(env.USERPROFILE || '', 'AppData', 'Local'), 'Android', 'Sdk'));
  if (adbPath) {
    const normalized = path.resolve(String(adbPath));
    if (path.basename(path.dirname(normalized)).toLowerCase() === 'platform-tools') roots.push(path.dirname(path.dirname(normalized)));
  }
  return [...new Set(roots.filter(Boolean).map((root) => path.resolve(String(root))))];
}

function resolveAndroidEmulator(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const fsImpl = options.fs || fs;
  const override = String(env.WORKSIDEQA_ANDROID_EMULATOR_BIN || '').trim();
  const names = platform === 'win32' ? ['emulator.exe', 'emulator'] : ['emulator'];
  const candidates = [];
  if (override) candidates.push(String(override).replace(/^['"]|['"]$/g, ''));
  for (const root of sdkRoots(env, platform, options.adbPath)) {
    for (const name of names) candidates.push(path.join(root, 'emulator', name));
  }
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fsImpl.existsSync(resolved)) return resolved;
  }
  return null;
}

function commandResult(command, args, options = {}) {
  const run = options.execute || spawnCommandSync;
  return run(command, args, {
    env: options.env,
    encoding: 'utf8',
    timeout: options.commandTimeoutMs || 5000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseAdbDevices(output) {
  return String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .filter((line) => !/^List of devices attached/i.test(line))
    .map((line) => {
      const fields = line.split(/\s+/);
      return { serial: fields[0], state: fields[1] || 'unknown', details: fields.slice(2).join(' ') };
    }).filter((item) => item.serial);
}

function listDevices(adbPath, options = {}) {
  const result = commandResult(adbPath, ['devices', '-l'], options);
  return { result, devices: result.error || result.status !== 0 ? [] : parseAdbDevices(result.stdout) };
}

function deviceState(adbPath, serial, options = {}) {
  const result = commandResult(adbPath, ['-s', serial, 'get-state'], options);
  return { result, state: result.error || result.status !== 0 ? 'offline' : String(result.stdout || '').trim() || 'offline' };
}

function bootComplete(adbPath, serial, options = {}) {
  const result = commandResult(adbPath, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], options);
  const alternate = result.error || result.status !== 0 ? '' : String(result.stdout || '').trim();
  return alternate === '1';
}

function runningAvdName(adbPath, serial, options = {}) {
  const result = commandResult(adbPath, ['-s', serial, 'emu', 'avd', 'name'], options);
  if (result.error || result.status !== 0) return null;
  const line = String(result.stdout || '').split(/\r?\n/).map((value) => value.trim()).find((value) => value && !/^OK/i.test(value));
  return line || null;
}

function configuredDevice(product, env = process.env) {
  const contract = DEVICE_CONTRACTS[product];
  if (!contract) return null;
  return {
    ...contract,
    serial: String(env[contract.idEnvKey] || '').trim(),
    avdName: String(env[contract.avdEnvKey] || '').trim(),
  };
}

function discoverAvdName(emulatorPath, options = {}) {
  const configured = String(options.configuredAvdName || '').trim();
  if (configured) return { avdName: configured, source: 'config' };
  const result = commandResult(emulatorPath, ['-list-avds'], options);
  const names = result.error || result.status !== 0 ? [] : String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (names.length === 1) return { avdName: names[0], source: 'single-installed-avd' };
  if (!names.length) throw new Error(`No Android AVDs are installed (emulator: ${emulatorPath}). Set ${options.avdEnvKey || 'the product Android AVD name'} or install an AVD.`);
  throw new Error(`Multiple Android AVDs are installed (${names.join(', ')}); set ${options.avdEnvKey || 'the product Android AVD name'} to select the configured AVD.`);
}

function serialPort(serial) {
  const match = String(serial || '').match(/^emulator-(\d+)$/i);
  return match ? Number(match[1]) : null;
}

function spawnConfiguredEmulator(emulatorPath, avdName, serial, options = {}) {
  const logDirectory = options.logDirectory || fromRoot('.worksideqa', 'logs');
  const fsImpl = options.fs || fs;
  fsImpl.mkdirSync(logDirectory, { recursive: true });
  const logPath = path.join(logDirectory, `${options.product || 'qa'}-android-emulator-${Date.now()}.log`);
  const out = fsImpl.openSync(logPath, 'a');
  const args = ['-avd', avdName];
  const port = serialPort(serial);
  if (port) args.push('-port', String(port));
  const spawnImpl = options.spawn || spawn;
  let child;
  try {
    child = spawnImpl(emulatorPath, args, {
      detached: true,
      windowsHide: false,
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', out, out],
    });
  } finally {
    try { fsImpl.closeSync(out); } catch { /* child inherited the descriptor */ }
  }
  let exitInfo = null;
  child.once?.('error', (error) => { exitInfo = { code: null, signal: null, error: error.message }; });
  child.once?.('exit', (code, signal) => { exitInfo = { code, signal }; });
  child.unref?.();
  return { child, pid: child.pid, args, logPath, avdName, emulatorPath, getExitInfo: () => exitInfo };
}

async function ensureAndroidEmulator(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return { ready: true, skipped: true, reason: 'non-Windows platform' };
  const env = options.env || process.env;
  const device = configuredDevice(options.product, env);
  if (!device?.serial) return { ready: true, skipped: true, reason: `no ${device?.idEnvKey || 'Android emulator'} configured` };
  const adbPath = options.adbPath;
  if (!adbPath) throw new Error(`Cannot start ${options.product}/android: ADB executable is unavailable.`);
  const runOptions = { ...options, env, product: options.product };
  const initial = listDevices(adbPath, runOptions);
  const listed = initial.devices.find((item) => item.serial === device.serial);
  if (listed && listed.state === 'device' && bootComplete(adbPath, device.serial, runOptions)) {
    const actualAvd = runningAvdName(adbPath, device.serial, runOptions);
    if (device.avdName && actualAvd && actualAvd !== device.avdName) {
      throw new Error(`Android device ${device.serial} is running AVD ${actualAvd}, but ${device.avdEnvKey} selects ${device.avdName}. It was not killed or adopted.`);
    }
    process.stdout.write(`Android emulator: READY (${device.serial})${actualAvd ? ` AVD=${actualAvd}` : ''}\n`);
    return { ready: true, reused: true, serial: device.serial, avdName: actualAvd || device.avdName || null, devices: initial.devices };
  }
  if (listed && !/^emulator-/i.test(device.serial)) {
    throw new Error(`Android device ${device.serial} is incompatible with the configured emulator contract (state=${listed.state}). It was not killed or adopted.`);
  }
  process.stdout.write(`Android emulator: NOT RUNNING (${device.serial})\n`);
  let emulatorPath = options.emulatorPath || resolveAndroidEmulator({ ...runOptions, adbPath });
  if (!emulatorPath) {
    const roots = sdkRoots(env, platform, adbPath);
    throw new Error(`Cannot start Android emulator ${device.serial}: emulator executable not found. SDK roots checked: ${roots.join(', ') || '(none)'}. Set ANDROID_HOME/ANDROID_SDK_ROOT or WORKSIDEQA_ANDROID_EMULATOR_BIN.`);
  }
  let discovered;
  try {
    discovered = discoverAvdName(emulatorPath, { ...runOptions, configuredAvdName: device.avdName, avdEnvKey: device.avdEnvKey });
  } catch (error) {
    throw new Error(`Cannot start Android emulator ${device.serial}: ${error.message}`);
  }
  process.stdout.write(`Starting ${discovered.avdName}...\n`);
  let launch;
  try {
    launch = spawnConfiguredEmulator(emulatorPath, discovered.avdName, device.serial, runOptions);
  } catch (error) {
    throw new Error(`FAILED Android emulator ${discovered.avdName}: could not launch ${emulatorPath} for ADB serial ${device.serial}: ${error.message}. Corrective action: verify the SDK/emulator installation and AVD configuration.`);
  }
  process.stdout.write(`Waiting for ADB...\n`);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const pollMs = Number(options.pollIntervalMs || DEFAULT_POLL_MS);
  const deadline = Date.now() + timeoutMs;
  let bootMessageShown = false;
  while (Date.now() < deadline) {
    const exitInfo = launch.getExitInfo?.();
    if (exitInfo || launch.child?.exitCode != null) throw new Error(`FAILED Android emulator ${discovered.avdName}: process exited with code ${exitInfo?.code ?? launch.child?.exitCode ?? 'unknown'}${exitInfo?.error ? ` (${exitInfo.error})` : ''}. Log: ${launch.logPath}. ADB serial: ${device.serial}.`);
    const current = listDevices(adbPath, runOptions);
    const target = current.devices.find((item) => item.serial === device.serial);
    if (target?.state === 'device') {
      if (!bootMessageShown) { process.stdout.write(`Waiting for Android boot...\n`); bootMessageShown = true; }
      if (bootComplete(adbPath, device.serial, runOptions)) {
        process.stdout.write(`Android emulator: READY (${device.serial})\n`);
        return { ready: true, started: true, serial: device.serial, avdName: discovered.avdName, emulatorPath, pid: launch.pid, logPath: launch.logPath, devices: current.devices };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const final = listDevices(adbPath, runOptions);
  throw new Error(`FAILED Android emulator ${discovered.avdName}: timed out after ${timeoutMs}ms. Emulator: ${emulatorPath}; ADB serial: ${device.serial}; ADB state: ${JSON.stringify(final.devices)}; Log: ${launch.logPath}; corrective action: inspect the emulator log and start the configured AVD manually if necessary.`);
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_POLL_MS,
  DEVICE_CONTRACTS,
  sdkRoots,
  resolveAndroidEmulator,
  parseAdbDevices,
  listDevices,
  deviceState,
  bootComplete,
  configuredDevice,
  runningAvdName,
  discoverAvdName,
  serialPort,
  spawnConfiguredEmulator,
  ensureAndroidEmulator,
};
