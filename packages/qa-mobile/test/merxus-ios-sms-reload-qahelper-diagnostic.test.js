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
const selected = selectFlows(config, { suite: 'diagnostic-ios-sms-reload-qahelper' });
assert.equal(selected.length, 1);
const [flow] = selected;
assert.equal(flow.name, 'diagnostic-ios-sms-reload-qahelper');
assert.equal(flow.fixtureScenario, 'phase2-settings-owner-b-isolation');
assert.equal(flow.account, 'user-b');
assert.equal(flow.mutationExpected, false);
assert.equal(flow.backendVerification, undefined);
assert.equal(buildBackendVerificationPlan(config, flow), null, 'reload-helper probe has no backend verification stage');
const field = 'settings.sms.notification-retry-max-attempts';
const state = 'settings.sms.qa-reload-state';
assert.deepEqual(flow.iosPostReloadValueOracle, {
  sourceId: field,
  oracleId: 'settings.sms.qa-notification-retry-max-attempts-value',
  completionStateId: state,
  completionState: 'hydrated',
});
assert.deepEqual(flow.requiredEnv, [
  'MERXUS_MAESTRO_OWNER_B_EMAIL',
  'MERXUS_MAESTRO_OWNER_B_PASSWORD',
]);

const source = fs.readFileSync(flow.path, 'utf8');
const commands = YAML.parseAllDocuments(source)[1].toJS();
const helper = 'settings.sms.qa-reload';
const reload = 'settings.sms.reload';
const save = 'settings.sms.save';
const scrollIndex = commands.findIndex((command) => command.scrollUntilVisible?.element?.id === field);
assert.ok(scrollIndex >= 0);
assert.deepEqual(commands.slice(scrollIndex, scrollIndex + 7), [
  { scrollUntilVisible: { element: { id: field }, direction: 'DOWN' } },
  { assertVisible: { id: field, text: '^2$' } },
  { assertVisible: { id: state, text: '^idle$' } },
  { tapOn: { id: helper } },
  { extendedWaitUntil: { visible: { id: state, text: '^hydrated$' }, timeout: 10000 } },
  { scrollUntilVisible: { element: { id: field }, direction: 'DOWN', timeout: 5000 } },
  { assertVisible: { id: field, text: '^2$' } },
]);
assert.equal(commands.filter((command) => command.tapOn?.id === helper).length, 1);
assert.equal(commands.filter((command) => command.tapOn?.id === reload).length, 0);
assert.equal(commands.filter((command) => command.tapOn?.id === save).length, 0);
const diagnosticTail = commands.slice(scrollIndex);
assert.doesNotMatch(JSON.stringify(diagnosticTail), /WORKSIDEQA_CORRELATION|request-id|operation-id|inputText|eraseText|pressKey|revision|audit|receipt/i);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-ios-sms-reload-qahelper-'));
try {
  const runtime = buildDeviceLaunchFlow(flow, {
    ...config.mobile.devices.iosSimulator,
    id: 'diagnostic-reload-helper-ios-udid',
    descriptorName: 'iosSimulator',
  }, path.join(directory, 'runtime.yaml'));
  assert.equal(runtime.stages.length, 3, 'reload-helper probe uses the existing iOS split architecture');
  const resumeCommands = YAML.parseAllDocuments(fs.readFileSync(runtime.stages[2].path, 'utf8'))[1].toJS();
  assert.equal(resumeCommands.filter((command) => command.tapOn?.id === helper).length, 1);
  assert.equal(resumeCommands.filter((command) => command.tapOn?.id === reload).length, 0);
  assert.equal(resumeCommands.filter((command) => command.tapOn?.id === save).length, 0);
  assert.equal(resumeCommands.filter((command) => command.extendedWaitUntil?.visible?.id === 'settings.sms.reloaded').length, 0, 'iOS diagnostic does not require the unreliable product marker');
  const generatedHydratedIndex = resumeCommands.findIndex((command) => command.extendedWaitUntil?.visible?.id === state && command.extendedWaitUntil.visible.text === '^hydrated$');
  assert.ok(generatedHydratedIndex >= 0);
  const generatedOracleAssertions = resumeCommands.slice(generatedHydratedIndex + 1).filter((command) => command.assertVisible?.id === 'settings.sms.qa-notification-retry-max-attempts-value');
  assert.deepEqual(generatedOracleAssertions, [{ assertVisible: { id: 'settings.sms.qa-notification-retry-max-attempts-value', text: '^2$' } }]);
  assert.equal(resumeCommands.slice(generatedHydratedIndex + 1).filter((command) => command.scrollUntilVisible?.element?.id === field).length, 0, 'final retry-max verification uses the QA value oracle without scrolling the omitted TextInput');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('PASS: temporary iOS SMS reload-helper diagnostic is read-only and invokes only the QA helper');
