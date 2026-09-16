const assert = require('node:assert/strict');
const test = require('node:test');
const { parseArgs, serviceDefinitions, commandMatches, canonicalMerxusMetroEnvironment, waitForServiceReady, assertPortsAvailable, fixtureCommands, spawnService, reconcileRecord, terminateRecord, stopProduct } = require('../src/orchestrator');
const fs = require('node:fs');
const path = require('node:path');

test('orchestrator parses lifecycle and product arguments', () => {
  assert.deepEqual(parseArgs(['start', '--product', 'merxus']), {
    action: 'start', product: 'merxus', service: null, json: false,
  });
  assert.deepEqual(parseArgs(['--restart', '--product', 'sageset', '--service', 'firebase']), {
    action: 'restart', product: 'sageset', service: 'firebase', json: false,
  });
});

test('Merxus startup definitions are dependency ordered and bounded to canonical ports', () => {
  const definitions = serviceDefinitions('merxus', {
    MERXUS_MOBILE_REPO: 'C:\\Merxus\\mobile',
    MERXUS_BACKEND_REPO: 'C:\\Merxus\\backend',
  });
  assert.deepEqual(definitions.map((item) => item.service), ['firebase', 'backend', 'metro']);
  assert.deepEqual(definitions.map((item) => item.ports), [[9099, 8080, 9199], [8787], [8081]]);
  assert.equal(definitions[0].args[0], 'emulators:start');
  assert.equal(definitions[1].args[0], 'run');
  assert.equal(definitions[2].args.at(-1), '--clear');
});

test('startup definitions use the resolver paths when supplied', () => {
  const definitions = serviceDefinitions('merxus', {
    MERXUS_MOBILE_REPO: 'C:\\Merxus\\mobile',
    MERXUS_BACKEND_REPO: 'C:\\Merxus\\backend',
  }, {
    firebase: { path: 'C:\\Tools\\firebase.cmd' },
    npm: { path: 'C:\\Tools\\npm.cmd' },
  });
  assert.equal(definitions[0].executable, 'C:\\Tools\\firebase.cmd');
  assert.equal(definitions[1].executable, 'C:\\Tools\\npm.cmd');
  assert.equal(definitions[2].executable, 'C:\\Tools\\npm.cmd');
});

test('qa:start forces canonical Maestro Metro inputs over inherited production values', () => {
  const env = canonicalMerxusMetroEnvironment({
    EXPO_PUBLIC_ENVIRONMENT: 'production',
    EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test',
    EXPO_PUBLIC_FIREBASE_API_KEY: 'secret',
  });
  assert.equal(env.EXPO_PUBLIC_ENVIRONMENT, 'maestro');
  assert.equal(env.EXPO_PUBLIC_API_BASE_URL, 'http://127.0.0.1:8787');
  assert.equal(env.EXPO_PUBLIC_FIREBASE_API_KEY, undefined);
  assert.equal(env.EXPO_NO_DOTENV, '1');
});

test('SageSet startup definition uses emulator-only services and functions readiness', () => {
  const definitions = serviceDefinitions('sageset', { SAGESET_MOBILE_REPO: 'C:\\SageSet\\mobile' });
  assert.deepEqual(definitions.map((item) => item.service), ['firebase']);
  assert.deepEqual(definitions[0].ports, [9099, 8080, 9199, 5001]);
  assert.ok(definitions[0].args.some((arg) => String(arg).includes('functions')));
});

test('ownership matching rejects unrelated recorded PIDs on Windows semantics', () => {
  const record = { service: 'metro', executable: 'npm.cmd', args: ['exec', '--', 'expo', 'start'] };
  if (process.platform !== 'win32') return;
  assert.equal(commandMatches(record, { CommandLine: 'npm.cmd exec -- expo start --dev-client' }), true);
  assert.equal(commandMatches(record, { CommandLine: 'node unrelated-server.js' }), false);
});

test('reconciles a dead wrapper when a recorded descendant still owns the port', () => {
  const record = {
    pid: 100, rootPid: 100, service: 'firebase', executable: 'firebase.cmd', args: ['emulators:start'], ports: [9099],
    processTree: [{ pid: 100, executable: 'firebase.cmd', commandLine: 'firebase.cmd emulators:start', startedAt: 'root' },
      { pid: 200, executable: 'java.exe', commandLine: 'java -jar firebase-emulator.jar', startedAt: 'child' }],
  };
  const infos = new Map([[200, { pid: 200, Name: 'java.exe', CommandLine: 'java -jar firebase-emulator.jar', CreationDate: 'child', ParentProcessId: 1 }]]);
  const result = reconcileRecord(record, () => 200, (pid) => infos.get(pid), (pid) => pid === 200);
  assert.equal(result.state, 'RECOVERED');
  assert.equal(result.owned, true);
  assert.ok(record.reconciledAt);
});

