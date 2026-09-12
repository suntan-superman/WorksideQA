const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { loadProductManifest } = require('../../qa-config/src');
const { validateMaestroConfiguration, selectFlows, buildDeviceLaunchFlow } = require('../src/maestro-runner');
const { parseAuthoritativeResult } = require('../src/authoritative-result');
const config = validateMaestroConfiguration(loadProductManifest('merxus'));
const flows = selectFlows(config, { suite: 'phase2-settings' });
assert.equal(flows.length, 1);
const flow = flows[0];
assert.equal(flow.name, '21-tenant-settings-update-owner-a');
const source = fs.readFileSync(flow.path, 'utf8');
assert.ok(!/maestro.platform|Save Password|Not Now|10\.0\.2\.2/.test(source));
for (const id of ['settings.sms.saved', 'settings.sms.request-id', 'settings.sms.operation-id', 'settings.sms.reload']) assert.ok(source.includes(id));
assert.ok(!source.includes('settings.sms.test'));
const commands = YAML.parseAllDocuments(source)[1].toJS();
const isQaNavigation = (command) => command?.tapOn?.id?.startsWith('settings.sms.qa-scroll-to-');
const navigation = commands.filter(isQaNavigation);
assert.equal(navigation.length, 0, 'ordinary navigation is attempted before retaining shortcut usage');
assert.doesNotMatch(source, /qa-scroll-to-business-name|settings\.sms\.business-name|QA Branding/);
assert.doesNotMatch(source, /\b(?:repeat|swipe|longPressOn):/, 'no brute-force or coordinate navigation');
const field = 'settings.sms.daily-digest-time';
const editIndex = commands.findIndex((command) => command.tapOn?.id === field);
assert.deepEqual(commands[editIndex - 1], { assertVisible: { id: field, text: '^18:00$' } });
assert.deepEqual(commands.slice(editIndex, editIndex + 5), [
  { tapOn: { id: field } }, { eraseText: 100 }, { inputText: '18:30' },
  { assertVisible: { id: field, text: '^18:30$' } }, 'hideKeyboard',
]);
for (const [id, direction] of [[field, 'DOWN'], ['settings.sms.save', 'DOWN'], [field, 'UP']]) {
  const scroll = commands.find((command) => command.scrollUntilVisible?.element?.id === id && command.scrollUntilVisible.direction === direction);
  assert.ok(scroll);
  assert.equal(scroll.scrollUntilVisible.timeout, 20000, 'semantic traversal is bounded');
}
const saveTap = commands.findIndex((command) => command.tapOn?.id === 'settings.sms.save');
assert.deepEqual(commands[saveTap], { tapOn: { id: 'settings.sms.save' } });
assert.deepEqual(commands[saveTap - 1], { assertVisible: { id: 'settings.sms.save', enabled: true } });
assert.deepEqual(commands.at(-1), { assertVisible: { id: field, text: '^18:30$' } });
assert.ok(commands.findIndex((command) => command.tapOn?.id === 'settings.sms.reload') > saveTap);
assert.equal(flow.backendVerification, 'phase2-settings-update-owner-a');
assert.equal(flow.fixtureScenario, 'phase2-settings-update-owner-a');
assert.equal(flow.account, 'user-a');
assert.equal(flow.timeoutMs, 180000, 'settings workflow has its own explicit logical runtime');
assert.deepEqual(flow.authoritativeResult, {
  externalProviderInvocationCount: 0, blockedProviderAttemptCount: 0,
  crossTenantLeakageCount: 0, successAuditCount: 1, operationReceiptCount: 1,
  tenantBUnchanged: true, revision: 2,
}, 'backend mutation/audit/idempotency verification contract is unchanged');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-settings-'));
try {
  const ios = buildDeviceLaunchFlow(flow, { ...config.mobile.devices.iosSimulator, id: 'explicit-udid', descriptorName: 'iosSimulator' }, path.join(directory, 'runtime.yaml'));
  assert.equal(ios.stages.length, 3);
  assert.ok(ios.launchPlan.launchArgs.includes('explicit-udid'));
  assert.ok(!fs.readFileSync(ios.stages[0].path, 'utf8').includes('eraseText'));
  assert.ok(!fs.readFileSync(ios.stages[0].path, 'utf8').includes('Save Password'));
  const iosResume = YAML.parseAllDocuments(fs.readFileSync(ios.stages[2].path, 'utf8'))[1].toJS();
  const dismissalId = 'settings.sms.qa-dismiss-keyboard';
  const iosEditIndex = iosResume.findIndex((command) => command.tapOn?.id === field);
  assert.deepEqual(iosResume.slice(iosEditIndex, iosEditIndex + 5), [
    { tapOn: { id: field } }, { eraseText: 100 }, { inputText: '18:30' },
    { assertVisible: { id: field, text: '^18:30$' } }, { tapOn: { id: dismissalId } },
  ], 'iOS dismisses semantically only after the exact daily digest edit');
  const originalStages = ios.stages.map((stage) => fs.readFileSync(stage.path, 'utf8'));
  const unconfigured = { ...config.mobile.devices.iosSimulator, id: 'explicit-udid' };
  delete unconfigured.keyboardDismissAfterEdit;
  const baselineIos = buildDeviceLaunchFlow(flow, unconfigured, path.join(directory, 'baseline', 'runtime.yaml'));
  const baselineStages = baselineIos.stages.map((stage) => fs.readFileSync(stage.path, 'utf8'));
  assert.equal(originalStages[0], baselineStages[0], 'login remains byte-for-byte unchanged');
  assert.equal(originalStages[1], baselineStages[1], 'external overlay remains byte-for-byte unchanged');
  const baselineResume = YAML.parseAllDocuments(baselineStages[2])[1].toJS();
  baselineResume[iosEditIndex + 4] = { tapOn: { id: dismissalId } };
  assert.deepEqual(iosResume, baselineResume, 'exactly one resume command changes; no coordinates, sleeps, timeouts or mutations added');
  for (const phase1Flow of selectFlows(config, { suite: 'phase1' })) {
    const before = buildDeviceLaunchFlow(phase1Flow, unconfigured, path.join(directory, 'phase1-before', 'runtime.yaml'));
    const beforeContents = before.stages.map((stage) => fs.readFileSync(stage.path, 'utf8'));
    const after = buildDeviceLaunchFlow(phase1Flow, { ...config.mobile.devices.iosSimulator, id: 'explicit-udid' }, path.join(directory, 'phase1-after', 'runtime.yaml'));
    assert.deepEqual(after.stages.map((stage) => fs.readFileSync(stage.path, 'utf8')), beforeContents, `${phase1Flow.name} unchanged`);
  }
  assert.deepEqual(iosResume.filter(isQaNavigation), navigation, 'iOS resume preserves common semantic navigation');
  const android = buildDeviceLaunchFlow(flow, { ...config.mobile.devices.androidEmulator, id: 'emulator-5554', descriptorName: 'androidEmulator' }, path.join(directory, 'android.yaml'));
  const androidCommands = YAML.parseAllDocuments(fs.readFileSync(android.path, 'utf8'))[1].toJS();
  assert.ok(!JSON.stringify(androidCommands).includes(dismissalId));
  const androidEditIndex = androidCommands.findIndex((command) => command.tapOn?.id === field);
  assert.deepEqual(androidCommands.slice(androidEditIndex, androidEditIndex + 5), commands.slice(editIndex, editIndex + 5), 'certified Android edit and hideKeyboard unchanged');
  assert.deepEqual(androidCommands.filter(isQaNavigation), navigation, 'Android runtime preserves semantic shortcuts');
  const result = { ok: true, generation: 'generation-1', ...flow.authoritativeResult, requestId: 'request-1', operationId: 'operation-1' };
  const ui = 'WORKSIDEQA_CORRELATION={"requestId":"request-1","operationId":"operation-1"}';
  assert.equal(parseAuthoritativeResult(JSON.stringify(result), flow.authoritativeResult, ui, 'generation-1').successAuditCount, 1);
  for (const extra of [{ successAuditCount: 2 }, { crossTenantLeakageCount: undefined }, { externalProviderInvocationCount: 1 }, { generation: 'stale' }, { requestId: 'wrong' }]) assert.throws(() => parseAuthoritativeResult(JSON.stringify({ ...result, ...extra }), flow.authoritativeResult, ui, 'generation-1'));
  assert.throws(() => parseAuthoritativeResult(JSON.stringify(result), flow.authoritativeResult, '', 'generation-1'));
  console.log('PASS Merxus Phase 2 isolated flow, certified iOS split, authoritative counters and UI correlation contracts');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }

