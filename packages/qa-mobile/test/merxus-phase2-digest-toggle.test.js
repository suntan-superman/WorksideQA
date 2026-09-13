const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { loadProductManifest } = require('../../qa-config/src');
const { validateMaestroConfiguration, selectFlows, buildDeviceLaunchFlow } = require('../src/maestro-runner');
const { parseAuthoritativeResult } = require('../src/authoritative-result');
const { parseCorrelationSources } = require('../src/ui-correlation');
const config = validateMaestroConfiguration(loadProductManifest('merxus'));
const [flow] = selectFlows(config, { suite: 'phase2-digest-toggle' });
assert.equal(flow.name, '24-tenant-settings-digest-enabled-roundtrip-owner-a');
assert.equal(flow.timeoutMs, 180000);
assert.equal(flow.fixtureScenario, flow.backendVerification);
assert.equal(flow.authoritativeResult.correlationCount, 2);
const source = fs.readFileSync(flow.path, 'utf8');
const commands = YAML.parseAllDocuments(source)[1].toJS();
const field = 'settings.sms.daily-digest-enabled';
const start = commands.findIndex((command) => command.assertVisible?.id === field);
const mutation = commands.slice(start);
const digestTraversals = commands.filter((command) => command.scrollUntilVisible?.element?.id === field);
assert.equal(digestTraversals.length, 3);
assert.ok(digestTraversals.every((command) => command.scrollUntilVisible.centerElement === true), 'every digest switch traversal centers before interaction');
assert.deepEqual(mutation.filter((command) => command.assertVisible?.id === field).map((command) => command.assertVisible.checked), [false, true, true, false, false]);
for (const id of [field, 'settings.sms.save', 'settings.sms.reload']) assert.equal(mutation.filter((command) => command.tapOn?.id === id).length, 2);
assert.equal(mutation.filter((command) => command.copyTextFrom?.id === 'settings.sms.request-id').length, 2);
assert.equal(mutation.filter((command) => command.copyTextFrom?.id === 'settings.sms.operation-id').length, 2);
assert.doesNotMatch(JSON.stringify(mutation), /hideKeyboard|eraseText|inputText|qa-dismiss|point|swipe|send-digest|settings.sms.test/);
assert.equal(mutation.filter((command) => command.extendedWaitUntil?.visible?.id === 'settings.sms.reloaded').length, 2);
assert.equal(mutation.filter((command) => command.evalScript?.includes('WORKSIDEQA_CORRELATION=')).length, 2);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-toggle-runtime-'));
try {
  for (const [name, id] of [['androidEmulator', 'emulator-5554'], ['iosSimulator', 'explicit-udid']]) {
    const runtime = buildDeviceLaunchFlow(flow, { ...config.mobile.devices[name], id, descriptorName: name }, path.join(directory, name, 'runtime.yaml'));
    assert.ok(runtime.launchPlan.launchArgs.includes(id));
    const application = name === 'iosSimulator' ? runtime.stages[2].path : runtime.path;
    if (name === 'iosSimulator') assert.equal(runtime.stages.length, 3);
    const generated = YAML.parseAllDocuments(fs.readFileSync(application, 'utf8'))[1].toJS();
    assert.deepEqual(generated.slice(generated.findIndex((command) => command.assertVisible?.id === field)), mutation);
  }
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
const pairs = [{ requestId: 'request-a', operationId: 'operation-a' }, { requestId: 'request-b', operationId: 'operation-b' }];
const marker = (pair) => `WORKSIDEQA_CORRELATION=${JSON.stringify(pair)}`;
const sources = [{ source: 'runner/stdout', output: pairs.map(marker).join('\n') }, { source: 'runtime-resume/logs/maestro.log', output: pairs.map(marker).join('\n') }];
const backend = { ok: true, generation: 'generation', ...flow.authoritativeResult, correlations: pairs, unexpectedDomainRecords: [] };
const verify = (result = backend, output = sources) => parseAuthoritativeResult(JSON.stringify(result), flow.authoritativeResult, output, 'generation');
assert.equal(verify().correlationMatched, true);
assert.deepEqual(verify().uiCorrelations, pairs);
assert.equal(verify().correlationUniqueCount, 2);
assert.equal(verify(backend, [sources[1]]).correlationMatched, true, 'artifact-only two-leg capture');
assert.equal(verify(backend, [sources[0]]).correlationMatched, true);
assert.throws(() => parseCorrelationSources(sources), /exactly one/, 'prior slices still reject multiple captures');
for (const bad of [[], [pairs[0]], [...pairs, { requestId: 'extra', operationId: 'extra' }], [pairs[0], { requestId: 'request-a', operationId: 'another' }]]) assert.throws(() => verify(backend, [{ source: 'stdout', output: bad.map(marker).join('\n') }]));
assert.throws(() => verify(backend, [...sources, { source: 'log', output: 'WORKSIDEQA_CORRELATION=invalid' }]));
for (const edit of [
  { correlations: [...pairs].reverse().map((pair, index) => ({ ...pair, operationId: pairs[index].operationId })) },
  { correlations: [pairs[0], pairs[0]] }, { correlations: [pairs[0]] },
  { correlations: [pairs[0], { requestId: 'wrong', operationId: 'operation-b' }] },
  { correlations: [pairs[0], { requestId: 'request-b', operationId: 'wrong' }] },
  { revision: 2 }, { dailyDigestEnabled: true }, { digestDeliveryArtifactCount: 1 },
  { unexpectedDomainRecords: ['notification_digest_runs/bad'] }, { externalProviderInvocationCount: 1 },
  { blockedProviderAttemptCount: 1 }, { successAuditCount: 1 }, { operationReceiptCount: 1 },
]) assert.throws(() => verify({ ...backend, ...edit }));
console.log('PASS: digest toggle round-trip generation, native switch state, two-leg authoritative correlation and unchanged platform launch');
