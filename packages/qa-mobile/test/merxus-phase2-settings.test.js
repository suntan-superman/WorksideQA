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
const hasRepeatCommand = (command) => command && typeof command === 'object' && Object.hasOwn(command, 'repeat');
const boundedNavigation = commands.filter(hasRepeatCommand);
assert.equal(boundedNavigation.length, 2, 'only the two long traversals need bounded swiping');
for (const [index, target, direction] of [
  [0, 'settings.sms.save', 'UP'],
  [1, 'settings.sms.business-name', 'DOWN'],
]) {
  const loop = boundedNavigation[index];
  assert.deepEqual(loop, { repeat: { times: 12, commands: [{ runFlow: {
    when: { notVisible: { id: target } },
    commands: [{ swipe: { direction, duration: 500 } }],
  } }] } }, `${target}: fixed cap, semantic visibility check and directional gesture only`);
  const next = commands[commands.indexOf(loop) + 1];
  assert.equal(next.assertVisible.id, target, 'missing target must fail after the bounded loop');
  assert.equal(next.assertVisible.optional, undefined, 'final assertion must not be optional');

  // Exercise the parsed conditional-loop contract: already visible, early/late
  // appearance, last permitted swipe, and a permanently missing control.
  // This models navigation decisions; it does not claim live device coverage.
  for (const appearAfter of [0, 1, 5, 11, 12, Infinity]) {
    let swipes = 0;
    let checks = 0;
    const visible = () => swipes >= appearAfter;
    for (let iteration = 0; iteration < loop.repeat.times; iteration++) {
      for (const step of loop.repeat.commands) {
        assert.equal(step.runFlow.when.notVisible.id, target);
        checks++;
        if (!visible()) for (const gesture of step.runFlow.commands) {
          assert.equal(gesture.swipe.direction, direction);
          swipes++;
        }
      }
    }
    assert.equal(checks, 12);
    assert.equal(swipes, Math.min(appearAfter, 12), 'no gestures once visible; never more than the fixed bound');
    const assertTarget = () => assert.ok(visible(), `No visible element found: ${next.assertVisible.id}`);
    if (appearAfter === Infinity) assert.throws(assertTarget, /No visible element found/);
    else assertTarget();
  }
}
const editIndex = commands.findIndex((command) => command.tapOn?.id === 'settings.sms.business-name');
assert.deepEqual(commands.slice(editIndex, editIndex + 5), [
  { tapOn: { id: 'settings.sms.business-name' } },
  { eraseText: 100 },
  { inputText: 'Merxus Maestro Tenant A QA Branding' },
  { assertVisible: { id: 'settings.sms.business-name', text: '^Merxus Maestro Tenant A QA Branding$' } },
  'hideKeyboard',
], 'business-name input, exact assertion and keyboard dismissal remain unchanged');
assert.equal(commands[editIndex + 5], boundedNavigation[0]);
const saveTap = commands.findIndex((command) => command.tapOn?.id === 'settings.sms.save');
assert.deepEqual(commands[saveTap], { tapOn: { id: 'settings.sms.save' } }, 'Save tap must be semantic, never coordinates');
assert.equal(saveTap, commands.indexOf(boundedNavigation[0]) + 2);
assert.equal(commands[commands.indexOf(boundedNavigation[1]) - 1].extendedWaitUntil.visible.id, 'settings.sms.reloaded');
assert.equal(flow.backendVerification, 'phase2-settings-update-owner-a');
assert.equal(flow.fixtureScenario, 'phase2-settings-update-owner-a');
assert.equal(flow.account, 'user-a');
assert.equal(flow.timeoutMs, 90000, 'navigation fix does not inflate the flow timeout');
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
  assert.deepEqual(iosResume.filter(hasRepeatCommand), boundedNavigation, 'iOS resume preserves common semantic navigation');
  const android = buildDeviceLaunchFlow(flow, { ...config.mobile.devices.androidEmulator, id: 'emulator-5554', descriptorName: 'androidEmulator' }, path.join(directory, 'android.yaml'));
  const androidCommands = YAML.parseAllDocuments(fs.readFileSync(android.path, 'utf8'))[1].toJS();
  assert.deepEqual(androidCommands.filter(hasRepeatCommand), boundedNavigation, 'Android runtime preserves bounded navigation');
  const result = { ok: true, generation: 'generation-1', ...flow.authoritativeResult, requestId: 'request-1', operationId: 'operation-1' };
  const ui = 'WORKSIDEQA_CORRELATION={"requestId":"request-1","operationId":"operation-1"}';
  assert.equal(parseAuthoritativeResult(JSON.stringify(result), flow.authoritativeResult, ui, 'generation-1').successAuditCount, 1);
  for (const extra of [{ successAuditCount: 2 }, { crossTenantLeakageCount: undefined }, { externalProviderInvocationCount: 1 }, { generation: 'stale' }, { requestId: 'wrong' }]) assert.throws(() => parseAuthoritativeResult(JSON.stringify({ ...result, ...extra }), flow.authoritativeResult, ui, 'generation-1'));
  assert.throws(() => parseAuthoritativeResult(JSON.stringify(result), flow.authoritativeResult, '', 'generation-1'));
  console.log('PASS Merxus Phase 2 isolated flow, certified iOS split, authoritative counters and UI correlation contracts');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
