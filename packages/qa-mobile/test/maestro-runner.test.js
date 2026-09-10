const assert = require("node:assert/strict");
const { loadProductManifest } = require("../../qa-config/src");
const {
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

console.log("SageSet Maestro runner contract verified.");
