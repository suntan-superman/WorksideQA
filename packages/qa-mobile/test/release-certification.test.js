const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadProductManifest } = require("../../qa-config/src");
const {
  REQUIRED_SUITES,
  configuredSecrets,
  runReleaseCertification,
  validateReleaseCertificationConfiguration,
  validateRuntimeEnvironment,
  validateSafetyValues,
} = require("../src/release-certification");

const clone = (value) => JSON.parse(JSON.stringify(value));
const manifest = loadProductManifest("sageset");
const validated = validateReleaseCertificationConfiguration(manifest);

assert.deepEqual(validated.release.suites, REQUIRED_SUITES);
assert.equal(new Set(validated.release.suites).size, 6);
assert.equal(validated.release.requireCleanRepositories, true);

const missingPhase = clone(manifest);
missingPhase.mobile.releaseCertification.suites.pop();
assert.throws(() => validateReleaseCertificationConfiguration(missingPhase), /missing required suite phase6/);

const duplicatePhase = clone(manifest);
duplicatePhase.mobile.releaseCertification.suites[5] = "phase5";
assert.throws(() => validateReleaseCertificationConfiguration(duplicatePhase), /must be unique/);

const safetyEnvironment = {
  SAGESET_MAESTRO_ENVIRONMENT: "emulator",
  SAGESET_MAESTRO_FIREBASE_PROJECT_ID: "sageset-maestro-local",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIRESTORE_EMULATOR_HOST: "localhost:8080",
  SAGESET_MAESTRO_ALLOW_EXTERNAL_NOTIFICATIONS: "false",
  SAGESET_MAESTRO_USER_A_EMAIL: "maestro.a@example.com",
  SAGESET_MAESTRO_USER_A_PASSWORD: "password-a",
  SAGESET_MAESTRO_USER_B_EMAIL: "maestro.b@example.com",
  SAGESET_MAESTRO_USER_B_PASSWORD: "password-b",
  SAGESET_MAESTRO_QA_EMAIL_ALLOWLIST: "maestro.a@example.com,maestro.b@example.com",
};
validateSafetyValues(validated, safetyEnvironment);
assert.ok(configuredSecrets(validated, { ...safetyEnvironment, OPENAI_API_KEY: "provider-secret" }).includes("provider-secret"));

for (const [key, value, pattern] of [
  ["SAGESET_MAESTRO_FIREBASE_PROJECT_ID", "production-project", /exactly sageset-maestro-local/],
  ["FIREBASE_AUTH_EMULATOR_HOST", "firebase.example.com:9099", /loopback port 9099/],
  ["FIRESTORE_EMULATOR_HOST", "10.0.0.2:8080", /loopback port 8080/],
  ["SAGESET_MAESTRO_ALLOW_EXTERNAL_NOTIFICATIONS", "true", /explicitly disabled/],
  ["SAGESET_MAESTRO_USER_A_PASSWORD", "", /credentials are required/],
]) {
  const unsafe = { ...safetyEnvironment, [key]: value };
  assert.throws(() => validateSafetyValues(validated, unsafe), pattern);
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sageset-cert-"));
const fakeSageSet = path.join(temporaryRoot, "sagesetmobile");
fs.mkdirSync(path.join(fakeSageSet, "functions"), { recursive: true });
fs.writeFileSync(path.join(fakeSageSet, "functions", "package.json"), "{}\n");
fs.writeFileSync(path.join(fakeSageSet, "app.config.js"), "module.exports = {};\n");

function fakeCommand({ dirty = false } = {}) {
  return (command, args) => {
    if (command === "maestro") return { status: 0, stdout: "2.10.0\n" };
    if (command === "xcrun" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify({ devices: { runtime: [{ state: "Booted", name: "iPhone 17" }] } }) };
    }
    if (command === "xcrun" && args[1] === "get_app_container") return { status: 0, stdout: "/sim/SageSetQA.app\n" };
    if (command === "git" && args.includes("rev-parse")) return { status: 0, stdout: "0123456789abcdef\n" };
    if (command === "git" && args.includes("status")) return { status: 0, stdout: dirty ? " M changed.js\n" : "" };
    if (command === "npm" && args[0] === "--version") return { status: 0, stdout: "10.9.0\n" };
    return { status: 0, stdout: "passed\n", stderr: "" };
  };
}

