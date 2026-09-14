const assert = require('node:assert/strict');
const test = require('node:test');
const { parseArgs, serviceDefinitions, commandMatches, canonicalMerxusMetroEnvironment, waitForServiceReady, assertPortsAvailable } = require('../src/orchestrator');

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
