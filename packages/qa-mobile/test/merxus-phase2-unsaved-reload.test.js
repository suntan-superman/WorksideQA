const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { loadProductManifest } = require('../../qa-config/src');
const { validateMaestroConfiguration, selectFlows, buildDeviceLaunchFlow } = require('../src/maestro-runner');
const { parseAuthoritativeResult } = require('../src/authoritative-result');

const config = validateMaestroConfiguration(loadProductManifest('merxus'));
const [flow] = selectFlows(config, { suite: 'phase2-unsaved-reload' });
assert.equal(flow.name, '25-tenant-settings-unsaved-reload-owner-a');
assert.equal(flow.mutationExpected, false);
assert.equal(flow.timeoutMs, 180000);
assert.deepEqual(flow.androidImeDismissAfterEdit, [{
  fieldId: 'settings.sms.notification-retry-delay-minutes',
  strategy: 'android-keyevent-escape',
  timeoutMs: 5000,
}]);
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
assert.ok(traversals.every((command) => command.scrollUntilVisible.timeout === 30000), 'Slice 25 retry-delay traversal uses its dedicated 30s bound');
const edit = commands.findIndex((command) => command.tapOn?.id === field);
assert.deepEqual(commands.slice(edit, edit + 6), [
  { tapOn: { id: field } }, { eraseText: 100 }, { inputText: '20' },
  { assertVisible: { id: field, text: '^20$' } }, 'hideKeyboard',
  { scrollUntilVisible: { element: { id: 'settings.sms.reload' }, direction: 'DOWN', timeout: 20000, centerElement: true } },
]);
const reloadScroll = commands.findIndex((command) => command.scrollUntilVisible?.element?.id === 'settings.sms.reload');
assert.deepEqual(commands.slice(reloadScroll, reloadScroll + 2), [
  { scrollUntilVisible: { element: { id: 'settings.sms.reload' }, direction: 'DOWN', timeout: 20000, centerElement: true } },
  { waitForAnimationToEnd: { timeout: 2000 } },
]);
assert.equal(commands.at(-1).assertVisible.text, '^15$');
assert.doesNotMatch(serialized, /qa-scroll|send|save/);
const generationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-unsaved-reload-'));
for (const [name, id] of [['androidEmulator', 'emulator-5554'], ['iosSimulator', 'explicit-udid']]) {
  const runtime = buildDeviceLaunchFlow(flow, { ...config.mobile.devices[name], id, descriptorName: name }, path.join(generationDirectory, `${name}.yaml`));
  assert.ok(runtime.launchPlan.launchArgs.includes(id));
  if (name === 'androidEmulator') {
    assert.deepEqual(runtime.stages.map(({ name: stageName, kind }) => ({ name: stageName, kind })), [
      { name: 'application-before-ime-dismiss', kind: 'application' },
      { name: 'android-ime-dismiss', kind: 'android-ime-dismiss' },
      { name: 'application-resume', kind: 'application' },
    ]);
    assert.deepEqual(runtime.stages[1].imeDismiss, {
      strategy: 'android-keyevent-escape',
      timeoutMs: 5000,
    });
    const beforeDismiss = YAML.parseAllDocuments(fs.readFileSync(runtime.stages[0].path, 'utf8'))[1].toJS();
    const resume = YAML.parseAllDocuments(fs.readFileSync(runtime.stages[2].path, 'utf8'))[1].toJS();
    const generatedEdit = beforeDismiss.findIndex((command) => command.tapOn?.id === field);
    assert.deepEqual(beforeDismiss.slice(generatedEdit), [
      { tapOn: { id: field } }, { eraseText: 100 }, { inputText: '20' },
      { assertVisible: { id: field, text: '^20$' } },
    ]);
    assert.deepEqual(resume.slice(0, 2), [
      { scrollUntilVisible: { element: { id: 'settings.sms.reload' }, direction: 'DOWN', timeout: 20000, centerElement: true } },
      { waitForAnimationToEnd: { timeout: 2000 } },
    ]);
    assert.doesNotMatch(JSON.stringify([...beforeDismiss, ...resume]), /WORKSIDEQA_CORRELATION|settings\.sms\.save/);
    assert.equal(beforeDismiss.slice(generatedEdit).some((command) => command === 'hideKeyboard' || Object.hasOwn(command || {}, 'hideKeyboard')), false, 'Android edit does not dismiss via Back');
    assert.equal(beforeDismiss.slice(generatedEdit).some((command) => command.tapOn?.id === 'screen.settings.ready'), false, 'Android no longer relies on a background tap to close the IME');
  } else {
    assert.equal(runtime.stages.length, 3);
    const generated = YAML.parseAllDocuments(fs.readFileSync(runtime.stages[2].path, 'utf8'))[1].toJS();
    assert.doesNotMatch(JSON.stringify(generated), /WORKSIDEQA_CORRELATION|settings\.sms\.save/);
    const generatedEdit = generated.findIndex((command) => command.tapOn?.id === field);
    assert.equal(generated.slice(generatedEdit).findIndex((command) => command === 'hideKeyboard'), -1, 'iOS runtime replaces hideKeyboard');
    assert.ok(generated.slice(generatedEdit).some((command) => command.tapOn?.id === 'settings.sms.qa-dismiss-keyboard'));
    assert.equal(generated.slice(generatedEdit).some((command) => command.tapOn?.id === 'screen.settings.ready'), false, 'iOS keeps its existing dismiss helper');
    const reloadScrollIndex = generated.findIndex((command) => command.scrollUntilVisible?.element?.id === 'settings.sms.reload');
    assert.ok(reloadScrollIndex >= 0, 'iOS keeps semantic Reload traversal');
    assert.equal(generated[reloadScrollIndex].scrollUntilVisible.optional, true, 'primary iOS traversal may recover from an overscrolled resume state');
    const fallback = generated[reloadScrollIndex + 1];
    assert.deepEqual(fallback, {
      runFlow: {
        when: { notVisible: { id: 'settings.sms.reload' } },
        commands: [{
          scrollUntilVisible: {
            element: { id: 'settings.sms.reload' },
            direction: 'UP',
            timeout: 20000,
            centerElement: true,
          },
        }],
      },
    }, 'iOS resumes with a bounded reverse traversal when the primary scan reaches the bottom');
  }
}
for (const suite of ['phase2-retry', 'phase2-retry-delay']) {
  const [certifiedFlow] = selectFlows(config, { suite });
  const runtime = buildDeviceLaunchFlow(certifiedFlow, {
    ...config.mobile.devices.androidEmulator,
    id: 'emulator-5554',
    descriptorName: 'androidEmulator',
  }, path.join(generationDirectory, `${suite}-android.yaml`));
  assert.deepEqual(runtime.stages.map((stage) => stage.kind), ['application'], `${suite} Android stage architecture stays unchanged`);
}
fs.rmSync(generationDirectory, { recursive: true, force: true });
for (const key of ['mutationExpected', 'uiCorrelationCount', 'externalProviderInvocationCount', 'blockedProviderAttemptCount', 'crossTenantLeakageCount', 'successAuditCount', 'operationReceiptCount', 'tenantBUnchanged', 'revision']) assert.ok(Object.hasOwn(flow.authoritativeResult, key), key);
const { correlationCount: harnessCorrelationCount, ...backendExpected } = flow.authoritativeResult;
assert.equal(harnessCorrelationCount, 0);
const result = { ok: true, generation: 'generation', verificationCase: flow.backendVerification, ...backendExpected, unexpectedDomainRecords: [] };
assert.equal(parseAuthoritativeResult(JSON.stringify(result), flow.authoritativeResult, '', 'generation').correlationMatched, true);
assert.equal(parseAuthoritativeResult(JSON.stringify(result), flow.authoritativeResult, '', 'generation').correlationUniqueCount, 0);
assert.throws(() => parseAuthoritativeResult(JSON.stringify(result), flow.authoritativeResult, 'WORKSIDEQA_CORRELATION={"requestId":"unexpected","operationId":"unexpected"}', 'generation'));
assert.throws(() => parseAuthoritativeResult(JSON.stringify({ ...result, uiCorrelationCount: 1 }), flow.authoritativeResult, '', 'generation'));
assert.throws(() => parseAuthoritativeResult(JSON.stringify({ ...result, mutationExpected: true }), flow.authoritativeResult, '', 'generation'));
console.log('PASS: unsaved retry-delay draft, authoritative reload, zero mutation/correlation contract and platform generation');