test('marks a changed descendant PID as conflict rather than adopting by port', () => {
  const record = {
    pid: 100, rootPid: 100, service: 'firebase', executable: 'firebase.cmd', args: ['emulators:start'], ports: [9099],
    processTree: [{ pid: 200, executable: 'java.exe', commandLine: 'java -jar firebase-emulator.jar', startedAt: 'child' }],
  };
  const result = reconcileRecord(record, () => 201, (pid) => pid === 201 ? { pid, Name: 'java.exe', CommandLine: 'java -jar firebase-emulator.jar', CreationDate: 'new' } : null, (candidate) => candidate === 201);
  assert.equal(result.state, 'CONFLICT');
});

test('foreign process on an expected port remains a conflict', () => {
  const record = { pid: 100, rootPid: 100, service: 'backend', executable: 'npm.cmd', args: ['run', 'serve'], ports: [8787], processTree: [{ pid: 100, executable: 'npm.cmd', commandLine: 'npm.cmd run serve', startedAt: 'root' }] };
  const result = reconcileRecord(record, () => 999, (pid) => pid === 100 ? { pid, Name: 'npm.cmd', CommandLine: 'npm.cmd run serve', CreationDate: 'root' } : { pid, Name: 'other.exe', CommandLine: 'other.exe --listen 8787', CreationDate: 'foreign' }, (candidate) => [100, 999].includes(candidate));
  assert.equal(result.state, 'CONFLICT');
});

test('stale runtime state with no live tree is not running', () => {
  const record = { pid: 100, rootPid: 100, ports: [8081], processTree: [{ pid: 100, startedAt: 'old' }] };
  const result = reconcileRecord(record, () => null, () => null, () => false);
  assert.equal(result.state, 'NOT RUNNING');
});

test('reconciles a reused recorded PID as stale when all expected ports are free', () => {
  const record = {
    pid: 100, rootPid: 100, service: 'firebase', executable: 'firebase.cmd', args: ['emulators:start'], ports: [9099, 8080, 9199],
    processTree: [{ pid: 100, executable: 'firebase.cmd', commandLine: 'firebase.cmd emulators:start', startedAt: 'old' }],
  };
  const result = reconcileRecord(
    record,
    () => null,
    (pid) => pid === 100 ? { pid, Name: 'unrelated.exe', CommandLine: 'unrelated.exe --work', CreationDate: 'new' } : null,
    (pid) => pid === 100,
  );
  assert.equal(result.state, 'STALE');
  assert.equal(result.stale, true);
  assert.deepEqual(result.portOwners, [{ port: 9099, pid: null }, { port: 8080, pid: null }, { port: 9199, pid: null }]);
});

test('a live listener keeps a reused recorded PID as a conflict', () => {
  const record = {
    pid: 100, rootPid: 100, service: 'firebase', executable: 'firebase.cmd', args: ['emulators:start'], ports: [9099],
    processTree: [{ pid: 100, executable: 'firebase.cmd', commandLine: 'firebase.cmd emulators:start', startedAt: 'old' }],
  };
  const result = reconcileRecord(
    record,
    () => 100,
    (pid) => pid === 100 ? { pid, Name: 'unrelated.exe', CommandLine: 'unrelated.exe --listen 9099', CreationDate: 'new' } : null,
    (pid) => pid === 100,
  );
  assert.equal(result.state, 'CONFLICT');
  assert.equal(result.portOwners[0].pid, 100);
});

test('readiness stops immediately when a child exits before ports are ready', async () => {
  const result = await waitForServiceReady({ record: { ports: [65530] }, getExitInfo: () => ({ code: 1, signal: null }) }, 5000);
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'PROCESS_EXITED');
  assert.equal(result.exitInfo.code, 1);
});

test('readiness aborts immediately on a fatal Metro bundle prewarm result', async () => {
  let probes = 0;
  const result = await waitForServiceReady(
    { record: { ports: [] }, getExitInfo: () => null },
    5000,
    async () => { probes += 1; return { ready: false, fatal: true, reason: 'METRO_BUNDLE_PREWARM_FAILED', detail: 'bundle request failed' }; },
  );
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'METRO_BUNDLE_PREWARM_FAILED');
  assert.equal(result.detail, 'bundle request failed');
  assert.equal(probes, 1);
});

test('unexpected zero exit is reported as process exit, while empty readiness succeeds', async () => {
  const exited = await waitForServiceReady({ record: { ports: [65530] }, getExitInfo: () => ({ code: 0, signal: null }) }, 5000);
  assert.equal(exited.reason, 'PROCESS_EXITED');
  const ready = await waitForServiceReady({ record: { ports: [] }, getExitInfo: () => null }, 5000);
  assert.equal(ready.ready, true);
});

test('unowned port conflicts abort startup without adoption', () => {
  assert.throws(
    () => assertPortsAvailable({ service: 'backend', ports: [8787] }, null, () => 5264),
    /port 8787 is owned by PID 5264, not a WorksideQA-recorded process/,
  );
});

