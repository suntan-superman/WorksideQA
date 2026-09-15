const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { loadProductManifest } = require('../../qa-config/src');
const { validateMaestroConfiguration, selectFlows, buildBackendVerificationPlan, buildDeviceLaunchFlow } = require('../src/maestro-runner');

const config = validateMaestroConfiguration(loadProductManifest('merxus'));
const selected = selectFlows(config, { suite: 'diagnostic-ios-text-input-focus' });
assert.equal(selected.length, 1);
const [flow] = selected;
assert.equal(flow.name, 'diagnostic-ios-text-input-focus');
assert.equal(flow.fixtureScenario, 'phase2-settings-owner-b-isolation');
assert.equal(flow.account, 'user-b');
assert.equal(flow.mutationExpected, false);
assert.equal(flow.backendVerification, undefined);
assert.equal(buildBackendVerificationPlan(config, flow), null, 'focus probe has no backend verification stage');
assert.deepEqual(flow.requiredEnv, [
  'MERXUS_MAESTRO_OWNER_B_EMAIL',
  'MERXUS_MAESTRO_OWNER_B_PASSWORD',
]);

const field = 'settings.sms.notification-retry-max-attempts';
const commands = YAML.parseAllDocuments(fs.readFileSync(flow.path, 'utf8'))[1].toJS();
const targetScroll = {
  scrollUntilVisible: {
    element: { id: field },
    direction: 'DOWN',
    centerElement: true,
  },
};
const targetAssertion = { assertVisible: { id: field, text: '^2$' } };
const tap = { tapOn: { id: field, retryTapIfNoChange: true } };
const focusAssertion = { assertVisible: { id: field, focused: true } };
const scrollIndex = commands.findIndex((command) => command.scrollUntilVisible?.element?.id === field);
assert.ok(scrollIndex >= 0);
assert.deepEqual(commands.slice(scrollIndex, scrollIndex + 4), [targetScroll, targetAssertion, tap, focusAssertion]);
assert.deepEqual(commands.at(-1), focusAssertion, 'focus probe stops immediately after focused assertion');

const targetTail = commands.slice(scrollIndex);
assert.equal(targetTail.filter((command) => command.pressKey || command.inputText || command.eraseText || command.hideKeyboard).length, 0);
assert.equal(targetTail.filter((command) => command.doubleTapOn || command.longPressOn).length, 0);
assert.equal(commands.filter((command) => command.tapOn?.id === 'settings.sms.save').length, 0);
assert.equal(commands.filter((command) => command.tapOn?.id === 'settings.sms.reload').length, 0);
assert.doesNotMatch(JSON.stringify(commands), /WORKSIDEQA_CORRELATION|settings\.sms\.(request-id|operation-id|saved|reloaded)/);
assert.equal(commands.filter((command) => command.assertVisible?.id === field && command.assertVisible.focused === true).length, 1);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-ios-text-input-focus-'));
try {
  const runtime = buildDeviceLaunchFlow(flow, {
    ...config.mobile.devices.iosSimulator,
    id: 'diagnostic-focus-ios-udid',
    descriptorName: 'iosSimulator',
  }, path.join(directory, 'runtime.yaml'));
  assert.equal(runtime.stages.length, 3, 'focus probe uses the existing iOS login/overlay/resume architecture');
  const resumeCommands = YAML.parseAllDocuments(fs.readFileSync(runtime.stages[2].path, 'utf8'))[1].toJS();
  const generatedScrollIndex = resumeCommands.findIndex((command) => command.scrollUntilVisible?.element?.id === field);
  assert.ok(generatedScrollIndex >= 0);
  assert.deepEqual(resumeCommands.slice(generatedScrollIndex, generatedScrollIndex + 4), [targetScroll, targetAssertion, tap, focusAssertion]);
  assert.deepEqual(resumeCommands.at(-1), focusAssertion, 'generated iOS focus stage stops at focused assertion');
  assert.doesNotMatch(JSON.stringify(resumeCommands.slice(generatedScrollIndex)), /inputText|eraseText|pressKey|hideKeyboard|doubleTapOn|longPressOn|save|reload|WORKSIDEQA_CORRELATION/i);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('PASS: temporary iOS TextInput focus-only diagnostic probe is isolated and non-mutating');
