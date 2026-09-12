const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProductManifest } = require('../../qa-config/src');
const { buildBackendVerificationPlan, buildDeviceLaunchFlow, buildFixtureResetPlan, buildMaestroTestArgs, selectFlows, validateMaestroConfiguration } = require('../src/maestro-runner');

const manifest = loadProductManifest('merxus');
const validated = validateMaestroConfiguration(manifest);
assert.equal(validated.mobile.enabled, true);
assert.equal(validated.mobile.appId, 'com.merxus.mobile.qa');
assert.equal(validated.mobile.environment.firebaseProjectId, 'merxus-maestro-local');
assert.equal(validated.mobile.environment.externalProvidersAllowed, false);
const androidDescriptor = validated.mobile.devices.androidEmulator;
assert.equal(androidDescriptor.appId, 'com.merxus.mobile.qa');
assert.equal(androidDescriptor.launchReadySelector, 'qa-environment-root');
assert.match(androidDescriptor.launchUri, /^exp\+merxus-mobile:\/\/expo-development-client\/\?url=/);
assert.match(androidDescriptor.launchUri, /%3FdisableOnboarding%3D1$/);
assert.equal(validated.mobile.devices.iosSimulator.launchUri, undefined);
assert.deepEqual(selectFlows(validated, { suite: 'phase1' }).map((flow) => flow.name), ['00-launch-environment', '01-login-owner-a', '02-tenant-isolation', '03-logout']);

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-merxus-fixture-'));
fs.writeFileSync(path.join(fixtureRoot, 'package.json'), '{}\n');
const env = {
  MERXUS_BACKEND_REPO: fixtureRoot,
  MERXUS_MAESTRO_OWNER_A_EMAIL: 'owner-a@merxus-maestro.test',
  MERXUS_MAESTRO_OWNER_A_PASSWORD: 'secret-a',
  MERXUS_MAESTRO_OWNER_B_EMAIL: 'owner-b@merxus-maestro.test',
  MERXUS_MAESTRO_OWNER_B_PASSWORD: 'secret-b',
};
const generation = 'merxus-maestro-test-generation';
const flow = selectFlows(validated, { flow: '02-tenant-isolation' })[0];
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa merxus runtime '));
const runtimeFlowPath = path.join(runtimeRoot, 'runtime flow.yaml');
const originalFlowSource = fs.readFileSync(flow.path, 'utf8');
const runtimeFlow = buildDeviceLaunchFlow(flow, {
  platform: 'android',
  id: 'emulator-5554',
  appId: 'com.merxus.mobile.qa',
  launchUri: androidDescriptor.launchUri,
  launchReadySelector: androidDescriptor.launchReadySelector,
  launchReadyTimeoutMs: androidDescriptor.launchReadyTimeoutMs,
}, runtimeFlowPath);
const runtimeDocuments = require('yaml').parseAllDocuments(fs.readFileSync(runtimeFlowPath, 'utf8'));
const runtimeCommands = runtimeDocuments[1].toJS();
assert.deepEqual(runtimeCommands.slice(0, 3), [
  { extendedWaitUntil: { visible: { id: 'qa-environment-root' }, timeout: 30000 } },
  { tapOn: { id: 'auth.login.email' } },
  { inputText: '${MERXUS_MAESTRO_OWNER_A_EMAIL}' },
]);
assert.equal(runtimeFlow.path, runtimeFlowPath);
assert.equal(runtimeFlow.launchPlan.clearState, true);
assert.deepEqual(runtimeFlow.launchPlan.clearArgs, ['-s', 'emulator-5554', 'shell', 'pm', 'clear', 'com.merxus.mobile.qa']);
assert.deepEqual(runtimeFlow.launchPlan.launchArgs, [
  '-s', 'emulator-5554', 'shell', 'am', 'start', '-W',
  '-a', 'android.intent.action.VIEW', '-d', androidDescriptor.launchUri,
  '-p', 'com.merxus.mobile.qa',
]);
assert.equal(fs.readFileSync(flow.path, 'utf8'), originalFlowSource);
assert.deepEqual(buildDeviceLaunchFlow(flow, { platform: 'ios', id: 'IOS-A' }, path.join(runtimeRoot, 'ios.yaml')), { path: flow.path, launchPlan: null });
const maestroArgs = buildMaestroTestArgs({
  selectedDevice: { id: 'emulator-5554', platform: 'android' },
  artifactPath: 'reports/mobile/merxus/path with spaces/artifacts',
  junitPath: 'reports/mobile/merxus/path with spaces/junit.xml',
  environmentValues: { MERXUS_MAESTRO_OWNER_A_EMAIL: 'owner-a@merxus-maestro.test' },
  flowPath: runtimeFlowPath,
});
assert.deepEqual(maestroArgs.slice(0, 3), ['--device', 'emulator-5554', 'test']);
assert.equal(maestroArgs.at(-1), runtimeFlowPath);
assert.ok(maestroArgs.includes('reports/mobile/merxus/path with spaces/junit.xml'));
const reset = buildFixtureResetPlan(validated, flow, env, generation);
assert.deepEqual(reset.args, ['run', 'qa:maestro:reset', '--', '--scenario', 'login-owner-a', '--apply', '--confirm-reset', '--generation', generation]);
assert.equal(reset.env.MERXUS_QA_ENVIRONMENT, 'maestro');
assert.equal(reset.env.MERXUS_ALLOW_EXTERNAL_PROVIDERS, 'false');
assert.equal(reset.env.FIREBASE_PROJECT_ID, 'merxus-maestro-local');
const verify = buildBackendVerificationPlan(validated, flow, env, generation);
assert.deepEqual(verify.args, ['run', 'qa:maestro:verify', '--', '--case', 'tenant-isolation-a-b', '--scenario', 'login-owner-a', '--generation', generation]);
assert.equal(verify.env.MERXUS_MAESTRO_GENERATION, generation);
const certificationSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'merxus-phase1-certification.js'), 'utf8');
assert.match(certificationSource, /PHASE 1 CERTIFIED/);
assert.match(certificationSource, /iosSimulator/);
assert.match(certificationSource, /androidEmulator/);
fs.rmSync(fixtureRoot, { recursive: true, force: true });
fs.rmSync(runtimeRoot, { recursive: true, force: true });
console.log('Merxus Maestro Phase 1 manifest and orchestration contract verified.');
