const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createRequire } = require('node:module');
const { collectCorrelationSources } = require('../src/ui-correlation');
const { parseAuthoritativeResult } = require('../src/authoritative-result');
const { loadProductManifest } = require('../../qa-config/src');

const ids = { requestId: 'request-1', operationId: 'operation-1' };
const marker = (value = ids) => `WORKSIDEQA_CORRELATION=${JSON.stringify(value)}`;
const expected = { externalProviderInvocationCount: 0, blockedProviderAttemptCount: 0, crossTenantLeakageCount: 0, successAuditCount: 1, operationReceiptCount: 1, tenantBUnchanged: true, revision: 2 };
const backend = (extra = {}) => JSON.stringify({ ok: true, generation: 'current-generation', ...expected, ...ids, ...extra });
const parse = (sources, extra) => parseAuthoritativeResult(backend(extra), expected, sources, 'current-generation');
function write(root, relative, contents) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

async function testCollection() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa correlation paths with spaces '));
  try {
    for (const [platform, runtime] of [['android', 'runtime-flow'], ['ios', 'runtime-resume']]) {
      const artifactDirectory = path.join(root, platform, 'current-run', 'current-flow', 'artifacts');
      fs.mkdirSync(artifactDirectory, { recursive: true });
      const options = { artifactDirectory, applicationFlowNames: [runtime] };
      let result = parse(await collectCorrelationSources({ ...options, stdout: marker() }));
      assert.equal(result.correlationMatched, true);
      assert.deepEqual(result.correlationCaptureSources, ['runner/stdout']);
      const log = write(artifactDirectory, `arbitrary-timestamp/${runtime}/logs/maestro.log`, `UNRELATED_SECRET_DO_NOT_COPY\n12:00 [ INFO] driver: JsConsole: ${marker()}\n`);
      result = parse(await collectCorrelationSources(options));
      assert.deepEqual(result.correlationCaptureSources, [log]);
      assert.deepEqual(result.uiCorrelation, ids);
      assert.deepEqual(result.backendCorrelation, ids);
      assert.equal(result.correlationUniqueCount, 1);
      assert.equal(result.correlationMatched, true);
      assert.ok(!JSON.stringify(result).includes('UNRELATED_SECRET'));
      // Different property order still represents one logical pair.
      result = parse(await collectCorrelationSources({ ...options, stdout: marker({ operationId: ids.operationId, requestId: ids.requestId }), stderr: marker() }));
      assert.equal(result.correlationUniqueCount, 1);
      assert.deepEqual(result.correlationCaptureSources, ['runner/stdout', 'runner/stderr', log]);
      assert.equal(result.correlationMatched, true);
      // Older run, sibling flow and other stage logs are never evidence.
      write(path.join(root, platform, 'previous-run'), `${runtime}/logs/maestro.log`, marker({ ...ids, requestId: 'stale' }));
      write(path.dirname(artifactDirectory), `../sibling-flow/artifacts/${runtime}/logs/maestro.log`, marker({ ...ids, requestId: 'sibling' }));
      write(artifactDirectory, 'timestamp/runtime-system-overlay/logs/maestro.log', marker({ ...ids, requestId: 'overlay' }));
      write(artifactDirectory, '.maestro/tests/previous/maestro.log', marker({ ...ids, requestId: 'not-application-log' }));
      assert.equal(parse(await collectCorrelationSources(options)).correlationMatched, true);
      // Native Windows paths and POSIX paths are both accepted as stage metadata.
      for (const name of [`C:\\QA path\\${runtime}.yaml`, `/qa/path/${runtime}.yaml`]) {
        assert.equal(parse(await collectCorrelationSources({ ...options, applicationFlowNames: [name] })).correlationMatched, true);
      }
      fs.utimesSync(log, new Date(0), new Date(0));
      assert.throws(() => parse([]), /exactly one unique/);
      assert.throws(() => parse([{ source: 'runner/stdout', output: marker({ ...ids, requestId: 'other' }) }]), /requestId mismatch/);
      const staleSources = await collectCorrelationSources({ ...options, notBeforeMs: Date.now() - 1000 });
      assert.throws(() => parse(staleSources), /exactly one unique/);
    }
    for (const output of ['WORKSIDEQA_CORRELATION={oops}', 'WORKSIDEQA_CORRELATION=', marker({ requestId: 'r' }), marker({ operationId: 'o' }), marker({ ...ids, requestId: '' }), marker({ ...ids, requestId: 42 })]) {
      assert.throws(() => parse([{ source: 'runner/stdout', output }]), (error) => {
        assert.equal(error.correlationDiagnostics.correlationMatched, false);
        assert.deepEqual(error.correlationDiagnostics.backendCorrelation, ids);
        assert.match(error.message, /Malformed UI correlation/);
        assert.ok(!error.message.includes(output));
        return true;
      });
    }
    assert.throws(() => parse([{ source: 'one', output: marker() }, { source: 'two', output: marker({ ...ids, operationId: 'different' }) }]), (error) => error.correlationDiagnostics.correlationUniqueCount === 2 && error.correlationDiagnostics.uiCorrelation === null);
    assert.throws(() => parse([{ source: 'one', output: `${marker()}\nWORKSIDEQA_CORRELATION={broken}` }]), /Malformed/);
    for (const key of ['requestId', 'operationId']) {
      assert.throws(() => parse([{ source: 'stdout', output: marker() }], { [key]: 'mismatch' }), (error) => error.message === `UI/backend ${key} mismatch` && error.correlationDiagnostics.correlationMatched === false);
    }
    assert.throws(() => parse([{ source: 'stdout', output: marker() }], { revision: 3 }), /Authoritative verifier mismatch/);
    const echo = "Run ${console.log('WORKSIDEQA_CORRELATION=' + JSON.stringify({requestId: output.settingsRequestId, operationId: maestro.copiedText}))} COMPLETED";
    assert.throws(() => parse([{ source: 'log', output: echo }]), /exactly one unique/);
    assert.equal(parse([{ source: 'log', output: `${echo}\nJsConsole: ${marker()}\n${echo}` }]).correlationUniqueCount, 1);
    console.log('PASS correlation source parsing, deduplication, strict failure handling, Android/iOS/Windows discovery and current-run isolation');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function testRunner(variant) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa correlation runner '));
  const entry = require.resolve('../src/maestro-runner');
  const localRequire = createRequire(entry);
  const module = { exports: {} };
  const fakeProcess = new EventEmitter();
  fakeProcess.platform = process.platform;
  fakeProcess.stdout = new PassThrough(); fakeProcess.stderr = new PassThrough();
  fakeProcess.env = { ...process.env, MERXUS_BACKEND_REPO: root,
    MERXUS_MAESTRO_OWNER_A_EMAIL: 'owner-a@merxus-maestro.test', MERXUS_MAESTRO_OWNER_A_PASSWORD: 'test-secret-a',
    MERXUS_MAESTRO_OWNER_B_EMAIL: 'owner-b@merxus-maestro.test', MERXUS_MAESTRO_OWNER_B_PASSWORD: 'test-secret-b' };
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const runDirectory = path.join(root, 'run');
  const flowDirectory = path.join(runDirectory, '21-tenant-settings-update-owner-a');
  let generation;
  let backendRan = false;
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    if (args.includes('--generation')) generation = args[args.indexOf('--generation') + 1];
    setImmediate(() => {
      if (command === 'maestro') {
        assert.ok(args.includes('emulator-5554'));
        if (variant !== 'absent') write(flowDirectory, 'artifacts/dynamic-date/runtime-flow/logs/maestro.log', `JsConsole: ${marker()}\nPRIVATE_UNRELATED_LOG`);
        if (variant === 'duplicate') child.stdout.write(marker());
        if (variant === 'conflict') child.stderr.write(marker({ ...ids, operationId: 'different' }));
      } else if (args.includes('qa:maestro:verify')) {
        backendRan = true;
        child.stdout.write(backend({ generation }));
      }
      child.emit('close', 0, null);
    });
    return child;
  };
  const fakeRequire = (name) => {
    if (name === './maestro-process') return { spawnMaestro: (args) => spawn('maestro', args), spawnMaestroSync: () => ({ status: 0, stdout: 'test-version' }), terminateMaestro: () => assert.fail('no timeout expected') };
    if (name === '../../qa-utils/src') return { ...localRequire(name), spawnCommand: spawn };
    if (name === './device-selection') return { ...localRequire(name), resolveConfiguredDevice: () => ({ ...loadProductManifest('merxus').mobile.devices.androidEmulator, id: 'emulator-5554', descriptorName: 'androidEmulator' }) };
    return localRequire(name);
  };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), { require: fakeRequire, module, exports: module.exports, process: fakeProcess, console, setTimeout, clearTimeout }, { filename: entry });
  try {
    const action = module.exports.runMaestroFlows(loadProductManifest('merxus'), { suite: 'phase2-settings', device: 'androidEmulator', runDirectory });
    if (['absent', 'conflict'].includes(variant)) await assert.rejects(action, /exactly one unique UI correlation capture/);
    else await action;
    assert.equal(backendRan, true, 'backend remains authoritative, even if UI capture is invalid');
    const result = JSON.parse(fs.readFileSync(path.join(flowDirectory, 'result.json'), 'utf8'));
    assert.equal(result.stages.ui.status, 'passed');
    assert.equal(result.correlationMatched, !['absent', 'conflict'].includes(variant));
    assert.equal(result.correlationUniqueCount, variant === 'conflict' ? 2 : variant === 'absent' ? 0 : 1);
    assert.deepEqual(result.backendCorrelation, ids);
    if (result.correlationMatched) assert.deepEqual(result.uiCorrelation, ids);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_UNRELATED_LOG'));
    assert.equal(fakeProcess.listenerCount('SIGINT'), 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const log = fs.readFileSync(path.join(flowDirectory, 'runner.log'), 'utf8');
    assert.match(log, /WorksideQA correlation/);
    assert.ok(!log.includes('PRIVATE_UNRELATED_LOG'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

(async () => {
  await testCollection();
  for (const variant of ['artifact-only', 'duplicate', 'absent', 'conflict']) await testRunner(variant);
  console.log('PASS actual runner result/log correlation diagnostics and backend verification preservation');
})().catch((error) => { console.error(error); process.exitCode = 1; });
