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
const helper = 'settings.sms.qa-focus-notification-retry-max-attempts';
const marker = 'settings.sms.qa-focus-notification-retry-max-attempts-state';
const commands = YAML.parseAllDocuments(fs.readFileSync(flow.path, 'utf8'))[1].toJS();
const initialValueWait = { extendedWaitUntil: { visible: { id: oracle, text: '^2$' }, timeout: 5000 } };
const initialValue = { assertVisible: { id: oracle, text: '^2$' } };
const initialFocus = { assertVisible: { id: marker, text: '^blurred$' } };
const focusPress = { tapOn: { id: helper } };
const focused = { assertVisible: { id: marker, text: '^focused$' } };
const input = { inputText: '3' };
const finalValue = { assertVisible: { id: oracle, text: '^3$' } };
const smsOpenIndex = commands.findIndex((command) => command.tapOn?.id === 'settings.sms.open');
assert.ok(smsOpenIndex >= 0);
const targetTail = commands.slice(smsOpenIndex + 1);
assert.deepEqual(targetTail.slice(0, 7), [initialValueWait, initialValue, initialFocus, focusPress, {
  extendedWaitUntil: { visible: { id: marker, text: '^focused$' }, timeout: 5000 },
}, { pressKey: 'backspace' }, input]);
assert.deepEqual(targetTail.slice(-2), [focused, finalValue]);
assert.equal(commands.filter((command) => command.tapOn?.id === helper).length, 1);
assert.equal(commands.filter((command) => command.inputText === '3').length, 1);
assert.equal(commands.filter((command) => command.pressKey === 'backspace').length, 1);
assert.equal(commands.filter((command) => command.tapOn?.id === field).length, 0);
assert.equal(commands.filter((command) => command.doubleTapOn?.id === field).length, 0);
assert.equal(commands.filter((command) => command.tapOn?.id === 'settings.sms.save' || command.tapOn?.id === 'settings.sms.reload').length, 0);
assert.equal(targetTail.filter((command) => command.hideKeyboard || command.eraseText).length, 0, 'probe does not dismiss or erase through Maestro');
assert.equal(JSON.stringify(targetTail).includes(field), false, 'Component A does not depend on real retry-max accessibility discovery');
assert.doesNotMatch(JSON.stringify(commands), /focused:\s*true|WORKSIDEQA_CORRELATION|request-id|operation-id|backend|revision|audit|receipt/i);

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
  assert.equal(generatedTail.filter((command) => command.tapOn?.id === helper).length, 1);
  assert.equal(generatedTail.filter((command) => command.inputText === '3').length, 1);
  assert.equal(generatedTail.filter((command) => command.tapOn?.id === field || command.doubleTapOn?.id === field).length, 0);
  assert.equal(JSON.stringify(generatedTail).includes(field), false);
  assert.ok(generatedTail.some((command) => command.assertVisible?.id === oracle && command.assertVisible.text === '^2$'));
  assert.ok(generatedTail.some((command) => command.assertVisible?.id === oracle && command.assertVisible.text === '^3$'));
  assert.doesNotMatch(JSON.stringify(generatedTail), /focused:\s*true|save|reload|WORKSIDEQA_CORRELATION|backend|revision|audit|receipt/i);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('PASS: temporary iOS TextInput QA focus-helper diagnostic is isolated and draft-only');