const runtimeEnvironment = { ...safetyEnvironment, SAGESET_MOBILE_REPO: fakeSageSet };
const runtime = validateRuntimeEnvironment(validated, runtimeEnvironment, { commandSync: fakeCommand(), platform: "darwin" });
assert.equal(runtime.environment.appId, "com.workside.sageset");
assert.equal(runtime.repositories.sageSetMobile.clean, true);
assert.throws(
  () => validateRuntimeEnvironment(validated, runtimeEnvironment, { commandSync: fakeCommand({ dirty: true }), platform: "darwin" }),
  /clean Git worktrees/
);

function phaseResult(validatedConfig, suite, failedSuite) {
  const flows = validatedConfig.maestro.suites[suite].map((flow) => ({
    flow,
    status: suite === failedSuite ? "failed" : "passed",
    failureStage: suite === failedSuite ? "ui" : null,
    message: suite === failedSuite ? "Deterministic UI failure." : "Passed.",
    stages: { backend: { status: "passed", verification: "fixture-verifier" } },
  }));
  return {
    name: suite,
    label: `Phase ${suite.replace("phase", "")}`,
    status: suite === failedSuite ? "failed" : "passed",
    flowCount: flows.length,
    flowsPassed: suite === failedSuite ? 0 : flows.length,
    flowsFailed: suite === failedSuite ? flows.length : 0,
    flowsNotRun: 0,
    message: suite === failedSuite ? "Failed." : "Passed.",
    flows,
  };
}

async function simulatedCertification(failedSuite = null) {
  const executed = [];
  const artifactDirectory = path.join(temporaryRoot, `run-${failedSuite || "passed"}`);
  const certification = await runReleaseCertification(manifest, {
    environment: runtimeEnvironment,
    commandSync: fakeCommand(),
    platform: "darwin",
    artifactDirectory,
    executePhase: async (_config, validatedConfig, suite) => {
      executed.push(suite);
      return phaseResult(validatedConfig, suite, failedSuite);
    },
    now: () => Date.parse("2026-09-11T00:00:00.000Z"),
  });
  return { certification, executed, artifactDirectory };
}

(async () => {
  try {
    const passed = await simulatedCertification();
    assert.equal(passed.certification.releaseCertified, true);
    assert.deepEqual(passed.executed, REQUIRED_SUITES);
    assert.equal(passed.certification.summary.phaseCount, 6);
    for (const suite of REQUIRED_SUITES) {
      assert.equal(fs.existsSync(path.join(passed.artifactDirectory, "phases", suite)), true);
    }
    for (const artifactPath of Object.values(passed.certification.artifacts.files)) {
      assert.equal(fs.existsSync(artifactPath), true);
    }

    const failed = await simulatedCertification("phase2");
    assert.equal(failed.certification.releaseCertified, false);
    assert.deepEqual(failed.executed, REQUIRED_SUITES);
    assert.equal(failed.certification.summary.phasesFailed, 1);

    let unsafeExecutions = 0;
    const unsafe = await runReleaseCertification(manifest, {
      environment: { ...runtimeEnvironment, SAGESET_MAESTRO_FIREBASE_PROJECT_ID: "production" },
      commandSync: fakeCommand(),
      platform: "darwin",
      artifactDirectory: path.join(temporaryRoot, "unsafe"),
      executePhase: async () => { unsafeExecutions += 1; },
    });
    assert.equal(unsafe.releaseCertified, false);
    assert.equal(unsafeExecutions, 0);
    assert.equal(unsafe.failures[0].stage, "environment");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  console.log("SageSet release certification orchestration tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
