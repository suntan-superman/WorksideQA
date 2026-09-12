const { spawnCommandSync } = require('../../qa-utils/src');

function parseIosDevices(output) {
  const payload = JSON.parse(output || '{}');
  return Object.values(payload.devices || {}).flat().filter((device) => device.isAvailable !== false).map((device) => ({
    id: device.udid, name: device.name, platform: 'ios', kind: 'simulator', state: String(device.state || '').toLowerCase(), raw: device,
  }));
}

function parseAndroidDevices(output) {
  return String(output || '').split(/\r?\n/).slice(1).map((line) => line.trim()).filter((line) => line && !line.startsWith('*')).map((line) => {
    const [id, state, ...metadata] = line.split(/\s+/);
    return { id, name: metadata.find((item) => item.startsWith('model:'))?.slice(6) || id, platform: 'android', kind: id.startsWith('emulator-') ? 'emulator' : 'physical', state, raw: line };
  });
}

function discoverDevices(platform, execute = spawnCommandSync) {
  const command = platform === 'ios' ? 'xcrun' : 'adb';
  const args = platform === 'ios' ? ['simctl', 'list', 'devices', '--json'] : ['devices', '-l'];
  const result = execute(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${platform} device discovery failed: ${result.error?.message || result.stderr || 'command failed'}`);
  return platform === 'ios' ? parseIosDevices(result.stdout) : parseAndroidDevices(result.stdout);
}

function selectDiscoveredDevice(devices, requestedId, descriptor) {
  if (!requestedId) throw new Error(`Explicit device identity is required via ${descriptor.idEnvKey}.`);
  const matches = devices.filter((device) => device.id === requestedId || device.name === requestedId);
  if (matches.length === 0) throw new Error(`Selected ${descriptor.platform} device does not exist: ${requestedId}`);
  if (matches.length > 1) throw new Error(`Selected ${descriptor.platform} device is ambiguous: ${requestedId}`);
  const selected = matches[0];
  if (selected.platform !== descriptor.platform || selected.kind !== descriptor.kind) throw new Error(`Selected device does not match ${descriptor.platform}/${descriptor.kind}.`);
  if (descriptor.platform === 'ios' && selected.state !== 'booted') throw new Error(`Selected iOS simulator is not booted: ${selected.id}`);
  if (descriptor.platform === 'android' && selected.state !== 'device') throw new Error(`Selected Android emulator is not online: ${selected.id}`);
  return selected;
}

function assertAppInstalled(selected, appId, execute = spawnCommandSync) {
  const command = selected.platform === 'ios' ? 'xcrun' : 'adb';
  const args = selected.platform === 'ios'
    ? ['simctl', 'get_app_container', selected.id, appId]
    : ['-s', selected.id, 'shell', 'pm', 'path', appId];
  const result = execute(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0 || (selected.platform === 'android' && !String(result.stdout).includes('package:'))) {
    throw new Error(`QA application ${appId} is not installed on ${selected.id}.`);
  }
  return true;
}

function inspectDeviceMetadata(selected, appId, execute = spawnCommandSync) {
  if (selected.platform === 'ios') {
    const os = execute('xcrun', ['simctl', 'getenv', selected.id, 'SIMULATOR_RUNTIME_VERSION'], { encoding: 'utf8' });
    const app = execute('xcrun', ['simctl', 'appinfo', selected.id, appId], { encoding: 'utf8' });
    const source = String(app.stdout || '');
    return {
      osVersion: String(os.stdout || '').trim() || null,
      appVersion: source.match(/CFBundleShortVersionString\s*=\s*"?([^";\n]+)/)?.[1]?.trim() || null,
      appBuild: source.match(/CFBundleVersion\s*=\s*"?([^";\n]+)/)?.[1]?.trim() || null,
    };
  }
  const os = execute('adb', ['-s', selected.id, 'shell', 'getprop', 'ro.build.version.release'], { encoding: 'utf8' });
  const app = execute('adb', ['-s', selected.id, 'shell', 'dumpsys', 'package', appId], { encoding: 'utf8' });
  const source = String(app.stdout || '');
  return {
    osVersion: String(os.stdout || '').trim() || null,
    appVersion: source.match(/versionName=([^\s]+)/)?.[1] || null,
    appBuild: source.match(/versionCode=(\d+)/)?.[1] || null,
  };
}

function resolveConfiguredDevice(mobile, requestedName, environment = process.env, options = {}) {
  const descriptors = mobile.devices || {};
  const names = Object.keys(descriptors);
  if (!requestedName) throw new Error(`Explicit device descriptor is required. Choose one of: ${names.join(', ')}`);
  const descriptor = descriptors[requestedName];
  if (!descriptor) throw new Error(`Unknown device descriptor ${requestedName}. Choose one of: ${names.join(', ')}`);
  const requestedId = environment[descriptor.idEnvKey];
  const devices = discoverDevices(descriptor.platform, options.execute);
  const selected = selectDiscoveredDevice(devices, requestedId, descriptor);
  if (options.requireInstalled !== false) assertAppInstalled(selected, descriptor.appId || mobile.appId, options.execute);
  const appId = descriptor.appId || mobile.appId;
  return {
    ...selected,
    descriptorName: requestedName,
    appId,
    launchUri: descriptor.launchUri || null,
    launchReadySelector: descriptor.launchReadySelector || null,
    launchReadyTimeoutMs: descriptor.launchReadyTimeoutMs || null,
    ...inspectDeviceMetadata(selected, appId, options.execute || spawnCommandSync),
  };
}

function validateDeviceDescriptors(mobile) {
  for (const [name, descriptor] of Object.entries(mobile.devices || {})) {
    if (!['ios', 'android'].includes(descriptor.platform)) throw new Error(`Device ${name} has an invalid platform.`);
    const allowedKinds = descriptor.platform === 'ios' ? ['simulator'] : ['emulator'];
    if (!allowedKinds.includes(descriptor.kind)) throw new Error(`Phase 0 device ${name} must be an iOS simulator or Android emulator.`);
    if (!descriptor.idEnvKey || !descriptor.appId) throw new Error(`Device ${name} requires idEnvKey and appId.`);
    if (descriptor.appId !== mobile.appId) throw new Error(`Device ${name} must target the manifest QA appId.`);
    if (descriptor.launchUri) {
      if (descriptor.platform !== 'android') throw new Error(`Device ${name} launchUri is currently supported only for Android.`);
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(descriptor.launchUri)) throw new Error(`Device ${name} launchUri must be an absolute application URI.`);
      if (!descriptor.launchReadySelector) throw new Error(`Device ${name} requires launchReadySelector when launchUri is configured.`);
      if (descriptor.launchReadyTimeoutMs != null && (!Number.isInteger(descriptor.launchReadyTimeoutMs) || descriptor.launchReadyTimeoutMs <= 0)) {
        throw new Error(`Device ${name} launchReadyTimeoutMs must be a positive integer.`);
      }
    }
  }
  return true;
}

module.exports = { assertAppInstalled, discoverDevices, inspectDeviceMetadata, parseAndroidDevices, parseIosDevices, resolveConfiguredDevice, selectDiscoveredDevice, validateDeviceDescriptors };
