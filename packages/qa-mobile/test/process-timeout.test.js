const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { loadProductManifest } = require('../../qa-config/src');
const { runProcess, resolveMaestroProcessBudget, validateMaestroConfiguration, selectFlows } = require('../src/maestro-runner');

const merxus = loadProductManifest('merxus');
const validated = validateMaestroConfiguration(merxus);
const settings = selectFlows(validated, { suite: 'phase2-settings' })[0];
const android = merxus.mobile.devices.androidEmulator;
const ios = merxus.mobile.devices.iosSimulator;
assert.deepEqual(resolveMaestroProcessBudget(settings, validated.maestro, android), {
  declaredFlowTimeoutMs: 180000, runtimeMultiplier: 1, startupGraceMs: 15000, effectiveWatchdogMs: 195000,
});
assert.equal(resolveMaestroProcessBudget(settings, validated.maestro, ios).effectiveWatchdogMs, 285000);
assert.equal(validated.maestro.timeoutMs, 90000, 'fixture/verifier default is independent of settings UI runtime');
for (const flow of selectFlows(validated, { suite: 'phase1' })) {
  const baseline = flow.name === '00-launch-environment' ? 60000 : 90000;
  assert.equal(flow.timeoutMs, baseline);
  assert.equal(resolveMaestroProcessBudget(flow, validated.maestro, android).effectiveWatchdogMs, baseline + 15000);
  assert.equal(resolveMaestroProcessBudget(flow, validated.maestro, ios).effectiveWatchdogMs, baseline * 1.5 + 15000);
}
const sageset = validateMaestroConfiguration(loadProductManifest('sageset'));
for (const flow of sageset.flows) {
  assert.equal(resolveMaestroProcessBudget(flow, sageset.maestro).effectiveWatchdogMs, flow.timeoutMs || sageset.maestro.timeoutMs || 600000);
}
for (const invalid of [0, -1, NaN, Infinity, 2147483648]) {
  assert.throws(() => resolveMaestroProcessBudget({ timeoutMs: invalid }, validated.maestro), /timeout/);
}
assert.throws(() => resolveMaestroProcessBudget(settings, validated.maestro, { runtimeTimeoutMultiplier: Infinity }), /timeout/);

