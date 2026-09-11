const assert = require('node:assert/strict');
const { parseAndroidDevices, parseIosDevices, resolveConfiguredDevice, selectDiscoveredDevice } = require('../src/device-selection');

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

const mobile = { appId: 'com.merxus.mobile.qa', devices: { androidEmulator: { platform: 'android', kind: 'emulator', idEnvKey: 'ANDROID_ID', appId: 'com.merxus.mobile.qa' } } };
const calls = [];
const execute = (command, args) => {
  calls.push([command, args]);
  if (args[0] === 'devices') return { status: 0, stdout: androidText };
  return { status: 0, stdout: 'package:/data/app/base.apk' };
};
assert.equal(resolveConfiguredDevice(mobile, 'androidEmulator', { ANDROID_ID: 'emulator-5554' }, { execute }).id, 'emulator-5554');
assert.equal(calls[1][1][1], 'emulator-5554');
console.log('Cross-platform explicit device selection contract verified.');

