const assert = require('node:assert/strict');
const { parseAndroidDevices, parseIosDevices, resolveConfiguredDevice, selectDiscoveredDevice, validateDeviceDescriptors } = require('../src/device-selection');

const iosJson = JSON.stringify({ devices: { runtime: [
  { udid: 'IOS-A', name: 'iPhone QA', state: 'Booted', isAvailable: true },
  { udid: 'IOS-B', name: 'iPhone QA', state: 'Shutdown', isAvailable: true },
] } });
const androidText = 'List of devices attached\nemulator-5554 device product:sdk model:Pixel_QA\nPHONE device model:Phone\n';
assert.equal(parseIosDevices(iosJson).length, 2);
assert.equal(parseAndroidDevices(androidText)[0].kind, 'emulator');
assert.equal(selectDiscoveredDevice(parseIosDevices(iosJson), 'IOS-A', { platform: 'ios', kind: 'simulator', idEnvKey: 'IOS_ID' }).id, 'IOS-A');
assert.throws(() => selectDiscoveredDevice(parseIosDevices(iosJson), 'missing', { platform: 'ios', kind: 'simulator', idEnvKey: 'IOS_ID' }), /does not exist/);
assert.throws(() => selectDiscoveredDevice(parseIosDevices(iosJson), 'iPhone QA', { platform: 'ios', kind: 'simulator', idEnvKey: 'IOS_ID' }), /ambiguous/);
assert.throws(() => selectDiscoveredDevice(parseAndroidDevices(androidText), 'PHONE', { platform: 'android', kind: 'emulator', idEnvKey: 'ANDROID_ID' }), /does not match/);