test('fixture bootstrap reuses product-owned reset and verification commands', () => {
  const merxus = fixtureCommands('merxus', 'merxus-maestro-worksideqa-start-test');
  assert.equal(merxus.scenario, 'login-owner-a');
  assert.deepEqual(merxus.verify, ['run', 'qa:maestro:auth:verify']);
  assert.ok(merxus.reset.includes('--confirm-reset'));
  assert.ok(merxus.reset.includes('--apply'));
  assert.ok(merxus.reset.includes('--generation'));
  const sageset = fixtureCommands('sageset', 'sageset-maestro-worksideqa-start-test');
  assert.equal(sageset.scenario, 'clean');
  assert.ok(sageset.reset.includes('reset:maestro-fixtures'));
});

test('long-running service logging does not retain parent stdout/stderr pipes', async () => {
  const serviceName = `orchestrator-test-${process.pid}-${Date.now()}`;
  const logPath = path.join(process.cwd(), '.worksideqa', 'logs', `${serviceName}.log`);
  const service = spawnService({
    service: serviceName,
    role: 'test-service',
    cwd: process.cwd(),
    executable: process.execPath,
    args: ['-e', "process.stdout.write('service-ready\\n'); setTimeout(() => {}, 30000)"],
    ports: [],
  }, 'test');
  try {
    assert.equal(service.child.stdout, null);
    assert.equal(service.child.stderr, null);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(fs.readFileSync(logPath, 'utf8'), /service-ready/);
  } finally {
    service.child.kill();
    await new Promise((resolve) => setTimeout(resolve, 50));
    try { fs.unlinkSync(logPath); } catch {}
  }
});

function terminationRecord() {
  return {
    product: 'merxus', service: 'firebase', pid: 100, rootPid: 100, executable: 'firebase.cmd',
    args: ['emulators:start'], ports: [9099], processTree: [
      { pid: 100, executable: 'firebase.cmd', commandLine: 'firebase.cmd emulators:start', startedAt: 'root' },
      { pid: 200, executable: 'node.exe', commandLine: 'node firebase.js emulators:start', startedAt: 'child' },
    ],
  };
}

test('termination targets every verified recorded Windows tree member, including a live descendant after wrapper exit', async () => {
  const record = terminationRecord();
  const live = new Set([200]);
  const info = new Map([[200, { pid: 200, Name: 'node.exe', CommandLine: 'node firebase.js emulators:start', CreationDate: 'child' }]]);
  const killed = [];
  const result = await terminateRecord(record, {
    platform: 'win32', ownership: { state: 'RECOVERED', owned: true, currentTree: [record.processTree[1]], portOwners: [{ port: 9099, pid: 200 }] },
    aliveResolver: (pid) => live.has(pid), infoResolver: (pid) => info.get(pid), ownerResolver: () => live.has(200) ? 200 : null,
    portOpenResolver: () => false, taskkill: (pid) => { killed.push(pid); live.delete(pid); }, timeoutMs: 100, pollMs: 1,
  });
  assert.equal(result.stopped, true);
  assert.deepEqual(killed, [200]);
});

test('termination preserves ownership when taskkill fails or a verified descendant/port remains', async () => {
  const record = terminationRecord();
  const live = new Set([100, 200]);
  const info = new Map([
    [100, { pid: 100, Name: 'firebase.cmd', CommandLine: 'firebase.cmd emulators:start', CreationDate: 'root' }],
    [200, { pid: 200, Name: 'node.exe', CommandLine: 'node firebase.js emulators:start', CreationDate: 'child' }],
  ]);
  const result = await terminateRecord(record, {
    platform: 'win32', ownership: { state: 'RUNNING', owned: true, currentTree: record.processTree, portOwners: [{ port: 9099, pid: 200 }] },
    aliveResolver: (pid) => live.has(pid), infoResolver: (pid) => info.get(pid), ownerResolver: () => 200,
    portOpenResolver: () => true, taskkill: () => ({ status: 1 }), timeoutMs: 5, pollMs: 1,
  });
  assert.equal(result.stopped, false);
  assert.deepEqual(result.remainingPids.sort((a, b) => a - b), [100, 200]);
  assert.deepEqual(result.remainingPorts, [{ port: 9099, pid: 200 }]);
  assert.equal(live.has(100), true);
});

test('stopProduct retains records on incomplete cleanup and clears only after verified success', async () => {
  const record = terminationRecord();
  const baseState = () => ({ products: { merxus: { services: [record] } } });
  const ownership = { state: 'RUNNING', owned: true, recovered: false, portOwners: [] };
  let persisted = 0;
  await assert.rejects(
    stopProduct('merxus', {
      state: baseState(), reconcile: () => ownership,
      terminate: async () => ({ stopped: false, reason: 'port remains', remainingPids: [200], remainingPorts: [{ port: 9099, pid: 200 }] }),
      save: () => { persisted += 1; },
    }),
    /qa:stop incomplete/,
  );
  assert.equal(persisted, 1);

  const successfulState = baseState();
  await stopProduct('merxus', {
    state: successfulState, reconcile: () => ownership,
    terminate: async () => ({ stopped: true, cleaned: true }), save: () => { persisted += 1; },
  });
  assert.deepEqual(successfulState.products.merxus.services, []);
});
