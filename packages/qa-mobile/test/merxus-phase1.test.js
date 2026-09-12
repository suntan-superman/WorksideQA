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
const iosDescriptor = validated.mobile.devices.iosSimulator;
assert.equal(iosDescriptor.appId, 'com.merxus.mobile.qa');
assert.equal(iosDescriptor.kind, 'simulator');
assert.equal(iosDescriptor.launchReadySelector, 'qa-environment-root');
assert.equal(iosDescriptor.launchUri, 'exp+merxus-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081');
assert.deepEqual(iosDescriptor.launchDismissIfVisible, ['Continue', 'Close']);
assert.deepEqual(iosDescriptor.postActionDismissIfVisible, [
  { afterTapId: 'auth.login.submit', visible: 'Save Password?', tap: 'Not Now' },
]);
assert.deepEqual(selectFlows(validated, { suite: 'phase1' }).map((flow) => flow.name), ['00-launch-environment', '01-login-owner-a', '02-tenant-isolation', '03-logout']);

const yaml = require('yaml');
const loginFlows = validated.flows.filter((candidate) => /MERXUS_MAESTRO_OWNER_[AB]_EMAIL/.test(fs.readFileSync(candidate.path, 'utf8')));
assert.equal(loginFlows.length, 4);
for (const loginFlow of loginFlows) {
  const commands = yaml.parseAllDocuments(fs.readFileSync(loginFlow.path, 'utf8'))[1].toJS();
  const findAfter = (start, predicate) => commands.findIndex((command, index) => index > start && predicate(command));
  const emailTap = commands.findIndex((command) => command.tapOn?.id === 'auth.login.email');
  const emailErase = findAfter(emailTap, (command) => Number(command.eraseText) >= 64);
  const emailInput = findAfter(emailErase, (command) => /^\$\{MERXUS_MAESTRO_OWNER_[AB]_EMAIL\}$/.test(command.inputText || ''));
  const passwordTap = findAfter(emailInput, (command) => command.tapOn?.id === 'auth.login.password');
  const passwordErase = findAfter(passwordTap, (command) => Number(command.eraseText) >= 64);
  const passwordInput = findAfter(passwordErase, (command) => /^\$\{MERXUS_MAESTRO_OWNER_[AB]_PASSWORD\}$/.test(command.inputText || ''));
  const hideKeyboard = findAfter(passwordInput, (command) => command === 'hideKeyboard' || (command && typeof command === 'object' && Object.hasOwn(command, 'hideKeyboard')));
  const submitAssertion = findAfter(hideKeyboard, (command) => command.assertVisible?.id === 'auth.login.submit' && command.assertVisible.enabled === true);
  const submitTap = findAfter(submitAssertion, (command) => command.tapOn?.id === 'auth.login.submit');
  const dashboardWait = findAfter(submitTap, (command) => command.extendedWaitUntil?.visible?.id === 'screen.dashboard.ready');
  assert.ok(emailTap >= 0 && emailTap < emailErase, `${loginFlow.name} must erase the email field before input`);
  assert.ok(emailErase < emailInput && emailInput < passwordTap, `${loginFlow.name} must enter deterministic email before password`);
  assert.ok(passwordTap < passwordErase && passwordErase < passwordInput, `${loginFlow.name} must erase the password field before input`);
  assert.ok(passwordInput < hideKeyboard && hideKeyboard < submitAssertion, `${loginFlow.name} must hide the keyboard before asserting submit`);
  assert.ok(submitAssertion < submitTap && submitTap < dashboardWait, `${loginFlow.name} must submit and wait for dashboard readiness`);
}

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
for (const phaseFlow of validated.flows) {
  assert.doesNotMatch(fs.readFileSync(phaseFlow.path, 'utf8'), /\b(?:adb|xcrun|openurl|launchUri)\b/);
}
const runtimeFlow = buildDeviceLaunchFlow(flow, {
  platform: 'android',
  id: 'emulator-5554',
  appId: 'com.merxus.mobile.qa',
  launchUri: androidDescriptor.launchUri,
  launchReadySelector: androidDescriptor.launchReadySelector,
  launchReadyTimeoutMs: androidDescriptor.launchReadyTimeoutMs,
}, runtimeFlowPath);
const runtimeDocuments = yaml.parseAllDocuments(fs.readFileSync(runtimeFlowPath, 'utf8'));
const runtimeCommands = runtimeDocuments[1].toJS();
assert.deepEqual(runtimeCommands.slice(0, 3), [
  { extendedWaitUntil: { visible: { id: 'qa-environment-root' }, timeout: 30000 } },
  { tapOn: { id: 'auth.login.email' } },
  { eraseText: 128 },
]);
assert.equal(JSON.stringify(runtimeCommands).includes('Save Password?'), false);
assert.equal(JSON.stringify(runtimeCommands).includes('Not Now'), false);
assert.equal(runtimeFlow.path, runtimeFlowPath);
assert.equal(runtimeFlow.launchPlan.clearState, true);
assert.equal(runtimeFlow.launchPlan.platform, 'android');
assert.equal(runtimeFlow.launchPlan.clearCommand, 'adb');
assert.deepEqual(runtimeFlow.launchPlan.clearArgs, ['-s', 'emulator-5554', 'shell', 'pm', 'clear', 'com.merxus.mobile.qa']);
assert.equal(runtimeFlow.launchPlan.launchCommand, 'adb');
assert.deepEqual(runtimeFlow.launchPlan.launchArgs, [
  '-s', 'emulator-5554', 'shell', 'am', 'start', '-W',
  '-a', 'android.intent.action.VIEW', '-d', androidDescriptor.launchUri,
  '-p', 'com.merxus.mobile.qa',
]);
assert.equal(fs.readFileSync(flow.path, 'utf8'), originalFlowSource);
const iosRuntimePath = path.join(runtimeRoot, 'ios runtime flow.yaml');
const iosRuntimeFlow = buildDeviceLaunchFlow(flow, {
  ...iosDescriptor,
  id: '3C029085-0B3D-49B6-AB7D-2943DA45F695',
}, iosRuntimePath);
const iosRuntimeDocuments = yaml.parseAllDocuments(fs.readFileSync(iosRuntimePath, 'utf8'));
const iosRuntimeCommands = iosRuntimeDocuments[1].toJS();
assert.deepEqual(iosRuntimeCommands.slice(0, 4), [
  { runFlow: { when: { visible: 'Continue' }, commands: [{ tapOn: 'Continue' }] } },
  { runFlow: { when: { visible: 'Close' }, commands: [{ tapOn: 'Close' }] } },
  { extendedWaitUntil: { visible: { id: 'qa-environment-root' }, timeout: 30000 } },
  { tapOn: { id: 'auth.login.email' } },
]);
for (const [index, label] of ['Continue', 'Close'].entries()) {
  assert.deepEqual(iosRuntimeCommands[index].runFlow.when, { visible: label });
  assert.deepEqual(iosRuntimeCommands[index].runFlow.commands, [{ tapOn: label }]);
}
assert.equal(iosRuntimeCommands.some((command) => command.tapOn === 'Reload' || command.tapOn === 'Go home'), false);
const iosSubmitIndex = iosRuntimeCommands.findIndex((command) => command.tapOn?.id === 'auth.login.submit');
assert.ok(iosSubmitIndex >= 0);
assert.deepEqual(iosRuntimeCommands[iosSubmitIndex + 1], {
  tapOn: {
    text: 'Not Now',
    below: { text: 'Save Password?' },
    optional: true,
    label: 'Dismiss Save Password? if it appears',
  },
});
assert.equal(JSON.stringify(iosRuntimeCommands[iosSubmitIndex + 1]).includes('"text":"Save"'), false);
assert.equal(iosRuntimeCommands[iosSubmitIndex + 2].extendedWaitUntil?.visible?.id, 'screen.dashboard.ready');
assert.equal(iosRuntimeFlow.path, iosRuntimePath);
assert.equal(iosRuntimeFlow.launchPlan.platform, 'ios');
assert.equal(iosRuntimeFlow.launchPlan.clearState, true);
assert.equal(iosRuntimeFlow.launchPlan.clearCommand, 'maestro');
assert.deepEqual(iosRuntimeFlow.launchPlan.clearArgs.slice(0, 3), ['--device', '3C029085-0B3D-49B6-AB7D-2943DA45F695', 'test']);
assert.equal(iosRuntimeFlow.launchPlan.launchCommand, 'xcrun');
assert.deepEqual(iosRuntimeFlow.launchPlan.launchArgs, [
  'simctl', 'openurl', '3C029085-0B3D-49B6-AB7D-2943DA45F695', iosDescriptor.launchUri,
]);
const clearFlowPath = path.join(runtimeRoot, 'clear-state.yaml');
const clearDocuments = yaml.parseAllDocuments(fs.readFileSync(clearFlowPath, 'utf8'));
assert.deepEqual(clearDocuments[0].toJS(), { appId: 'com.merxus.mobile.qa' });
const clearCommands = clearDocuments[1].toJS();
assert.deepEqual(clearCommands, [{ launchApp: { clearState: true } }]);
assert.deepEqual(buildDeviceLaunchFlow(flow, { platform: 'ios', kind: 'simulator', id: 'IOS-A' }, path.join(runtimeRoot, 'ios-no-uri.yaml')), { path: flow.path, launchPlan: null });
assert.throws(() => buildDeviceLaunchFlow(flow, { ...iosDescriptor, kind: 'physical', id: 'IOS-PHYSICAL' }, path.join(runtimeRoot, 'ios-physical.yaml')), /explicitly selected simulator/);
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
