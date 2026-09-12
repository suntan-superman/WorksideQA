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
assert.equal(navigation.length, 2);
assert.doesNotMatch(source, /\b(?:repeat|swipe|longPressOn):/, 'no brute-force or coordinate navigation');
for (const [index, helper, target] of [
  [0, 'settings.sms.qa-scroll-to-save', 'settings.sms.save'],
  [1, 'settings.sms.qa-scroll-to-business-name', 'settings.sms.business-name'],
]) {
  const offset = commands.indexOf(navigation[index]);
  assert.deepEqual(commands[offset], { tapOn: { id: helper } });
  assert.deepEqual(commands[offset + 1], { extendedWaitUntil: { visible: { id: target }, timeout: 5000 } });
  assert.equal(commands[offset + 2].assertVisible.id, target);
  assert.equal(commands[offset + 2].assertVisible.optional, undefined, 'missing target must fail closed');
}
const editIndex = commands.findIndex((command) => command.tapOn?.id === 'settings.sms.business-name');
assert.deepEqual(commands.slice(editIndex, editIndex + 5), [
  { tapOn: { id: 'settings.sms.business-name' } },
  { eraseText: 100 },
  { inputText: 'Merxus Maestro Tenant A QA Branding' },
  { assertVisible: { id: 'settings.sms.business-name', text: '^Merxus Maestro Tenant A QA Branding$' } },
  'hideKeyboard',
], 'business-name input, exact assertion and keyboard dismissal remain unchanged');
assert.equal(commands[editIndex + 5], navigation[0]);
const saveTap = commands.findIndex((command) => command.tapOn?.id === 'settings.sms.save');
assert.deepEqual(commands[saveTap], { tapOn: { id: 'settings.sms.save' } }, 'Save tap must be semantic, never coordinates');
assert.equal(saveTap, commands.indexOf(navigation[0]) + 3);
assert.equal(commands[commands.indexOf(navigation[1]) - 1].extendedWaitUntil.visible.id, 'settings.sms.reloaded');
assert.deepEqual(commands[commands.indexOf(navigation[1]) + 2], { assertVisible: { id: 'settings.sms.business-name', text: '^Merxus Maestro Tenant A QA Branding$' } });
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
  assert.deepEqual(iosResume.filter(isQaNavigation), navigation, 'iOS resume preserves common semantic navigation');
  const android = buildDeviceLaunchFlow(flow, { ...config.mobile.devices.androidEmulator, id: 'emulator-5554', descriptorName: 'androidEmulator' }, path.join(directory, 'android.yaml'));
  const androidCommands = YAML.parseAllDocuments(fs.readFileSync(android.path, 'utf8'))[1].toJS();
  assert.deepEqual(androidCommands.filter(isQaNavigation), navigation, 'Android runtime preserves semantic shortcuts');
  const result = { ok: true, generation: 'generation-1', ...flow.authoritativeResult, requestId: 'request-1', operationId: 'operation-1' };
  const ui = 'WORKSIDEQA_CORRELATION={"requestId":"request-1","operationId":"operation-1"}';
  assert.equal(parseAuthoritativeResult(JSON.stringify(result), flow.authoritativeResult, ui, 'generation-1').successAuditCount, 1);
  for (const extra of [{ successAuditCount: 2 }, { crossTenantLeakageCount: undefined }, { externalProviderInvocationCount: 1 }, { generation: 'stale' }, { requestId: 'wrong' }]) assert.throws(() => parseAuthoritativeResult(JSON.stringify({ ...result, ...extra }), flow.authoritativeResult, ui, 'generation-1'));
  assert.throws(() => parseAuthoritativeResult(JSON.stringify(result), flow.authoritativeResult, '', 'generation-1'));
  console.log('PASS Merxus Phase 2 isolated flow, certified iOS split, authoritative counters and UI correlation contracts');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
