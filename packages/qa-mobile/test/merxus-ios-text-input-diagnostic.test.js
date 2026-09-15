const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { loadProductManifest } = require('../../qa-config/src');
const { validateMaestroConfiguration, selectFlows, buildBackendVerificationPlan, buildDeviceLaunchFlow } = require('../src/maestro-runner');

const config = validateMaestroConfiguration(loadProductManifest('merxus'));
const selected = selectFlows(config, { suite: 'diagnostic-ios-text-input' });
assert.equal(selected.length, 1);
const [flow] = selected;
assert.equal(flow.name, 'diagnostic-ios-text-input');
assert.equal(flow.fixtureScenario, 'phase2-settings-owner-b-isolation');
assert.equal(flow.account, 'user-b');
assert.equal(flow.mutationExpected, false);
assert.equal(flow.backendVerification, undefined, 'diagnostic probe must not run backend mutation verification');
assert.equal(buildBackendVerificationPlan(config, flow), null, 'diagnostic probe has no backend verification stage');
assert.deepEqual(flow.requiredEnv, [
  'MERXUS_MAESTRO_OWNER_B_EMAIL',
  'MERXUS_MAESTRO_OWNER_B_PASSWORD',
]);

const commands = YAML.parseAllDocuments(fs.readFileSync(flow.path, 'utf8'))[1].toJS();
const field = 'settings.sms.notification-retry-max-attempts';
const editIndex = commands.findIndex((command) => command.tapOn?.id === field);
assert.ok(editIndex >= 0, 'diagnostic target is present');
assert.deepEqual(commands.slice(editIndex, editIndex + 6), [
  { tapOn: { id: field, retryTapIfNoChange: true } },
  { pressKey: 'backspace' },
  { inputText: '3' },
  { assertVisible: { id: field, text: '^3$' } },
]);
assert.equal(commands[editIndex + 4], undefined, 'probe stops immediately after the draft assertion');

const serialized = JSON.stringify(commands);
assert.equal(commands.filter((command) => command.tapOn?.id === 'settings.sms.save').length, 0);
assert.equal(commands.filter((command) => command.tapOn?.id === 'settings.sms.reload').length, 0);
assert.doesNotMatch(JSON.stringify(commands.slice(editIndex)), /eraseText|hideKeyboard|WORKSIDEQA_CORRELATION|settings\.sms\.(request-id|operation-id|saved|reloaded)/);
assert.doesNotMatch(serialized, /WORKSIDEQA_CORRELATION|settings\.sms\.(request-id|operation-id|saved|reloaded)/);
assert.equal(commands.filter((command) => command.pressKey === 'backspace').length, 1);
assert.equal(commands.filter((command) => command.inputText === '3').length, 1);
assert.equal(commands.filter((command) => command.assertVisible?.id === field && command.assertVisible.text === '^2$').length, 1);
assert.equal(commands.filter((command) => command.assertVisible?.id === field && command.assertVisible.text === '^3$').length, 1);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-ios-text-input-'));
try {
  const runtime = buildDeviceLaunchFlow(flow, {
    ...config.mobile.devices.iosSimulator,
    id: 'diagnostic-ios-udid',
    descriptorName: 'iosSimulator',
  }, path.join(directory, 'runtime.yaml'));
  assert.equal(runtime.stages.length, 3, 'iOS uses the existing split login/overlay/resume architecture');
  const resumePath = runtime.stages[2].path;
  const resumeCommands = YAML.parseAllDocuments(fs.readFileSync(resumePath, 'utf8'))[1].toJS();
  const generatedEditIndex = resumeCommands.findIndex((command) => command.tapOn?.id === field);
  assert.ok(generatedEditIndex >= 0);
  assert.deepEqual(resumeCommands.slice(generatedEditIndex, generatedEditIndex + 4), [
    { tapOn: { id: field, retryTapIfNoChange: true } },
    { pressKey: 'backspace' },
    { inputText: '3' },
    { assertVisible: { id: field, text: '^3$' } },
  ]);
  assert.doesNotMatch(JSON.stringify(resumeCommands.slice(generatedEditIndex)), /eraseText|hideKeyboard|save|reload|WORKSIDEQA_CORRELATION/i);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('PASS: temporary iOS TextInput diagnostic probe is isolated, exact, and non-mutating');