async function assertStopped(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Test child ${pid} survived process cleanup`);
}

// Real disposable Node children, never Maestro/emulators/providers. Windows also
// proves taskkill /t removes a descendant, not just the .cmd parent process.
async function testCleanup(cancelled) {
  const logStream = new PassThrough();
  let log = '';
  const listenerCount = process.listenerCount('SIGINT');
  logStream.on('data', (chunk) => {
    log += chunk;
    if (cancelled && /READY/.test(chunk)) process.emit('SIGINT');
  });
  const script = process.platform === 'win32'
    ? 'const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:"ignore"}); console.log("DESCENDANT="+child.pid); console.log("PID="+process.pid+" READY"); console.log("waiting"); setInterval(() => {},1000);'
    : 'console.log("PID="+process.pid+" READY"); console.log("waiting"); setInterval(() => {},1000);';
  const result = await runProcess(process.execPath, ['-e', script], {
    cwd: process.cwd(), env: process.env, logStream, secretValues: [], timeoutMs: cancelled ? 5000 : 1500,
    stage: 'application', watchdog: { declaredFlowTimeoutMs: 1000, startupGraceMs: 500 },
  });
  assert.equal(result.timedOut, !cancelled);
  if (cancelled) {
    assert.equal(result.cancelled, true);
    assert.equal(result.timeout, undefined);
  } else {
    assert.equal(result.timeout.code, 'WORKSIDEQA_PROCESS_TIMEOUT');
    assert.equal(result.timeout.stage, 'application');
    assert.equal(result.timeout.declaredFlowTimeoutMs, 1000);
    assert.equal(result.timeout.startupGraceMs, 500);
    assert.equal(result.timeout.effectiveWatchdogMs, 1500);
    assert.match(log, /WORKSIDEQA_PROCESS_TIMEOUT/);
  }
  assert.equal(process.listenerCount('SIGINT'), listenerCount);
  assert.match(log, /PID=\d+ READY/);
  await assertStopped(Number(log.match(/PID=(\d+)/)[1]));
  if (process.platform === 'win32') await assertStopped(Number(log.match(/DESCENDANT=(\d+)/)[1]));
}

// Exercise actual runner result.json/runner.log serialization with fake children
// and accelerated watchdog clocks. No credential-backed commands are executed.
async function testRunnerArtifacts(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa watchdog '));
  const entry = require.resolve('../src/maestro-runner');
  const localRequire = createRequire(entry);
  const module = { exports: {} };
  const calls = [];
  const timers = [];
  const killed = [];
  let activeStage;
  const fakeProcess = new EventEmitter();
  fakeProcess.platform = process.platform;
  fakeProcess.stdout = new PassThrough();
  fakeProcess.stderr = new PassThrough();
  fakeProcess.env = {
    ...process.env, MERXUS_BACKEND_REPO: root,
    MERXUS_MAESTRO_OWNER_A_EMAIL: 'owner-a@merxus-maestro.test', MERXUS_MAESTRO_OWNER_A_PASSWORD: 'test-secret-a',
    MERXUS_MAESTRO_OWNER_B_EMAIL: 'owner-b@merxus-maestro.test', MERXUS_MAESTRO_OWNER_B_PASSWORD: 'test-secret-b',
  };
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const spawn = (command, args) => {
    activeStage = command === 'maestro' ? 'application' : args.includes('qa:maestro:verify') ? 'backend' : 'preparation';
    calls.push({ command, args, stage: activeStage });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const hangs = (mode === 'timeout' || mode === 'cancel') && command === 'maestro'
      || mode === 'backend-timeout' && activeStage === 'backend';
    if (!hangs) setImmediate(() => child.emit('close', command === 'maestro' && mode === 'ui-failure' ? 7 : 0, null));
    if (mode === 'cancel' && command === 'maestro') setImmediate(() => fakeProcess.emit('SIGINT'));
    return child;
  };
  const terminate = (child, signal) => {
    killed.push(signal);
    // Even a child which handles SIGTERM and exits 0 cannot mask a watchdog/cancel.
    setImmediate(() => child.emit('close', 0, signal));
  };
  const utils = localRequire('../../qa-utils/src');
  const fakeRequire = (name) => {
    if (name === './maestro-process') return {
      spawnMaestro: (args) => spawn('maestro', args), spawnMaestroSync: () => ({ status: 0, stdout: 'test-version' }), terminateMaestro: terminate,
    };
    if (name === '../../qa-utils/src') return { ...utils, spawnCommand: spawn, terminateProcessTree: terminate };
    if (name === './device-selection') return {
      ...localRequire(name), resolveConfiguredDevice: () => ({ ...android, id: 'emulator-5554', descriptorName: 'androidEmulator' }),
    };
    return localRequire(name);
  };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    require: fakeRequire, module, exports: module.exports, process: fakeProcess, console,
    setTimeout: (callback, ms) => {
      timers.push({ stage: activeStage, ms });
      return setTimeout(callback, 30);
    }, clearTimeout,
  }, { filename: entry });
  try {
    const expectedError = mode === 'timeout' || mode === 'backend-timeout' ? /WORKSIDEQA_PROCESS_TIMEOUT/
      : mode === 'cancel' ? /WORKSIDEQA_PROCESS_CANCELLED/
      : mode === 'ui-failure' ? /UI FAILED/ : /BACKEND FAIL/;
    await assert.rejects(module.exports.runMaestroFlows(merxus, {
      suite: 'phase2-settings', device: 'androidEmulator', runDirectory: path.join(root, 'run'),
    }), expectedError);
    const result = JSON.parse(fs.readFileSync(path.join(root, 'run', settings.name, 'result.json'), 'utf8'));
    assert.equal(result.status, 'failed');
    assert.equal(result.stages.fixture.status, 'passed');
    assert.ok(timers.some((timer) => timer.stage === 'application' && timer.ms === 195000));
    assert.ok(timers.some((timer) => timer.stage === 'preparation' && timer.ms === 90000));
    assert.ok(calls.find((call) => call.command === 'maestro').args.includes('emulator-5554'));
    const expectedStage = mode === 'backend-timeout' ? 'backend' : 'application';
    if (mode === 'timeout' || mode === 'backend-timeout') {
      assert.equal(result.errorCode, 'WORKSIDEQA_PROCESS_TIMEOUT');
      assert.equal(result.timeout.stage, expectedStage);
      assert.equal(result.timeout.declaredFlowTimeoutMs, mode === 'timeout' ? 180000 : 90000);
      assert.equal(result.timeout.startupGraceMs, mode === 'timeout' ? 15000 : 0);
      assert.equal(result.timeout.effectiveWatchdogMs, mode === 'timeout' ? 195000 : 90000);
      assert.deepEqual(killed, ['SIGTERM']);
    } else if (mode === 'cancel') {
      assert.equal(result.errorCode, 'WORKSIDEQA_PROCESS_CANCELLED');
      assert.deepEqual(killed, ['SIGTERM']);
    } else {
      assert.equal(result.errorCode, undefined, 'ordinary UI failure is not a watchdog timeout');
      assert.equal(result.exitCode, 7);
      assert.equal(killed.length, 0);
    }
    if (mode === 'backend-timeout') {
      assert.equal(result.stages.ui.status, 'passed');
      assert.ok(timers.some((timer) => timer.stage === 'backend' && timer.ms === 90000));
    } else {
      assert.equal(result.stages.backend.status, 'not-run');
      assert.ok(!calls.some((call) => call.stage === 'backend'));
    }
    assert.equal(fakeProcess.listenerCount('SIGINT'), 0);
    // Allow the real artifact stream's end() to flush before checking disk.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const log = fs.readFileSync(path.join(root, 'run', settings.name, 'runner.log'), 'utf8');
    if (result.timeout) {
      assert.match(log, /WORKSIDEQA_PROCESS_TIMEOUT/);
      assert.ok(log.includes(`"stage":"${expectedStage}"`));
      assert.ok(log.includes(`"effectiveWatchdogMs":${result.timeout.effectiveWatchdogMs}`));
    } else assert.doesNotMatch(log, /WORKSIDEQA_PROCESS_TIMEOUT/);
    assert.doesNotMatch(log, /test-secret/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  await testCleanup(false);
  await testCleanup(true);
  for (const mode of ['timeout', 'cancel', 'ui-failure', 'backend-timeout']) await testRunnerArtifacts(mode);
  console.log('Maestro watchdog budgets, result/log diagnostics, cancellation and child cleanup verified.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
