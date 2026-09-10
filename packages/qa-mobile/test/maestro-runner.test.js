const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadProductManifest } = require("../../qa-config/src");
const {
  buildBackendVerificationPlan,
  buildFixtureResetPlan,
  collectEnvironmentReferences,
  selectFlows,
  validateMaestroConfiguration,
} = require("../src/maestro-runner");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const manifest = loadProductManifest("sageset");
const validated = validateMaestroConfiguration(manifest);

assert.equal(validated.mobile.appId, "com.workside.sageset");
assert.equal(validated.mobile.productionAppId, "com.sageset.fitness");
assert.equal(validated.mobile.environment.firebaseProjectId, "sageset-maestro-local");
assert.equal(validated.mobile.environment.externalNotificationsAllowed, false);
assert.deepEqual(
  selectFlows(validated, { suite: "phase1" }).map((flow) => flow.name),
  [
    "00-launch-smoke",
    "01-login-smoke",
    "10-gamification-progression",
    "20-groups-challenges",
  ]
);
assert.deepEqual(
  selectFlows(validated, { flow: "00-launch-smoke.yaml" }).map((flow) => flow.name),
  ["00-launch-smoke"]
);
assert.deepEqual(
  selectFlows(validated, { suite: "phase2" }).map((flow) => [flow.name, flow.fixtureScenario]),
  [
    ["30-invitation-pending", "invitation-pending"],
    ["31-member-active", "member-active"],
    ["32-member-paused", "member-paused"],
    ["33-member-resumed", "member-resumed"],
    ["34-progress-recorded", "progress-recorded"],
    ["35-member-removed", "member-removed"],
  ]
);
assert.deepEqual(
  selectFlows(validated, { suite: "phase3" }).map((flow) => [
    flow.name,
    flow.fixtureScenario,
    flow.account,
    flow.backendVerification,
  ]),
  [
    ["40-accept-invitation", "invitation-pending", "user-b", "accept-invitation"],
    ["41-pause-member", "member-active", "user-a", "pause-member"],
    ["42-resume-member", "member-paused", "user-a", "resume-member"],
    ["43-remove-member", "member-active", "user-a", "remove-member"],
    ["44-join-challenge", "member-active", "user-b", "join-challenge"],
  ]
);
assert.deepEqual(
  collectEnvironmentReferences("${SAGESET_MAESTRO_USER_A_EMAIL} ${SAGESET_MAESTRO_USER_A_PASSWORD}"),
  ["SAGESET_MAESTRO_USER_A_EMAIL", "SAGESET_MAESTRO_USER_A_PASSWORD"]
);

for (const mutate of [
  (value) => { value.mobile.appId = value.mobile.productionAppId; },
  (value) => { value.mobile.environment.backend = "production"; },
  (value) => { value.mobile.environment.firebaseProjectId = value.firebase.projectId; },
  (value) => { value.mobile.environment.externalNotificationsAllowed = true; },
  (value) => { value.mobile.orchestrationAuthority = "sageset"; },
]) {
  const unsafeManifest = clone(manifest);
  mutate(unsafeManifest);
  assert.throws(() => validateMaestroConfiguration(unsafeManifest));
}

