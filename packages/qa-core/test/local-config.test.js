const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { loadLocalQaConfig } = require('../src/local-config');

function fixtureFile(contents) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-local-config-'));
  const filePath = path.join(directory, '.maestro.local.ps1');
  fs.writeFileSync(filePath, contents, 'utf8');
  return { directory, filePath };
}

test('loads Merxus and SageSet values without requiring shell exports', () => {
  const { filePath } = fixtureFile([
    '$env:MERXUS_ANDROID_EMULATOR_ID = "emulator-qa"',
    '$env:MERXUS_MAESTRO_OWNER_A_PASSWORD = "secret-a"',
    '$env:MERXUS_MAESTRO_MANAGER_A_EMAIL = "manager-a@merxus-maestro.test"',
    '$env:MERXUS_MAESTRO_MANAGER_A_PASSWORD = "secret-manager"',
    '$env:SAGESET_MAESTRO_USER_A_EMAIL = "sage-a@example.test"',
    '$env:SAGESET_MAESTRO_USER_A_PASSWORD = "secret-sage"',
    '$env:NOT_ALLOWED = "must-not-load"',
  ].join('\n'));
  const result = loadLocalQaConfig({ filePath, env: {}, mutate: false });
  assert.equal(result.values.MERXUS_ANDROID_EMULATOR_ID, 'emulator-qa');
  assert.equal(result.values.SAGESET_MAESTRO_USER_A_EMAIL, 'sage-a@example.test');
  assert.equal(result.values.MERXUS_MAESTRO_MANAGER_A_EMAIL, 'manager-a@merxus-maestro.test');
  assert.equal(result.values.NOT_ALLOWED, undefined);
  assert.ok(result.loadedKeys.includes('MERXUS_ANDROID_EMULATOR_ID'));
});

test('explicit process values take precedence over local values', () => {
  const { filePath } = fixtureFile('$env:MERXUS_ANDROID_EMULATOR_ID = "from-file"\n');
  const result = loadLocalQaConfig({ filePath, env: { MERXUS_ANDROID_EMULATOR_ID: 'from-process' }, mutate: false });
  assert.equal(result.values.MERXUS_ANDROID_EMULATOR_ID, 'from-process');
});

test('missing config fails with an actionable path and never includes a password', () => {
  const missing = path.join(os.tmpdir(), `worksideqa-missing-${Date.now()}`, '.maestro.local.ps1');
  assert.throws(() => loadLocalQaConfig({ filePath: missing }), (error) => {
    assert.match(error.message, /Missing local QA config/);
    assert.match(error.message, /maestro\.local\.ps1/);
    assert.doesNotMatch(error.message, /secret|password-a/i);
    return true;
  });
});

test('loader ignores executable PowerShell and unapproved assignments', () => {
  const { filePath } = fixtureFile([
    '$env:MERXUS_ANDROID_EMULATOR_ID = "qa"',
    'Write-Host "do not execute"',
    '$env:UNAPPROVED_SECRET = "secret-value"',
  ].join('\n'));
  const loaded = loadLocalQaConfig({ filePath, env: {}, mutate: false });
  assert.equal(loaded.values.MERXUS_ANDROID_EMULATOR_ID, 'qa');
  assert.equal(loaded.values.UNAPPROVED_SECRET, undefined);
});

test('standalone Maestro CLI imports the local device configuration in a fresh environment', { skip: !fs.existsSync(path.resolve(__dirname, '../../..', '.maestro.local.ps1')) }, () => {
  const env = { ...process.env };
  for (const key of ['MERXUS_ANDROID_EMULATOR_ID', 'MERXUS_MAESTRO_OWNER_A_EMAIL', 'MERXUS_MAESTRO_OWNER_A_PASSWORD']) delete env[key];
  const cli = path.resolve(__dirname, '../../qa-mobile/src/maestro-cli.js');
  const outcome = spawnSync(process.execPath, [cli, '--product', 'merxus', '--suite', 'phase2-unsaved-reload', '--validate'], {
    cwd: path.resolve(__dirname, '../../..'), env, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(outcome.status, 0, outcome.stderr || outcome.stdout);
  assert.match(outcome.stdout, /Validated .* Maestro flow/);
});
