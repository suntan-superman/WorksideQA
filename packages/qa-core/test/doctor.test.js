const assert = require('node:assert/strict');
const test = require('node:test');
const { parseArgs, parsePowerShellConfig, mergedEnvironment } = require('../src/doctor');

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
    json: true, offline: true, skipAuth: false, strict: true,
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