for (const mutate of [
  (value) => { value.mobile.fixtures.owner = "worksideqa"; },
  (value) => { value.mobile.fixtures.command = ""; },
  (value) => { value.mobile.fixtures.args = "reset:maestro-fixtures"; },
  (value) => { value.mobile.flows.find((flow) => flow.name === "30-invitation-pending").fixtureScenario = "unknown"; },
  (value) => { value.mobile.fixtures.verification.command = ""; },
  (value) => { value.mobile.fixtures.verification.args = "verify:maestro-mutation"; },
  (value) => { value.mobile.fixtures.verification.mutations = []; },
  (value) => { value.mobile.fixtures.verification.mutations.push("join-challenge"); },
  (value) => { value.mobile.flows.find((flow) => flow.name === "40-accept-invitation").backendVerification = "unknown"; },
  (value) => { value.mobile.flows.find((flow) => flow.name === "40-accept-invitation").fixtureScenario = undefined; },
  (value) => { value.mobile.flows.find((flow) => flow.name === "40-accept-invitation").account = "admin"; },
  (value) => { value.mobile.flows.find((flow) => flow.name === "40-accept-invitation").account = "user-a"; },
]) {
  const unsafeManifest = clone(manifest);
  mutate(unsafeManifest);
  assert.throws(() => validateMaestroConfiguration(unsafeManifest));
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worksideqa-sageset-fixture-"));
fs.mkdirSync(path.join(fixtureRoot, "functions"));
fs.writeFileSync(path.join(fixtureRoot, "functions", "package.json"), "{}\n");
const fixtureEnv = {
  SAGESET_MOBILE_REPO: fixtureRoot,
  SAGESET_MAESTRO_USER_A_EMAIL: "maestro.a@example.test",
  SAGESET_MAESTRO_USER_A_PASSWORD: "user-a-password",
  SAGESET_MAESTRO_USER_B_EMAIL: "maestro.b@example.test",
  SAGESET_MAESTRO_USER_B_PASSWORD: "user-b-password",
  SAGESET_MAESTRO_QA_EMAIL_ALLOWLIST: "maestro.a@example.test,maestro.b@example.test",
};
const pendingFlow = selectFlows(validated, { flow: "30-invitation-pending" })[0];
const fixturePlan = buildFixtureResetPlan(validated, pendingFlow, fixtureEnv);
assert.equal(fixturePlan.command, "npm");
assert.deepEqual(fixturePlan.args, [
  "--prefix",
  "functions",
  "run",
  "reset:maestro-fixtures",
  "--",
  "--scenario",
  "invitation-pending",
  "--apply",
  "--confirm-reset",
]);
assert.equal(fixturePlan.cwd, fs.realpathSync(fixtureRoot));
assert.equal(fixturePlan.env.SAGESET_MAESTRO_ENVIRONMENT, "emulator");
assert.equal(fixturePlan.env.SAGESET_MAESTRO_FIREBASE_PROJECT_ID, "sageset-maestro-local");
assert.equal(fixturePlan.env.SAGESET_MAESTRO_ALLOW_EXTERNAL_NOTIFICATIONS, "false");
assert.equal(fixturePlan.env.FIREBASE_AUTH_EMULATOR_HOST, "127.0.0.1:9099");
assert.equal(fixturePlan.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:8080");
assert.equal(fixturePlan.env.FIREBASE_STORAGE_EMULATOR_HOST, "127.0.0.1:9199");
const acceptFlow = selectFlows(validated, { flow: "40-accept-invitation" })[0];
const verificationPlan = buildBackendVerificationPlan(validated, acceptFlow, fixtureEnv);
assert.equal(verificationPlan.command, "npm");
assert.deepEqual(verificationPlan.args, [
  "--prefix",
  "functions",
  "run",
  "verify:maestro-mutation",
  "--",
  "--mutation",
  "accept-invitation",
]);
assert.equal(verificationPlan.cwd, fs.realpathSync(fixtureRoot));
assert.equal(verificationPlan.env.SAGESET_MAESTRO_ENVIRONMENT, "emulator");
assert.equal(verificationPlan.env.SAGESET_MAESTRO_FIREBASE_PROJECT_ID, "sageset-maestro-local");
assert.equal(verificationPlan.env.SAGESET_MAESTRO_ALLOW_EXTERNAL_NOTIFICATIONS, "false");
assert.equal(verificationPlan.env.FIREBASE_AUTH_EMULATOR_HOST, "127.0.0.1:9099");
assert.equal(verificationPlan.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:8080");
assert.equal(verificationPlan.env.FIREBASE_STORAGE_EMULATOR_HOST, "127.0.0.1:9199");
assert.throws(
  () => buildFixtureResetPlan(validated, pendingFlow, { ...fixtureEnv, SAGESET_MOBILE_REPO: "" }),
  /Missing SAGESET_MOBILE_REPO/
);
assert.throws(
  () => buildFixtureResetPlan(validated, pendingFlow, { ...fixtureEnv, SAGESET_MAESTRO_USER_B_PASSWORD: "" }),
  /Missing required SageSet fixture environment variable/
);
assert.throws(
  () => buildBackendVerificationPlan(validated, acceptFlow, { ...fixtureEnv, SAGESET_MOBILE_REPO: "" }),
  /Missing SAGESET_MOBILE_REPO/
);
assert.throws(
  () => buildBackendVerificationPlan(validated, acceptFlow, { ...fixtureEnv, SAGESET_MAESTRO_USER_A_PASSWORD: "" }),
  /Missing required SageSet fixture environment variable/
);
assert.equal(buildFixtureResetPlan(validated, selectFlows(validated, { flow: "20-groups-challenges" })[0], {}), null);
assert.equal(buildBackendVerificationPlan(validated, selectFlows(validated, { flow: "20-groups-challenges" })[0], {}), null);

const runnerSource = fs.readFileSync(path.join(__dirname, "..", "src", "maestro-runner.js"), "utf8");
assert.match(runnerSource, /failureStage: "fixture"/);
assert.match(runnerSource, /failureStage: "ui"/);
assert.match(runnerSource, /failureStage: "backend"/);
assert.match(runnerSource, /UI PASS \/ BACKEND PASS/);
assert.match(runnerSource, /UI PASS \/ BACKEND FAIL/);
fs.rmSync(fixtureRoot, { recursive: true, force: true });

console.log("SageSet Maestro runner contract verified.");
