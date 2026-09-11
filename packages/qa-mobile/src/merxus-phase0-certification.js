#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadProductManifest } = require('../../qa-config/src');
const { ensureDir, fromRoot, writeJson } = require('../../qa-utils/src');
const { validateDeviceDescriptors } = require('./device-selection');

const CHECK_NAMES = [
  'QA app identity', 'Production app rejection', 'Production Firebase rejection', 'Production backend rejection',
  'Auth emulator contract', 'Firestore emulator contract', 'Storage emulator contract', 'Authoritative rules available',
  'External providers disabled', 'Fixture reset bounded', 'iOS explicit-device support', 'Android explicit-device support',
  'Notification security review',
];

function run(command, args, cwd, env = process.env) {
  return spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
}
function safeText(value) {
  return String(value || '').replace(/(?:Bearer\s+|(?:token|secret|password|api[_-]?key)=)[^\s]+/gi, '[REDACTED]');
}
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function certify(options = {}) {
  const manifest = loadProductManifest('merxus');
  const mobile = manifest.mobile || {};
  const backendRoot = path.resolve(options.backendRoot || process.env.MERXUS_BACKEND_REPO || fromRoot('..', 'Merxus', 'merxus-ai-backend'));
  const mobileRoot = path.resolve(options.mobileRoot || process.env.MERXUS_MOBILE_REPO || fromRoot('..', 'Merxus', 'mobile'));
  const checks = [];
  const check = (name, condition, detail) => checks.push({ name, status: condition ? 'PASS' : 'FAIL', detail });

  check('QA app identity', mobile.appId === 'com.merxus.mobile.qa' && mobile.productionAppId === 'com.merxus.mobile', `${mobile.appId} != ${mobile.productionAppId}`);
  check('Production app rejection', mobile.appId !== mobile.productionAppId, 'Manifest identities are distinct and mobile contract tests enforce the rejection.');
  check('Production Firebase rejection', mobile.environment?.firebaseProjectId === 'merxus-maestro-local' && mobile.environment.firebaseProjectId !== manifest.firebase?.projectId, mobile.environment?.firebaseProjectId);
  check('Production backend rejection', /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(mobile.environment?.backendUrl || ''), mobile.environment?.backendUrl);
  check('Auth emulator contract', mobile.environment?.emulators?.auth === 9099, '127.0.0.1:9099');
  check('Firestore emulator contract', mobile.environment?.emulators?.firestore === 8080, '127.0.0.1:8080');
  check('Storage emulator contract', mobile.environment?.emulators?.storage === 9199, '127.0.0.1:9199');
  check('External providers disabled', mobile.environment?.externalProvidersAllowed === false && mobile.environment?.externalNotificationsAllowed === false, 'All external providers disabled.');

  let descriptorsValid = false;
  try { descriptorsValid = validateDeviceDescriptors(mobile); } catch { descriptorsValid = false; }
  check('iOS explicit-device support', descriptorsValid && Boolean(mobile.devices?.iosSimulator?.idEnvKey), mobile.devices?.iosSimulator?.idEnvKey || 'missing');
  check('Android explicit-device support', descriptorsValid && Boolean(mobile.devices?.androidEmulator?.idEnvKey), mobile.devices?.androidEmulator?.idEnvKey || 'missing');

  const safeEnv = {
    ...process.env,
    MERXUS_QA_ENVIRONMENT: 'maestro', GCLOUD_PROJECT: 'merxus-maestro-local',
    MERXUS_MAESTRO_FIREBASE_PROJECT_ID: 'merxus-maestro-local',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199', MERXUS_QA_BACKEND_URL: 'http://127.0.0.1:8787',
    MERXUS_ALLOW_EXTERNAL_PROVIDERS: 'false',
  };
  const preflight = run('node', ['scripts/qa-maestro-phase0.js', 'preflight'], backendRoot, safeEnv);
  let preflightPayload = null;
  try { preflightPayload = JSON.parse(preflight.stdout.slice(preflight.stdout.indexOf('{'))); } catch { preflightPayload = null; }
  check('Authoritative rules available', preflight.status === 0 && preflightPayload?.authoritativeFirebaseFiles?.every((item) => item.present), safeText(preflight.stderr || 'Merxus/web Firebase files found.'));

  const backendTests = run('node', ['scripts/run-vitest.mjs', 'run', 'tests/maestroSafetyService.test.js', 'tests/notificationAuthorization.test.js'], backendRoot, safeEnv);
  const mobileTests = run('node', ['--experimental-default-type=module', '--test', 'src/config/runtimeEnvironment.test.js'], mobileRoot, safeEnv);
  const testsPass = backendTests.status === 0 && mobileTests.status === 0;
  check('Fixture reset bounded', testsPass, testsPass ? 'Bounded ID and dual-confirmation tests passed.' : safeText(backendTests.stderr || mobileTests.stderr));
  check('Notification security review', backendTests.status === 0, backendTests.status === 0 ? 'Authenticated user/tenant ownership tests passed.' : safeText(backendTests.stderr));

  const orderedChecks = CHECK_NAMES.map((name) => checks.find((item) => item.name === name) || { name, status: 'FAIL', detail: 'Certification check was not produced.' });
  const status = orderedChecks.every((item) => item.status === 'PASS') ? 'PHASE 0 CERTIFIED' : 'PHASE 0 NOT CERTIFIED';
  const runDirectory = ensureDir(fromRoot('reports', 'merxus', 'maestro-phase0', stamp()));
  const report = { schemaVersion: 1, product: 'merxus', phase: 0, status, checks: orderedChecks, repositories: { backendRoot, mobileRoot } };
  writeJson(path.join(runDirectory, 'phase0-certification.json'), report);
  const markdown = ['# Merxus Maestro Phase 0 Certification', '', `**Overall:** ${status}`, '', '| Check | Result | Detail |', '|---|---|---|', ...orderedChecks.map((item) => `| ${item.name} | ${item.status} | ${String(item.detail || '').replace(/\|/g, '\\|')} |`), ''].join('\n');
  fs.writeFileSync(path.join(runDirectory, 'phase0-certification.md'), markdown, 'utf8');
  console.log('Merxus Maestro Phase 0\n');
  for (const item of orderedChecks) console.log(`${item.name.padEnd(36)} ${item.status}`);
  console.log(`\nOverall: ${status}`);
  console.log(`Report: ${runDirectory}`);
  return report;
}

if (require.main === module) {
  const report = certify();
  if (report.status !== 'PHASE 0 CERTIFIED') process.exitCode = 1;
}

module.exports = { CHECK_NAMES, certify };
