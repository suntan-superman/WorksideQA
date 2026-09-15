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
assert.deepEqual(flow.requiredEnv, [
  'MERXUS_MAESTRO_OWNER_B_EMAIL',
  'MERXUS_MAESTRO_OWNER_B_PASSWORD',
]);

const source = fs.readFileSync(flow.path, 'utf8');
const commands = YAML.parseAllDocuments(source)[1].toJS();
const field = 'settings.sms.notification-retry-max-attempts';
const state = 'settings.sms.qa-reload-state';
const helper = 'settings.sms.qa-reload';
const reload = 'settings.sms.reload';
const save = 'settings.sms.save';
const scrollIndex = commands.findIndex((command) => command.scrollUntilVisible?.element?.id === field);
assert.ok(scrollIndex >= 0);
assert.deepEqual(commands.slice(scrollIndex, scrollIndex + 8), [
  { scrollUntilVisible: { element: { id: field }, direction: 'DOWN', centerElement: true } },
  { assertVisible: { id: field, text: '^2$' } },
  { assertVisible: { id: state, text: '^idle$' } },
  { tapOn: { id: helper } },
  { extendedWaitUntil: { visible: { id: state, text: '^hydrated$' }, timeout: 10000 } },
  { extendedWaitUntil: { visible: { id: 'settings.sms.reloaded' }, timeout: 5000 } },
  { scrollUntilVisible: { element: { id: field }, direction: 'UP', timeout: 5000, centerElement: true } },
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
  assert.match(JSON.stringify(resumeCommands), /settings\.sms\.reloaded/);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('PASS: temporary iOS SMS reload-helper diagnostic is read-only and invokes only the QA helper');