const launchUri = 'exp+merxus-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081';
const mobile = { appId: 'com.merxus.mobile.qa', devices: { androidEmulator: { platform: 'android', kind: 'emulator', idEnvKey: 'ANDROID_ID', appId: 'com.merxus.mobile.qa', launchUri, launchReadySelector: 'qa-environment-root' } } };
const calls = [];
const execute = (command, args) => {
  calls.push([command, args]);
  if (args[0] === 'devices') return { status: 0, stdout: androidText };
  return { status: 0, stdout: 'package:/data/app/base.apk' };
};
const resolved = resolveConfiguredDevice(mobile, 'androidEmulator', { ANDROID_ID: 'emulator-5554' }, { execute });
assert.equal(resolved.id, 'emulator-5554');
assert.equal(resolved.launchUri, launchUri);
assert.equal(resolved.launchReadySelector, 'qa-environment-root');
assert.equal(calls[1][1][1], 'emulator-5554');
const iosCalls = [];
const executeIos = (command, args) => {
  iosCalls.push([command, args]);
  if (args.slice(0, 4).join(' ') === 'simctl list devices --json') return { status: 0, stdout: iosJson };
  if (args[1] === 'getenv') return { status: 0, stdout: '26.0\n' };
  if (args[1] === 'appinfo') return { status: 0, stdout: 'CFBundleShortVersionString = 1.0;\nCFBundleVersion = 1;' };
  return { status: 0, stdout: '' };
};
const iosMobile = { appId: mobile.appId, devices: { iosSimulator: { platform: 'ios', kind: 'simulator', idEnvKey: 'IOS_ID', appId: mobile.appId, runtimeTimeoutMultiplier: 1.5 } } };
const resolvedIos = resolveConfiguredDevice(iosMobile, 'iosSimulator', { IOS_ID: 'IOS-A' }, { execute: executeIos });
assert.equal(resolvedIos.id, 'IOS-A');
assert.equal(resolvedIos.runtimeTimeoutMultiplier, 1.5);
assert.ok(iosCalls.every(([, args]) => !args.includes('IOS-B')));
assert.equal(validateDeviceDescriptors(mobile), true);
assert.equal(validateDeviceDescriptors({ ...mobile, devices: { iosSimulator: { platform: 'ios', kind: 'simulator', idEnvKey: 'IOS_ID', appId: mobile.appId, launchUri, launchReadySelector: 'qa-environment-root', launchDismissIfVisible: ['Continue', 'Close'] } } }), true);
assert.equal(validateDeviceDescriptors({ ...mobile, devices: { iosSimulator: { platform: 'ios', kind: 'simulator', idEnvKey: 'IOS_ID', appId: mobile.appId, runtimeTimeoutMultiplier: 1.5 } } }), true);
assert.throws(() => validateDeviceDescriptors({ ...mobile, devices: { androidEmulator: { ...mobile.devices.androidEmulator, runtimeTimeoutMultiplier: 1.5 } } }), /only for iOS simulators/);
assert.throws(() => validateDeviceDescriptors({ ...mobile, devices: { iosSimulator: { platform: 'ios', kind: 'simulator', idEnvKey: 'IOS_ID', appId: mobile.appId, runtimeTimeoutMultiplier: 0.5 } } }), /greater than or equal to 1/);
assert.throws(() => validateDeviceDescriptors({ ...mobile, devices: { iosDevice: { platform: 'ios', kind: 'physical', idEnvKey: 'IOS_ID', appId: mobile.appId, launchUri, launchReadySelector: 'qa-environment-root' } } }), /iOS simulator/);
assert.throws(() => validateDeviceDescriptors({ ...mobile, devices: { androidEmulator: { ...mobile.devices.androidEmulator, launchReadySelector: '' } } }), /requires launchReadySelector/);
assert.throws(() => validateDeviceDescriptors({ ...mobile, devices: { iosSimulator: { platform: 'ios', kind: 'simulator', idEnvKey: 'IOS_ID', appId: mobile.appId, launchUri, launchReadySelector: '' } } }), /requires launchReadySelector/);
assert.throws(() => validateDeviceDescriptors({ ...mobile, devices: { androidEmulator: { ...mobile.devices.androidEmulator, launchDismissIfVisible: 'Continue' } } }), /only for iOS simulators/);
assert.throws(() => validateDeviceDescriptors({ ...mobile, devices: { iosSimulator: { platform: 'ios', kind: 'simulator', idEnvKey: 'IOS_ID', appId: mobile.appId, launchUri, launchReadySelector: 'qa-environment-root', launchDismissIfVisible: [] } } }), /one or more non-empty accessibility labels/);
assert.throws(() => validateDeviceDescriptors({ ...mobile, devices: { iosSimulator: { platform: 'ios', kind: 'simulator', idEnvKey: 'IOS_ID', appId: mobile.appId, launchUri, launchReadySelector: 'qa-environment-root', launchDismissIfVisible: ['Continue', '  '] } } }), /one or more non-empty accessibility labels/);
const passwordDismissal = [{ afterTapId: 'auth.login.submit', visible: 'Save Password?', tap: 'Not Now' }];
assert.equal(validateDeviceDescriptors({ ...mobile, devices: { iosSimulator: { platform: 'ios', kind: 'simulator', idEnvKey: 'IOS_ID', appId: mobile.appId, launchUri, launchReadySelector: 'qa-environment-root', postActionDismissIfVisible: passwordDismissal } } }), true);
assert.throws(() => validateDeviceDescriptors({ ...mobile, devices: { androidEmulator: { ...mobile.devices.androidEmulator, postActionDismissIfVisible: passwordDismissal } } }), /only for iOS simulators/);
assert.throws(() => validateDeviceDescriptors({ ...mobile, devices: { iosSimulator: { platform: 'ios', kind: 'simulator', idEnvKey: 'IOS_ID', appId: mobile.appId, launchUri, launchReadySelector: 'qa-environment-root', postActionDismissIfVisible: [{ afterTapId: '', visible: 'Save Password?', tap: 'Not Now' }] } } }), /valid afterTapId, visible, and tap labels/);
const deterministicFields = [{ id: 'auth.login.email', secure: false, assertExact: true }, { id: 'auth.login.password', secure: true, assertExact: false }];
assert.equal(validateDeviceDescriptors({ ...mobile, devices: { iosSimulator: { platform: 'ios', kind: 'simulator', idEnvKey: 'IOS_ID', appId: mobile.appId, launchUri, launchReadySelector: 'qa-environment-root', deterministicTextEntry: deterministicFields } } }), true);
assert.throws(() => validateDeviceDescriptors({ ...mobile, devices: { androidEmulator: { ...mobile.devices.androidEmulator, deterministicTextEntry: deterministicFields } } }), /only for iOS simulators/);
assert.throws(() => validateDeviceDescriptors({ ...mobile, devices: { iosSimulator: { platform: 'ios', kind: 'simulator', idEnvKey: 'IOS_ID', appId: mobile.appId, launchUri, launchReadySelector: 'qa-environment-root', deterministicTextEntry: [{ id: '', assertExact: true }] } } }), /valid field IDs/);
assert.throws(() => validateDeviceDescriptors({ ...mobile, devices: { iosSimulator: { platform: 'ios', kind: 'simulator', idEnvKey: 'IOS_ID', appId: mobile.appId, launchUri, launchReadySelector: 'qa-environment-root', deterministicTextEntry: [{ id: 'auth.login.password', secure: true, assertExact: true }] } } }), /valid field IDs/);
console.log('Cross-platform explicit device selection contract verified.');