// Retry slices reuse the certified flow, mutation verification, launch and
// correlation architecture; only the real field/value and fixture case differ.
for (const spec of [
  { suite: 'phase2-retry', name: '22-tenant-settings-retry-owner-a', scenario: 'phase2-settings-retry-owner-a', field: 'settings.sms.notification-retry-max-attempts', before: '2', after: '3' },
  { suite: 'phase2-retry-delay', name: '23-tenant-settings-retry-delay-owner-a', scenario: 'phase2-settings-retry-delay-owner-a', field: 'settings.sms.notification-retry-delay-minutes', before: '15', after: '20' },
]) {
  const retryFlows = selectFlows(config, { suite: spec.suite });
  assert.equal(retryFlows.length, 1);
  const retryFlow = retryFlows[0];
  assert.equal(retryFlow.name, spec.name);
  assert.equal(retryFlow.fixtureScenario, spec.scenario);
  assert.equal(retryFlow.backendVerification, retryFlow.fixtureScenario);
  assert.equal(retryFlow.timeoutMs, 180000);
  assert.deepEqual(retryFlow.authoritativeResult, flow.authoritativeResult);
  const retryField = spec.field;
  const expectedRetryCommands = JSON.parse(JSON.stringify(commands).replaceAll(field, retryField).replaceAll('18:00', spec.before).replaceAll('18:30', spec.after));
  const retryCommands = YAML.parseAllDocuments(fs.readFileSync(retryFlow.path, 'utf8'))[1].toJS();
  assert.deepEqual(retryCommands, expectedRetryCommands, 'same Save/reload/correlation and no enabling retry, Send SMS, scheduling or providers');
  const retryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-retry-'));
  try {
    const android = buildDeviceLaunchFlow(retryFlow, { ...config.mobile.devices.androidEmulator, id: 'emulator-5554' }, path.join(retryDirectory, 'android.yaml'));
    const androidCommands = YAML.parseAllDocuments(fs.readFileSync(android.path, 'utf8'))[1].toJS();
    const androidIndex = androidCommands.findIndex((command) => command.tapOn?.id === retryField);
    assert.deepEqual(androidCommands.slice(androidIndex, androidIndex + 5), [
      { tapOn: { id: retryField } }, { eraseText: 100 }, { inputText: spec.after },
      { assertVisible: { id: retryField, text: `^${spec.after}$` } }, 'hideKeyboard',
    ]);
    assert.ok(android.launchPlan.launchArgs.includes('emulator-5554'));
    const ios = buildDeviceLaunchFlow(retryFlow, { ...config.mobile.devices.iosSimulator, id: 'explicit-retry-udid' }, path.join(retryDirectory, 'ios.yaml'));
    assert.equal(ios.stages.length, 3);
    assert.ok(ios.launchPlan.launchArgs.includes('explicit-retry-udid'));
    const resume = YAML.parseAllDocuments(fs.readFileSync(ios.stages[2].path, 'utf8'))[1].toJS();
    const index = resume.findIndex((command) => command.tapOn?.id === retryField);
    assert.deepEqual(resume.slice(index, index + 6), [
      { tapOn: { id: retryField } }, { eraseText: 100 }, { inputText: spec.after },
      { assertVisible: { id: retryField, text: `^${spec.after}$` } },
      { scrollUntilVisible: { element: { id: 'settings.sms.qa-dismiss-keyboard' }, direction: 'UP', timeout: 5000 } },
      { tapOn: { id: 'settings.sms.qa-dismiss-keyboard' } },
    ]);
    assert.equal(resume.some((command) => command === 'hideKeyboard'), false);
    assert.ok(JSON.stringify(resume).includes('WORKSIDEQA_CORRELATION='));
    assert.ok(JSON.stringify(resume).includes('settings.sms.reload'));
    console.log(`PASS ${spec.suite}, safe real controls, existing iOS dismiss target, platform launch and correlation`);
  } finally { fs.rmSync(retryDirectory, { recursive: true, force: true }); }
}
