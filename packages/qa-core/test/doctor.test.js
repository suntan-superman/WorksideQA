const assert = require('node:assert/strict');
const test = require('node:test');
const { parseArgs, parsePowerShellConfig, mergedEnvironment, runDoctor } = require('../src/doctor');

test('doctor parses only canonical PowerShell environment assignments', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(os.tmpdir(), `worksideqa-doctor-${process.pid}.ps1`);
  fs.writeFileSync(file, [
    '$env:SAFE_VALUE = "maestro"',
    '$env:SAFE_SECRET = "value with spaces"',
    'Write-Host "ignored"',
  ].join('\n'));
  try {
    assert.deepEqual(parsePowerShellConfig(file), { SAFE_VALUE: 'maestro', SAFE_SECRET: 'value with spaces' });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('doctor arguments support offline/json/strict modes', () => {
  assert.deepEqual(parseArgs(['--offline', '--json', '--strict']), {
    json: true, offline: true, skipAuth: false, strict: true, product: 'all',
  });
});

test('doctor supplies safe canonical defaults without exposing credentials', () => {
  const env = mergedEnvironment({});
  assert.equal(env.MERXUS_MOBILE_ENVIRONMENT, 'maestro');
  assert.equal(env.MERXUS_QA_ENVIRONMENT, 'maestro');
  assert.equal(env.MERXUS_MAESTRO_FIREBASE_PROJECT_ID, 'merxus-maestro-local');
  assert.equal(env.MERXUS_QA_BACKEND_URL, 'http://127.0.0.1:8787');
  assert.equal(env.MERXUS_ALLOW_EXTERNAL_PROVIDERS, 'false');
  assert.equal(env.MERXUS_MAESTRO_OWNER_A_PASSWORD, undefined);
});

test('product-scoped strict Doctor ignores the other product credentials', async () => {
  const merxus = await runDoctor({ product: 'merxus', strict: true, offline: true, skipAuth: true });
  assert.equal(merxus.status, 'PASS');
  assert.equal(merxus.checks.some((check) => check.id === 'config.sageset-identity'), false);

  const sageset = await runDoctor({ product: 'sageset', strict: true, offline: true, skipAuth: true });
  assert.equal(sageset.status, 'FAIL');
  assert.ok(sageset.checks.some((check) => check.id === 'config.SAGESET_MAESTRO_USER_A_EMAIL' && check.status === 'failed'));
  assert.equal(sageset.checks.some((check) => check.id.startsWith('config.MERXUS_')), false);
});

test('global Doctor retains warning versus strict all-products semantics', async () => {
  const overview = await runDoctor({ offline: true, skipAuth: true });
  assert.equal(overview.status, 'WARN');
  assert.ok(overview.checks.some((check) => check.id === 'config.sageset-identity' && check.status === 'warning'));
  const strict = await runDoctor({ strict: true, offline: true, skipAuth: true });
  assert.equal(strict.status, 'FAIL');
  assert.ok(strict.checks.some((check) => check.id === 'config.sageset-identity' && check.status === 'failed'));
});
