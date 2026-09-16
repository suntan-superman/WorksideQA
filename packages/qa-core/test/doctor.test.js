const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { parseArgs, parsePowerShellConfig, mergedEnvironment, checkDevices, checkTools, checkPaths, checkLocalContract, runDoctor } = require('../src/doctor');
const { DEFAULT_LOCAL_CONFIG_PATH } = require('../src/local-config');

function localConfigWithoutSageSet() {
  const config = parsePowerShellConfig(DEFAULT_LOCAL_CONFIG_PATH);
  for (const key of Object.keys(config)) if (key.startsWith('SAGESET_')) delete config[key];
  // Keep these contract tests independent of the developer's ignored config.
  config.MERXUS_MAESTRO_OWNER_A_EMAIL = config.MERXUS_MAESTRO_OWNER_A_EMAIL || 'owner-a@example.test';
  config.MERXUS_MAESTRO_OWNER_A_PASSWORD = config.MERXUS_MAESTRO_OWNER_A_PASSWORD || 'test-password';
  config.MERXUS_MAESTRO_OWNER_B_EMAIL = config.MERXUS_MAESTRO_OWNER_B_EMAIL || 'owner-b@example.test';
  config.MERXUS_MAESTRO_OWNER_B_PASSWORD = config.MERXUS_MAESTRO_OWNER_B_PASSWORD || 'test-password';
  config.MERXUS_ANDROID_EMULATOR_ID = config.MERXUS_ANDROID_EMULATOR_ID || 'emulator-5554';
  return config;
}

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
  const localConfig = localConfigWithoutSageSet();
  const merxus = await runDoctor({ product: 'merxus', strict: true, offline: true, skipAuth: true, localConfig });
  assert.equal(merxus.status, 'PASS');
  assert.equal(merxus.checks.some((check) => check.id === 'config.sageset-identity'), false);

  const sageset = await runDoctor({ product: 'sageset', strict: true, offline: true, skipAuth: true, localConfig });
  assert.equal(sageset.status, 'FAIL');
  assert.ok(sageset.checks.some((check) => check.id === 'config.SAGESET_MAESTRO_USER_A_EMAIL' && check.status === 'failed'));
  assert.equal(sageset.checks.some((check) => check.id.startsWith('config.MERXUS_')), false);
});

test('global Doctor retains warning versus strict all-products semantics', async () => {
  const localConfig = localConfigWithoutSageSet();
  const overview = await runDoctor({ offline: true, skipAuth: true, localConfig });
  assert.equal(overview.status, 'WARN');
  assert.ok(overview.checks.some((check) => check.id === 'config.sageset-identity' && check.status === 'warning'));
  const strict = await runDoctor({ strict: true, offline: true, skipAuth: true, localConfig });
  assert.equal(strict.status, 'FAIL');
  assert.ok(strict.checks.some((check) => check.id === 'config.sageset-identity' && check.status === 'failed'));
});

test('SageSet mobile readiness fails without a configured Android identity', async () => {
  const checks = await checkDevices({}, { product: 'sageset' });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'failed');
  assert.match(checks[0].message, /cannot be certified/i);
});

test('SageSet mobile readiness requires both online device and QA app', async () => {
  const env = {
    SAGESET_ANDROID_EMULATOR_ID: 'emulator-5554',
    SAGESET_MAESTRO_ANDROID_APP_ID: 'com.workside.sageset',
  };
  const execute = (_adb, args) => args.includes('get-state')
    ? { status: 0, stdout: 'device\n' }
    : { status: 0, stdout: '' };
  const missingApp = await checkDevices(env, { product: 'sageset', adb: 'adb.exe', execute });
  assert.equal(missingApp.at(-1).status, 'failed');
  const ready = await checkDevices(env, {
    product: 'sageset', adb: 'adb.exe', execute: (_adb, args) => args.includes('get-state')
      ? { status: 0, stdout: 'device\n' }
      : { status: 0, stdout: 'package:/data/app/com.workside.sageset/base.apk\n' },
  });
  assert.deepEqual(ready.map((check) => check.status), ['passed', 'passed']);
});

test('doctor rejects Firebase CLI 15 when resolved Java is below 21', () => {
  if (process.platform !== 'win32') return;
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-toolchain-'));
  const firebase = path.join(root, 'firebase.cmd');
  const java = path.join(root, 'java.cmd');
  fs.writeFileSync(firebase, '@echo off\r\necho 15.23.0\r\n', 'utf8');
  fs.writeFileSync(java, '@echo off\r\necho openjdk version "17.0.15"\r\n', 'utf8');
  try {
    const checks = checkTools({
      ...process.env,
      PATH: '', Path: '',
      WORKSIDEQA_FIREBASE_BIN: firebase,
      WORKSIDEQA_JAVA_BIN: java,
    }, { offline: false });
    const compatibility = checks.find((check) => check.id === 'tool.firebase-java-compat');
    assert.equal(compatibility.status, 'failed');
    assert.match(compatibility.message, /Java 21/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('post-start Doctor environment normalizes a missing-shell Firebase template', () => {
  if (process.platform !== 'win32') return;
  const env = mergedEnvironment({
    NVM_SYMLINK: '',
    WORKSIDEQA_FIREBASE_BIN: '%NVM_SYMLINK%\\nodejs\\firebase.cmd',
  });
  assert.ok(path.isAbsolute(env.WORKSIDEQA_FIREBASE_BIN));
  assert.doesNotMatch(env.WORKSIDEQA_FIREBASE_BIN, /^[\\/]/);
  assert.match(env.WORKSIDEQA_FIREBASE_BIN, /firebase\.cmd$/i);
});

test('macOS Merxus contract uses the configured iOS simulator instead of requiring ADB', () => {
  const localConfig = localConfigWithoutSageSet();
  localConfig.MERXUS_IOS_SIMULATOR_ID = 'SIMULATOR-UDID';
  const env = mergedEnvironment(localConfig);
  const checks = checkLocalContract(env, localConfig, 'merxus', { platform: 'darwin' });
  assert.equal(checks.some((check) => check.id === 'config.MERXUS_ANDROID_EMULATOR_ID'), false);
  assert.equal(checks.find((check) => check.id === 'config.MERXUS_IOS_SIMULATOR_ID').status, 'passed');
});

test('macOS Merxus path checks allow a standalone Mobile checkout with local Firebase config', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-macos-layout-'));
  const mobile = path.join(root, 'merxusmobile');
  const backend = path.join(root, 'backend');
  fs.mkdirSync(mobile, { recursive: true });
  fs.mkdirSync(backend, { recursive: true });
  fs.writeFileSync(path.join(mobile, 'firebase.json'), '{}');
  try {
    const checks = checkPaths({ MERXUS_ROOT_REPO: path.join(root, 'missing-parent'), MERXUS_MOBILE_REPO: mobile, MERXUS_BACKEND_REPO: backend, MERXUS_WEB_REPO: path.join(root, 'missing-web') }, 'merxus', { platform: 'darwin' });
    assert.equal(checks.find((check) => check.id === 'path.merxus').status, 'skipped');
    assert.equal(checks.find((check) => check.id === 'path.merxus.mobile').status, 'passed');
    assert.equal(checks.find((check) => check.id === 'path.merxus.backend').status, 'passed');
    assert.equal(checks.find((check) => check.id === 'path.merxus.web').status, 'skipped');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
