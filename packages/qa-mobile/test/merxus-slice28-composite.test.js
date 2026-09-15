const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { loadProductManifest } = require('../../qa-config/src');
const { buildDeviceLaunchFlow, selectFlows, validateMaestroConfiguration } = require('../src/maestro-runner');
const { evaluateComposite, validateComposite } = require('../src/merxus-slice28-certification');

const config = loadProductManifest('merxus');
const validated = validateMaestroConfiguration(config);
const composite = validateComposite(config);
assert.equal(composite.interaction.name, 'diagnostic-ios-text-input-focus-qahelper');
assert.equal(composite.persistence.name, '28-ios-owner-b-persistence');
assert.equal(composite.interaction.mutationExpected, false);
assert.equal(composite.persistence.mutationExpected, true);
assert.ok(composite.persistence.backendVerification);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-slice28-composite-'));
try {
  const ios = buildDeviceLaunchFlow(composite.persistence, { ...validated.mobile.devices.iosSimulator, id: 'slice28-ios' }, path.join(directory, 'ios.yaml'));
  assert.equal(ios.stages.length, 3);
  const resume = YAML.parseAllDocuments(fs.readFileSync(ios.stages[2].path, 'utf8'))[1].toJS();
  const ids = JSON.stringify(resume);
  assert.ok(ids.includes('settings.sms.qa-focus-notification-retry-max-attempts'));
  assert.ok(ids.includes('settings.sms.save'));
  assert.ok(ids.includes('settings.sms.qa-reload'));
  assert.ok(ids.includes('settings.sms.qa-reload-state'));
  assert.ok(ids.includes('settings.sms.qa-notification-retry-max-attempts-value'));
  assert.ok(ids.includes('WORKSIDEQA_CORRELATION='));
  assert.ok(resume.some((command) => command.assertVisible?.id === 'settings.sms.qa-notification-retry-max-attempts-value' && command.assertVisible.text === '^3$'));
  assert.equal(resume.some((command) => command.extendedWaitUntil?.visible?.id === 'settings.sms.reloaded'), false);
  assert.equal(resume.some((command) => command.tapOn?.id === 'settings.sms.reload'), false);

  const android = buildDeviceLaunchFlow(composite.persistence, { ...validated.mobile.devices.androidEmulator, id: 'emulator-5554' }, path.join(directory, 'android.yaml'));
  const androidCommands = YAML.parseAllDocuments(fs.readFileSync(android.path, 'utf8'))[1].toJS();
  assert.equal(androidCommands.filter((command) => command.tapOn?.id === 'settings.sms.reload').length, 1);
  assert.equal(androidCommands.filter((command) => command.tapOn?.id === 'settings.sms.qa-reload').length, 0);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

const backendExecution = { results: [{ status: 'passed', stages: { backend: { status: 'passed' } }, authoritativeResult: {
  mutationExpected: true, tenantAUnchanged: true, crossTenantLeakageCount: 0,
  revision: 2, successAuditCount: 1, operationReceiptCount: 1,
  externalProviderInvocationCount: 0, blockedProviderAttemptCount: 0,
  requestId: 'request-1', operationId: 'operation-1',
} }] };
assert.equal(evaluateComposite([{ key: 'interaction', status: 'passed' }, { key: 'persistence', status: 'passed', execution: backendExecution }]).certified, true);
assert.equal(evaluateComposite([{ key: 'interaction', status: 'failed' }, { key: 'persistence', status: 'passed', execution: backendExecution }]).certified, false);
assert.equal(evaluateComposite([{ key: 'interaction', status: 'passed' }, { key: 'persistence', status: 'failed', execution: backendExecution }]).certified, false);
assert.equal(evaluateComposite([{ key: 'interaction', status: 'passed' }, { key: 'persistence', status: 'passed', execution: { results: [{ status: 'passed', stages: { backend: { status: 'failed' } } }] } }]).certified, false);
assert.equal(evaluateComposite([{ key: 'interaction', status: 'passed' }, { key: 'persistence', status: 'passed', execution: { results: [{ status: 'passed', stages: { backend: { status: 'passed' } }, authoritativeResult: { ...backendExecution.results[0].authoritativeResult, mutationExpected: false } }] } }]).certified, false);
assert.equal(evaluateComposite([{ key: 'interaction', status: 'passed' }, { key: 'persistence', status: 'passed', execution: { results: [{ status: 'passed', stages: { backend: { status: 'passed' } }, authoritativeResult: { ...backendExecution.results[0].authoritativeResult, operationId: null } }] } }]).certified, false);
assert.deepEqual(selectFlows(validated, { suite: 'phase2-owner-b-isolation' }).map((flow) => flow.name), ['28-tenant-settings-owner-b-isolation'], 'Android monolithic flow remains unchanged');
console.log('PASS Slice 28 iOS composite certification contract and Android preservation');
