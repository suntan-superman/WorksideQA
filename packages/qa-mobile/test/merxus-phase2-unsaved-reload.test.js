const assert = require('node:assert/strict');
const fs = require('node:fs');
const YAML = require('yaml');
const { loadProductManifest } = require('../../qa-config/src');
const { validateMaestroConfiguration, selectFlows, buildDeviceLaunchFlow } = require('../src/maestro-runner');
const { parseAuthoritativeResult } = require('../src/authoritative-result');

const config = validateMaestroConfiguration(loadProductManifest('merxus'));
const [flow] = selectFlows(config, { suite: 'phase2-unsaved-reload' });
assert.equal(flow.name, '25-tenant-settings-unsaved-reload-owner-a');
assert.equal(flow.mutationExpected, false);
assert.equal(flow.timeoutMs, 180000);
assert.equal(flow.authoritativeResult.correlationCount, 0);
const commands = YAML.parseAllDocuments(fs.readFileSync(flow.path, 'utf8'))[1].toJS();
const serialized = JSON.stringify(commands);
assert.equal(commands.filter((command) => command.tapOn?.id === 'settings.sms.save').length, 0, 'unsaved flow never saves');
assert.doesNotMatch(serialized, /WORKSIDEQA_CORRELATION|settings\.sms\.request-id|settings\.sms\.operation-id/);
assert.equal(commands.filter((command) => command.tapOn?.id === 'settings.sms.reload').length, 1);
assert.equal(commands.filter((command) => command.extendedWaitUntil?.visible?.id === 'settings.sms.reloaded').length, 1);
const field = 'settings.sms.notification-retry-delay-minutes';
const traversals = commands.filter((command) => command.scrollUntilVisible?.element?.id === field);
assert.equal(traversals.length, 2);
assert.ok(traversals.every((command) => command.scrollUntilVisible.centerElement === true));
const edit = commands.findIndex((command) => command.tapOn?.id === field);
assert.deepEqual(commands.slice(edit, edit + 6), [
  { tapOn: { id: field } }, { eraseText: 100 }, { inputText: '20' },
  { assertVisible: { id: field, text: '^20$' } }, 'hideKeyboard',
  { scrollUntilVisible: { element: { id: 'settings.sms.reload' }, direction: 'DOWN', timeout: 20000 } },
]);
assert.equal(commands.at(-1).assertVisible.text, '^15$');
assert.doesNotMatch(serialized, /qa-scroll|send|save/);
for (const [name, id] of [['androidEmulator', 'emulator-5554'], ['iosSimulator', 'explicit-udid']]) {
  const runtime = buildDeviceLaunchFlow(flow, { ...config.mobile.devices[name], id, descriptorName: name }, `./.tmp-unsaved-${name}.yaml`);
  assert.ok(runtime.launchPlan.launchArgs.includes(id));
  assert.equal(runtime.stages?.length || 1, name === 'iosSimulator' ? 3 : 1);
  const generatedPath = name === 'iosSimulator' ? runtime.stages[2].path : runtime.path;
  const generated = YAML.parseAllDocuments(fs.readFileSync(generatedPath, 'utf8'))[1].toJS();
  assert.doesNotMatch(JSON.stringify(generated), /WORKSIDEQA_CORRELATION|settings\.sms\.save/);
}
for (const key of ['mutationExpected', 'uiCorrelationCount', 'externalProviderInvocationCount', 'blockedProviderAttemptCount', 'crossTenantLeakageCount', 'successAuditCount', 'operationReceiptCount', 'tenantBUnchanged', 'revision']) assert.ok(Object.hasOwn(flow.authoritativeResult, key), key);
const result = { ok: true, generation: 'generation', verificationCase: flow.backendVerification, ...flow.authoritativeResult, unexpectedDomainRecords: [] };
assert.equal(parseAuthoritativeResult(JSON.stringify(result), flow.authoritativeResult, '', 'generation').correlationMatched, true);
assert.equal(parseAuthoritativeResult(JSON.stringify(result), flow.authoritativeResult, '', 'generation').correlationUniqueCount, 0);
assert.throws(() => parseAuthoritativeResult(JSON.stringify(result), flow.authoritativeResult, 'WORKSIDEQA_CORRELATION={"requestId":"unexpected","operationId":"unexpected"}', 'generation'));
assert.throws(() => parseAuthoritativeResult(JSON.stringify({ ...result, uiCorrelationCount: 1 }), flow.authoritativeResult, '', 'generation'));
assert.throws(() => parseAuthoritativeResult(JSON.stringify({ ...result, mutationExpected: true }), flow.authoritativeResult, '', 'generation'));
console.log('PASS: unsaved retry-delay draft, authoritative reload, zero mutation/correlation contract and platform generation');
