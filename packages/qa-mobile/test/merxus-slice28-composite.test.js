const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { loadProductManifest } = require('../../qa-config/src');
const { buildDeviceLaunchFlow, selectFlows, validateMaestroConfiguration } = require('../src/maestro-runner');
const { COMPONENTS, evaluateComposite, validateComposite } = require('../src/merxus-slice28-certification');

const config = loadProductManifest('merxus');
const validated = validateMaestroConfiguration(config);
const composite = validateComposite(config);
assert.equal(composite.interaction.name, 'diagnostic-ios-text-input-focus-qahelper');
assert.equal(composite.persistence.name, '28-ios-owner-b-persistence');
assert.equal(composite.interaction.mutationExpected, false);
assert.equal(composite.persistence.mutationExpected, true);
assert.ok(composite.persistence.backendVerification);
assert.deepEqual(composite.persistence.iosIntegration, {
  account: 'user-b', method: 'PATCH', readPath: '/api/sms/settings', mutationPath: '/api/sms/settings',
  field: 'notificationRetryMaxAttempts', before: 2, after: 3,
});
assert.equal(COMPONENTS[0].label, 'A. iOS SMS settings interaction surface');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-slice28-composite-'));
try {
  const interactionIos = buildDeviceLaunchFlow(composite.interaction, { ...validated.mobile.devices.iosSimulator, id: 'slice28-interaction-ios' }, path.join(directory, 'interaction-ios.yaml'));
  const interactionCommands = YAML.parseAllDocuments(fs.readFileSync(interactionIos.stages[2].path, 'utf8'))[1].toJS();
  assert.ok(interactionCommands.some((command) => command.assertVisible?.id === 'settings.sms.qa-notification-retry-max-attempts-value' && command.assertVisible.text === '^2$'));
  assert.equal(interactionCommands.some((command) => command.tapOn?.id === 'settings.sms.qa-focus-notification-retry-max-attempts'), false);
  assert.equal(interactionCommands.some((command) => command.extendedWaitUntil?.visible?.id === 'settings.sms.qa-focus-ready'), false);
  assert.equal(interactionCommands.some((command) => command.inputText === '3'), false);
  assert.equal(interactionCommands.some((command) => command.tapOn?.id === 'settings.sms.save' || command.tapOn?.id === 'settings.sms.reload'), false);

  assert.equal(composite.persistence.iosIntegration.method, 'PATCH');
  assert.equal(composite.persistence.iosIntegration.mutationPath, '/api/sms/settings');
  assert.equal(composite.persistence.iosIntegration.readPath, '/api/sms/settings');
  assert.equal(composite.persistence.iosIntegration.before, 2);
  assert.equal(composite.persistence.iosIntegration.after, 3);

  const androidFlow = selectFlows(validated, { suite: 'phase2-owner-b-isolation' })[0];
  const android = buildDeviceLaunchFlow(androidFlow, { ...validated.mobile.devices.androidEmulator, id: 'emulator-5554' }, path.join(directory, 'android.yaml'));
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
const passing = evaluateComposite([{ key: 'interaction', status: 'passed' }, { key: 'persistence', status: 'passed', execution: backendExecution }]);
assert.equal(passing.certified, true);
for (const key of ['interaction', 'persistence', 'backend', 'mutationContract', 'correlation', 'tenantIsolation', 'revisionAuditReceipt', 'providerZero']) assert.equal(passing.evidence[key], 'passed');

const interactionFailed = evaluateComposite([{ key: 'interaction', status: 'failed', stage: 'ui', reason: 'iOS SMS settings surface did not become available' }, { key: 'persistence', status: 'passed', execution: backendExecution }]);
assert.equal(interactionFailed.certified, false);
assert.equal(interactionFailed.evidence.interaction, 'failed');
assert.equal(interactionFailed.evidence.backend, 'passed', 'valid independent persistence backend evidence is preserved');
assert.equal(interactionFailed.evidence.tenantIsolation, 'passed');

const persistenceFailed = evaluateComposite([{ key: 'interaction', status: 'passed' }, { key: 'persistence', status: 'failed', stage: 'ui', reason: 'settings.sms.save not visible' }]);
assert.equal(persistenceFailed.certified, false);
for (const key of ['backend', 'mutationContract', 'correlation', 'tenantIsolation', 'revisionAuditReceipt', 'providerZero']) assert.equal(persistenceFailed.evidence[key], 'blocked');

const bothFailed = evaluateComposite([{ key: 'interaction', status: 'failed' }, { key: 'persistence', status: 'failed' }]);
assert.equal(bothFailed.certified, false);
for (const key of ['backend', 'mutationContract', 'correlation', 'tenantIsolation', 'revisionAuditReceipt', 'providerZero']) assert.equal(bothFailed.evidence[key], 'blocked');

const verifierFailed = evaluateComposite([{ key: 'interaction', status: 'passed' }, { key: 'persistence', status: 'failed', execution: { results: [{ status: 'failed', stages: { backend: { status: 'failed' } }, failureStage: 'backend' }] } }]);
assert.equal(verifierFailed.certified, false);
for (const key of ['backend', 'mutationContract', 'correlation', 'tenantIsolation', 'revisionAuditReceipt', 'providerZero']) assert.equal(verifierFailed.evidence[key], 'failed');

const backendNotRun = evaluateComposite([{ key: 'interaction', status: 'passed' }, { key: 'persistence', status: 'passed', execution: { results: [{ status: 'passed', stages: { backend: { status: 'not-run' } } }] } }]);
assert.equal(backendNotRun.certified, false);
for (const key of ['backend', 'mutationContract', 'correlation', 'tenantIsolation', 'revisionAuditReceipt', 'providerZero']) assert.equal(backendNotRun.evidence[key], 'not-run');

assert.equal(evaluateComposite([{ key: 'interaction', status: 'passed' }, { key: 'persistence', status: 'passed', execution: { results: [{ status: 'passed', stages: { backend: { status: 'passed' } }, authoritativeResult: { ...backendExecution.results[0].authoritativeResult, mutationExpected: false } }] } }]).certified, false);
assert.equal(evaluateComposite([{ key: 'interaction', status: 'passed' }, { key: 'persistence', status: 'passed', execution: { results: [{ status: 'passed', stages: { backend: { status: 'passed' } }, authoritativeResult: { ...backendExecution.results[0].authoritativeResult, operationId: null } }] } }]).certified, false);
assert.deepEqual(selectFlows(validated, { suite: 'phase2-owner-b-isolation' }).map((flow) => flow.name), ['28-tenant-settings-owner-b-isolation'], 'Android monolithic flow remains unchanged');
console.log('PASS Slice 28 iOS composite certification contract and Android preservation');
