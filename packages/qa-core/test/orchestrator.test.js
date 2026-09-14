const assert = require('node:assert/strict');
const test = require('node:test');
const { parseArgs, serviceDefinitions, commandMatches, canonicalMerxusMetroEnvironment, waitForServiceReady, assertPortsAvailable, fixtureCommands, spawnService } = require('../src/orchestrator');
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

test('readiness stops immediately when a child exits before ports are ready', async () => {
  const result = await waitForServiceReady({ record: { ports: [65530] }, getExitInfo: () => ({ code: 1, signal: null }) }, 5000);
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'PROCESS_EXITED');
  assert.equal(result.exitInfo.code, 1);
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
