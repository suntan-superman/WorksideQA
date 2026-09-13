const assert = require('node:assert/strict');
const { loadProductManifest } = require('../../qa-config/src');
const {
  runBackendIdentityPreflight,
  validateBackendIdentityContract,
} = require('../src/backend-identity-preflight');

const manifest = loadProductManifest('merxus');
const mobile = manifest.mobile;
const phase0 = mobile.phase0;

const contract = validateBackendIdentityContract(mobile, phase0);
assert.equal(contract.backendUrl, 'http://127.0.0.1:8787');
assert.equal(contract.endpoint, 'http://127.0.0.1:8787/api/auth/check-email');
assert.deepEqual(contract.owners, ['ownerA', 'ownerB']);
assert.equal(contract.projectId, 'merxus-maestro-local');
assert.equal(contract.authEmulatorHost, '127.0.0.1:9099');
assert.equal(contract.firestoreEmulatorHost, '127.0.0.1:8080');

for (const mutate of [
  (value) => { value.environment.backendUrl = 'https://api.example.test'; },
  (value) => { value.environment.firebaseProjectId = 'production'; },
  (value) => { value.environment.emulators.auth = 9098; },
  (value) => { value.phase0.backendIdentityVerify.endpointPath = 'https://evil.example.test'; },
  (value) => { value.phase0.backendIdentityVerify.owners = []; },
]) {
  const unsafeMobile = JSON.parse(JSON.stringify(mobile));
  mutate(unsafeMobile);
  assert.throws(() => validateBackendIdentityContract(unsafeMobile, unsafeMobile.phase0));
}

const fixturePlan = {
  cwd: 'C:\\qa\\merxus-ai-backend',
  env: {
    MERXUS_MAESTRO_OWNER_A_EMAIL: 'owner-a@merxus-maestro.test',
    MERXUS_MAESTRO_OWNER_B_EMAIL: 'owner-b@merxus-maestro.test',
  },
};
const validated = { mobile };
const calls = [];
const previousFetch = global.fetch;
global.fetch = async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body) });
  return { status: 200, async json() { return { exists: true, provider: 'email', hasWorkspace: true }; } };
};

async function runTests() {
const runAuthOnly = (runProcess) => runBackendIdentityPreflight({
  validated,
  flow: { name: '00-launch-environment' },
  fixturePlan,
  runProcess,
  logStream: { write() {} },
  generation: 'merxus-maestro-test-generation',
});

await runBackendIdentityPreflight({
  validated,
  flow: { name: '00-launch-environment' },
  fixturePlan,
  runProcess: async (command, args) => {
    assert.equal(command, 'npm');
    assert.deepEqual(args, ['run', 'qa:maestro:auth:verify']);
    return { code: 0, timedOut: false, cancelled: false };
  },
  logStream: { write() {} },
  generation: 'merxus-maestro-test-generation',
}).then((result) => {
  assert.equal(result.authVerify, 'passed');
  assert.equal(result.identities.length, 2);
  assert.equal(result.identities.every((identity) => identity.passed), true);
  assert.deepEqual(calls.map((call) => call.body.email), [
    'owner-a@merxus-maestro.test',
    'owner-b@merxus-maestro.test',
  ]);
}).then(async () => {
  global.fetch = async () => ({ status: 200, async json() { return { exists: false }; } });
  await assert.rejects(
    runAuthOnly(async () => ({ code: 0, timedOut: false, cancelled: false })),
    (error) => error.preflightDiagnostics?.failedCheck === 'ownerA.checkEmail',
  );
}).then(async () => {
  global.fetch = async () => ({ status: 200, async json() { return { exists: true, provider: 'email', hasWorkspace: false }; } });
  await assert.rejects(
    runAuthOnly(async () => ({ code: 0, timedOut: false, cancelled: false })),
    (error) => error.preflightDiagnostics?.failedCheck === 'ownerA.checkEmail'
      && error.preflightDiagnostics.safeCheckEmailResult.hasWorkspace === false,
  );
}).then(async () => {
  await assert.rejects(
    runAuthOnly(async () => ({ code: 1, timedOut: false, cancelled: false })),
    (error) => error.preflightDiagnostics?.failedCheck === 'authVerify',
  );
}).finally(() => {
  global.fetch = previousFetch;
});
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
