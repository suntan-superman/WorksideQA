const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { loadProductManifest } = require('../../qa-config/src');
const {
  validateMaestroConfiguration,
  selectFlows,
  buildBackendVerificationPlan,
  buildDeviceLaunchFlow,
} = require('../src/maestro-runner');

const config = validateMaestroConfiguration(loadProductManifest('merxus'));
const selected = selectFlows(config, { suite: 'diagnostic-ios-text-input-focus-qahelper' });
assert.equal(selected.length, 1);
const [flow] = selected;
assert.equal(flow.name, 'diagnostic-ios-text-input-focus-qahelper');
assert.equal(flow.fixtureScenario, 'phase2-settings-owner-b-isolation');
assert.equal(flow.account, 'user-b');
assert.equal(flow.mutationExpected, false);
assert.equal(flow.backendVerification, undefined);
assert.equal(buildBackendVerificationPlan(config, flow), null, 'focus-helper probe has no backend verification stage');
assert.deepEqual(flow.requiredEnv, [
  'MERXUS_MAESTRO_OWNER_B_EMAIL',
  'MERXUS_MAESTRO_OWNER_B_PASSWORD',
]);

const field = 'settings.sms.notification-retry-max-attempts';
const oracle = 'settings.sms.qa-notification-retry-max-attempts-value';
const commands = YAML.parseAllDocuments(fs.readFileSync(flow.path, 'utf8'))[1].toJS();
const initialValueWait = { extendedWaitUntil: { visible: { id: oracle, text: '^2$' }, timeout: 5000 } };
const initialValue = { assertVisible: { id: oracle, text: '^2$' } };
const smsOpenIndex = commands.findIndex((command) => command.tapOn?.id === 'settings.sms.open');
assert.ok(smsOpenIndex >= 0);
const targetTail = commands.slice(smsOpenIndex + 1);
assert.deepEqual(targetTail, [initialValueWait, initialValue]);
assert.equal(flow.iosFocusReadiness, undefined);
assert.equal(commands.filter((command) => command.tapOn?.id === field).length, 0);
assert.equal(commands.filter((command) => command.tapOn?.id === 'settings.sms.qa-focus-notification-retry-max-attempts').length, 0);
assert.equal(commands.filter((command) => command.tapOn?.id === 'settings.sms.save' || command.tapOn?.id === 'settings.sms.reload').length, 0);
assert.equal(commands.filter((command) => command.inputText).length, 2, 'Component A only inputs credentials');
assert.equal(commands.filter((command) => command.pressKey || command.eraseText).length, 2, 'Component A only resets credentials');
assert.equal(JSON.stringify(targetTail).includes(field), false, 'Component A does not depend on real retry-max accessibility discovery');
assert.doesNotMatch(JSON.stringify(targetTail), /qa-focus|focused|Backspace|inputText|save|reload|WORKSIDEQA_CORRELATION|backend|revision|audit|receipt/i);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-ios-text-input-focus-qahelper-'));
try {
  const runtime = buildDeviceLaunchFlow(flow, {
    ...config.mobile.devices.iosSimulator,
    id: 'diagnostic-focus-helper-ios-udid',
    descriptorName: 'iosSimulator',
  }, path.join(directory, 'runtime.yaml'));
  assert.equal(runtime.stages.length, 3, 'focus-helper probe uses the existing iOS split architecture');
  const resumeCommands = YAML.parseAllDocuments(fs.readFileSync(runtime.stages[2].path, 'utf8'))[1].toJS();
  const generatedIndex = resumeCommands.findIndex((command) => command.tapOn?.id === 'settings.sms.open');
  assert.ok(generatedIndex >= 0);
  const generatedTail = resumeCommands.slice(generatedIndex + 1);
  assert.deepEqual(generatedTail.slice(-2), [initialValueWait, initialValue]);
  assert.equal(generatedTail.some((command) => command.tapOn?.id === 'settings.sms.qa-focus-notification-retry-max-attempts'), false);
  assert.equal(generatedTail.some((command) => command.extendedWaitUntil?.visible?.id === 'settings.sms.qa-focus-ready'), false);
  assert.equal(generatedTail.filter((command) => command.tapOn?.id === field || command.doubleTapOn?.id === field).length, 0);
  assert.equal(JSON.stringify(generatedTail).includes(field), false);
  assert.deepEqual(generatedTail.filter((command) => command.assertVisible?.id === oracle), [initialValue]);
  assert.doesNotMatch(JSON.stringify(generatedTail), /focused|qa-focus|save|reload|WORKSIDEQA_CORRELATION|backend|revision|audit|receipt/i);

  const androidDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-android-text-input-focus-qahelper-'));
  try {
    const androidRuntime = buildDeviceLaunchFlow(flow, {
      ...config.mobile.devices.androidEmulator,
      id: 'diagnostic-focus-helper-android',
      descriptorName: 'androidEmulator',
    }, path.join(androidDirectory, 'runtime.yaml'));
    const androidCommands = YAML.parseAllDocuments(fs.readFileSync(androidRuntime.path, 'utf8'))[1].toJS();
    assert.equal(androidCommands.some((command) => command.extendedWaitUntil?.visible?.id === 'settings.sms.qa-focus-ready'), false, 'Android does not wait for the iOS-only readiness marker');
    assert.equal(androidCommands.some((command) => command.tapOn?.id === 'settings.sms.qa-focus-notification-retry-max-attempts'), false, 'Android does not use the iOS focus helper');
  } finally {
    fs.rmSync(androidDirectory, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('PASS: temporary iOS SMS settings surface diagnostic is read-only and does not certify TextInput mutation');
