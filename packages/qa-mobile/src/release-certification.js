const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ensureDir, fromRoot, readJson, slugTimestamp, toPosixPath, writeText } = require("../../qa-utils/src");
const { runMaestroFlows, validateMaestroConfiguration } = require("./maestro-runner");
const {
  finalizeCertification,
  redactText,
  validateReportContract,
  writeCertificationArtifacts,
} = require("./release-certification-report");

const REQUIRED_SUITES = Object.freeze(["phase1", "phase2", "phase3", "phase4", "phase5", "phase6"]);
const EXPECTED_PROJECT_ID = "sageset-maestro-local";
const EXPECTED_APP_ID = "com.workside.sageset";

class ReleaseSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseSafetyError";
  }
}

const unique = (values) => [...new Set(values)];
const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const loopbackHost = (value, port) => [`127.0.0.1:${port}`, `localhost:${port}`].includes(String(value || "").trim().toLowerCase());
const phaseLabel = (suite) => `Phase ${String(suite).replace(/^phase/, "")}`;

function validateReleaseCertificationConfiguration(config) {
  const maestro = validateMaestroConfiguration(config);
  const release = maestro.mobile.releaseCertification;
  if (!release || typeof release !== "object") throw new Error("mobile.releaseCertification is required.");
  if (!Array.isArray(release.suites) || release.suites.length === 0) throw new Error("Release certification suites are required.");
  if (unique(release.suites).length !== release.suites.length) throw new Error("Release certification suites must be unique.");
  for (const suite of REQUIRED_SUITES) {
    if (!release.suites.includes(suite)) throw new Error(`Release certification is missing required suite ${suite}.`);
  }
  if (release.suites.length !== REQUIRED_SUITES.length) throw new Error("Release certification must contain exactly Phases 1–6.");
  for (const suite of release.suites) {
    if (!maestro.maestro.suites[suite]) throw new Error(`Release certification references unknown suite ${suite}.`);
  }
  if (!release.artifactDirectory || path.isAbsolute(release.artifactDirectory) || release.artifactDirectory.includes("..")) {
    throw new Error("Release certification artifactDirectory must be repository-relative without parent traversal.");
  }
  if (!toPosixPath(release.artifactDirectory).startsWith("reports/mobile/sageset/release-certification")) {
    throw new Error("Release certification artifacts must remain under reports/mobile/sageset/release-certification.");
  }
  if (release.requireCleanRepositories !== true) throw new Error("SageSet release certification must require clean repositories.");
  if (!Array.isArray(release.preflight) || release.preflight.length === 0) throw new Error("Release certification preflight checks are required.");
  const checkIds = release.preflight.map((check) => check.id);
  if (unique(checkIds).length !== checkIds.length) throw new Error("Release certification preflight ids must be unique.");
  for (const check of release.preflight) {
    if (!check.id || !check.label || !["sageset", "worksideqa"].includes(check.owner)) {
      throw new Error("Every release preflight check requires id, label, and a supported owner.");
    }
    if (!Array.isArray(check.commands) || check.commands.length === 0 || check.commands.some((command) => !Array.isArray(command) || command.length < 1)) {
      throw new Error(`Release preflight ${check.id} requires command arrays.`);
    }
  }
  return { ...maestro, release };
}

function resolveSageSetRepository(validated, environment) {
  const key = validated.mobile.applicationSourceEnvKey;
  const configured = String(environment[key] || "").trim();
  if (!configured) throw new ReleaseSafetyError(`Missing ${key}; it must point to the SageSet Mobile repository.`);
  let directory;
  try {
    directory = fs.realpathSync(configured);
  } catch {
    throw new ReleaseSafetyError(`${key} does not resolve to a readable directory: ${configured}`);
  }
  if (!fs.existsSync(path.join(directory, "functions", "package.json")) || !fs.existsSync(path.join(directory, "app.config.js"))) {
    throw new ReleaseSafetyError(`${key} must point to SageSet Mobile with functions/package.json and app.config.js.`);
  }
  return directory;
}

function validateSafetyValues(validated, environment, { requireCredentials = true } = {}) {
  if (String(environment.SAGESET_MAESTRO_ENVIRONMENT || "").toLowerCase() !== "emulator") {
    throw new ReleaseSafetyError("SAGESET_MAESTRO_ENVIRONMENT must be emulator.");
  }
  if (environment.SAGESET_MAESTRO_FIREBASE_PROJECT_ID !== EXPECTED_PROJECT_ID) {
    throw new ReleaseSafetyError(`Firebase project must be exactly ${EXPECTED_PROJECT_ID}.`);
  }
  if (!loopbackHost(environment.FIREBASE_AUTH_EMULATOR_HOST, 9099)) {
    throw new ReleaseSafetyError("FIREBASE_AUTH_EMULATOR_HOST must be loopback port 9099.");
  }
  if (!loopbackHost(environment.FIRESTORE_EMULATOR_HOST, 8080)) {
    throw new ReleaseSafetyError("FIRESTORE_EMULATOR_HOST must be loopback port 8080.");
  }
  if (String(environment.SAGESET_MAESTRO_ALLOW_EXTERNAL_NOTIFICATIONS || "").toLowerCase() !== "false") {
    throw new ReleaseSafetyError("External notifications must be explicitly disabled.");
  }
  if (validated.mobile.environment.firebaseProjectId !== EXPECTED_PROJECT_ID || validated.mobile.appId !== EXPECTED_APP_ID) {
    throw new ReleaseSafetyError("Manifest QA project or app identity does not match the SageSet certification contract.");
  }
  if (!requireCredentials) return;
  const keys = validated.mobile.fixtures.credentialEnvKeys;
  const userAEmail = normalizeEmail(environment[keys.userAEmail]);
  const userBEmail = normalizeEmail(environment[keys.userBEmail]);
  const userAPassword = String(environment[keys.userAPassword] || "");
  const userBPassword = String(environment[keys.userBPassword] || "");
  if (!userAEmail || !userBEmail || userAEmail === userBEmail || !userAPassword || !userBPassword) {
    throw new ReleaseSafetyError("Both deterministic Maestro account credentials are required.");
  }
  const allowlist = new Set(String(environment[keys.emailAllowlist] || "").split(",").map(normalizeEmail).filter(Boolean));
  if (allowlist.size !== 2 || !allowlist.has(userAEmail) || !allowlist.has(userBEmail)) {
    throw new ReleaseSafetyError("The QA email allowlist must contain exactly deterministic User A and User B.");
  }
}

function nativeCommand(command) {
  return process.platform === "win32" && ["npm", "npx"].includes(command) ? `${command}.cmd` : command;
}

function defaultCommandSync(command, args, options = {}) {
  return spawnSync(nativeCommand(command), args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    shell: process.platform === "win32" && ["npm", "npx"].includes(command),
  });
}

function commandSucceeded(result) {
  return !result?.error && result?.status === 0;
}

function gitMetadata(directory, commandSync = defaultCommandSync) {
  const commit = commandSync("git", ["-C", directory, "rev-parse", "HEAD"], { cwd: directory, env: process.env });
  const status = commandSync("git", ["-C", directory, "status", "--porcelain"], { cwd: directory, env: process.env });
  if (!commandSucceeded(commit) || !commandSucceeded(status)) throw new ReleaseSafetyError(`Unable to inspect Git metadata for ${directory}.`);
  const porcelain = String(status.stdout || "").trim();
  return { path: toPosixPath(directory), commit: String(commit.stdout || "").trim(), clean: porcelain.length === 0 };
}

function validateRuntimeEnvironment(validated, environment = process.env, options = {}) {
  const commandSync = options.commandSync || defaultCommandSync;
  validateSafetyValues(validated, environment, { requireCredentials: true });
  const sageSet = resolveSageSetRepository(validated, environment);
  const worksideqa = fs.realpathSync(fromRoot());
  const platform = options.platform || process.platform;
  if (platform !== "darwin") throw new ReleaseSafetyError("Full SageSet release certification is restricted to macOS.");

  const maestro = commandSync("maestro", ["--version"], { cwd: worksideqa, env: environment });
  if (!commandSucceeded(maestro)) throw new ReleaseSafetyError("Maestro CLI is not available on PATH.");
  const devices = commandSync("xcrun", ["simctl", "list", "devices", "booted", "-j"], { cwd: worksideqa, env: environment });
  if (!commandSucceeded(devices)) throw new ReleaseSafetyError("Unable to inspect the iOS Simulator state.");
  let bootedDevices = [];
  try {
    const parsed = JSON.parse(String(devices.stdout || "{}"));
    bootedDevices = Object.values(parsed.devices || {}).flat().filter((device) => device.state === "Booted");
  } catch {
    throw new ReleaseSafetyError("The iOS Simulator device response was invalid.");
  }
  if (bootedDevices.length === 0) throw new ReleaseSafetyError("An iOS Simulator must be booted.");
  const app = commandSync("xcrun", ["simctl", "get_app_container", "booted", EXPECTED_APP_ID, "app"], { cwd: worksideqa, env: environment });
  if (!commandSucceeded(app)) throw new ReleaseSafetyError(`${EXPECTED_APP_ID} is not installed on the booted simulator.`);
  const launch = commandSync("xcrun", ["simctl", "launch", "--terminate-running-process", "booted", EXPECTED_APP_ID], { cwd: worksideqa, env: environment });
  if (!commandSucceeded(launch)) throw new ReleaseSafetyError(`${EXPECTED_APP_ID} is installed but could not be launched.`);

  const repositories = {
    worksideqa: gitMetadata(worksideqa, commandSync),
    sageSetMobile: gitMetadata(sageSet, commandSync),
  };
  if (validated.release.requireCleanRepositories && (!repositories.worksideqa.clean || !repositories.sageSetMobile.clean)) {
    throw new ReleaseSafetyError("WorksideQA and SageSet Mobile must both have clean Git worktrees for release certification.");
  }
  return {
    directories: { worksideqa, sageSet },
    repositories,
    environment: {
      firebaseProjectId: EXPECTED_PROJECT_ID,
      authEmulatorHost: environment.FIREBASE_AUTH_EMULATOR_HOST,
      firestoreEmulatorHost: environment.FIRESTORE_EMULATOR_HOST,
      emulatorOnly: true,
      externalNotificationsAllowed: false,
      maestroVersion: String(maestro.stdout || maestro.stderr || "").trim(),
      platform: "ios",
      appId: EXPECTED_APP_ID,
      simulatorDevice: bootedDevices[0].name || null,
      nodeVersion: process.version,
      npmVersion: String((commandSync("npm", ["--version"], { cwd: worksideqa, env: environment }).stdout) || "").trim() || null,
    },
  };
}

function configuredSecrets(validated, environment) {
  const keys = Object.values(validated.mobile.fixtures.credentialEnvKeys || {});
  const sensitiveEnvironmentValues = Object.entries(environment)
    .filter(([key, value]) => value && /(PASSWORD|PASSCODE|TOKEN|SECRET|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|SERVICE[_-]?ACCOUNT|TWILIO|SENDGRID|OPENAI|STRIPE)/i.test(key))
    .map(([, value]) => String(value));
  return unique([
    ...keys.map((key) => environment[key]).filter(Boolean).map(String),
    ...sensitiveEnvironmentValues,
  ]);
}

function runPreflight(validated, context, options = {}) {
  const commandSync = options.commandSync || defaultCommandSync;
  const secretValues = configuredSecrets(validated, context.environmentVariables);
  const results = [];
  for (const check of validated.release.preflight) {
    const cwd = check.owner === "sageset" ? context.directories.sageSet : context.directories.worksideqa;
    const outputs = [];
    let exitCode = 0;
    let message = "Passed.";
    const startedAt = Date.now();
    for (const commandSpec of check.commands) {
      const [command, ...args] = commandSpec;
      const outcome = commandSync(command, args, { cwd, env: context.environmentVariables });
      outputs.push(`$ ${commandSpec.join(" ")}\n${outcome.stdout || ""}${outcome.stderr || ""}`);
      if (!commandSucceeded(outcome)) {
        exitCode = outcome.status ?? 1;
        message = outcome.error?.message || `${commandSpec.join(" ")} exited with ${exitCode}.`;
        break;
      }
    }
    let artifact = null;
    if (context.artifactDirectory) {
      const logPath = path.join(context.artifactDirectory, "preflight", `${check.id}.log`);
      writeText(logPath, redactText(`${outputs.join("\n")}\n`, secretValues));
      artifact = toPosixPath(path.relative(context.directories.worksideqa, logPath));
    }
    results.push({
      id: check.id,
      label: check.label,
      status: exitCode === 0 ? "passed" : "failed",
      exitCode,
      durationMs: Date.now() - startedAt,
      message,
      artifact,
    });
  }
  return results;
}

function normalizePhaseResult(validated, suite, runDirectory, execution, error) {
  const expectedFlows = validated.maestro.suites[suite];
  let recorded = execution?.results || [];
  const summaryPath = path.join(runDirectory, "summary.json");
  if (recorded.length === 0 && fs.existsSync(summaryPath)) recorded = readJson(summaryPath).results || [];
  const byName = new Map(recorded.map((flow) => [flow.flow, flow]));
  const flows = expectedFlows.map((name) => byName.get(name) || {
    flow: name,
    status: "not-run",
    failureStage: "not-run",
    message: error ? "Not run after an earlier failure in this phase." : "No result was produced.",
    stages: { fixture: { status: "not-run" }, ui: { status: "not-run" }, backend: { status: "not-run", verification: null } },
  });
  const failed = flows.filter((flow) => flow.status === "failed");
  const passed = flows.filter((flow) => flow.status === "passed");
  return {
    name: suite,
    label: phaseLabel(suite),
    status: !error && passed.length === flows.length ? "passed" : "failed",
    flowCount: flows.length,
    flowsPassed: passed.length,
    flowsFailed: failed.length,
    flowsNotRun: flows.filter((flow) => flow.status === "not-run").length,
    message: error ? error.message : "Passed.",
    artifact: toPosixPath(path.relative(fromRoot(), runDirectory)),
    flows,
  };
}

async function defaultExecutePhase(config, validated, suite, runDirectory) {
  try {
    const execution = await runMaestroFlows(config, { suite, runDirectory });
    return normalizePhaseResult(validated, suite, runDirectory, execution, null);
  } catch (error) {
    return normalizePhaseResult(validated, suite, runDirectory, null, error);
  }
}

function printStart() {
  console.log("============================================================");
  console.log("SageSet Maestro Release Certification");
  console.log("============================================================");
  console.log("Environment: emulator");
  console.log(`Project: ${EXPECTED_PROJECT_ID}`);
  console.log(`App: ${EXPECTED_APP_ID}`);
  console.log("External notifications: disabled");
}

function printSummary(certification) {
  console.log("\n============================================================");
  console.log("SageSet Release Certification");
  console.log("============================================================");
  console.log(`Preflight   ${certification.preflight.every((check) => check.status === "passed") ? "PASS" : "FAIL"}`);
  for (const phase of certification.phases) console.log(`${phase.label.padEnd(12)}${phase.status === "passed" ? "PASS" : "FAIL"}`);
  console.log("------------------------------------------------------------");
  console.log(`Flows       ${certification.summary.flowsPassed}/${certification.summary.flowsTotal} ${certification.summary.flowsTotal > 0 && certification.summary.flowsFailed === 0 && certification.summary.flowsNotRun === 0 ? "PASS" : "FAIL"}`);
  console.log(`Backend     ${certification.backendVerification.status === "passed" ? "PASS" : certification.backendVerification.status === "not-run" ? "NOT RUN" : "FAIL"}`);
  console.log(`Artifacts   ${certification.artifacts.status === "passed" ? "PASS" : "FAIL"}`);
  console.log("------------------------------------------------------------");
  console.log(`Overall: ${certification.releaseCertified ? "RELEASE CERTIFIED" : "RELEASE NOT CERTIFIED"}`);
  console.log("============================================================");
}

async function validateReleaseCertification(config, options = {}) {
  const validated = validateReleaseCertificationConfiguration(config);
  validateReportContract();
  const environment = options.environment || process.env;
  const sageSet = resolveSageSetRepository(validated, environment);
  if (environment.SAGESET_MAESTRO_ENVIRONMENT || environment.SAGESET_MAESTRO_FIREBASE_PROJECT_ID) {
    validateSafetyValues(validated, environment, { requireCredentials: true });
  }
  const context = {
    directories: { worksideqa: fs.realpathSync(fromRoot()), sageSet },
    environmentVariables: environment,
    artifactDirectory: null,
  };
  const preflight = runPreflight(validated, context, { commandSync: options.commandSync });
  if (preflight.some((check) => check.status === "failed")) {
    throw new Error(`Release certification validation failed: ${preflight.filter((check) => check.status === "failed").map((check) => check.label).join(", ")}.`);
  }
  return { validated, preflight };
}

async function runReleaseCertification(config, options = {}) {
  const validated = validateReleaseCertificationConfiguration(config);
  const environmentVariables = options.environment || process.env;
  const startedAt = new Date(options.now ? options.now() : Date.now()).toISOString();
  const commandSync = options.commandSync || defaultCommandSync;
  const executePhase = options.executePhase || defaultExecutePhase;
  const artifactDirectory = options.artifactDirectory || fromRoot(validated.release.artifactDirectory, slugTimestamp(new Date(startedAt)));
  const secretValues = configuredSecrets(validated, environmentVariables);
  printStart();

  let runtime;
  try {
    runtime = validateRuntimeEnvironment(validated, environmentVariables, { commandSync, platform: options.platform });
  } catch (error) {
    const input = {
      startedAt,
      completedAt: new Date(options.now ? options.now() : Date.now()).toISOString(),
      environment: { firebaseProjectId: EXPECTED_PROJECT_ID, emulatorOnly: true, externalNotificationsAllowed: false, platform: "ios", appId: EXPECTED_APP_ID },
      repositories: {},
      preflight: [{ id: "environment-safety", label: "Environment safety", status: "failed", message: error.message }],
      phases: [],
    };
    const output = writeCertificationArtifacts(input, artifactDirectory, secretValues);
    printSummary(output.certification);
    return output.certification;
  }

  const preflight = runPreflight(validated, {
    directories: runtime.directories,
    environmentVariables,
    artifactDirectory,
  }, { commandSync });
  const phases = [];
  for (const suite of validated.release.suites) {
    const phaseDirectory = ensureDir(path.join(artifactDirectory, "phases", suite));
    try {
      phases.push(await executePhase(config, validated, suite, phaseDirectory));
    } catch (error) {
      phases.push(normalizePhaseResult(validated, suite, phaseDirectory, null, error));
    }
  }
  const output = writeCertificationArtifacts({
    startedAt,
    completedAt: new Date(options.now ? options.now() : Date.now()).toISOString(),
    environment: runtime.environment,
    repositories: runtime.repositories,
    preflight,
    phases,
  }, artifactDirectory, secretValues);
  printSummary(output.certification);
  return output.certification;
}

module.exports = {
  EXPECTED_APP_ID,
  EXPECTED_PROJECT_ID,
  REQUIRED_SUITES,
  ReleaseSafetyError,
  configuredSecrets,
  defaultExecutePhase,
  gitMetadata,
  normalizePhaseResult,
  runPreflight,
  runReleaseCertification,
  validateReleaseCertification,
  validateReleaseCertificationConfiguration,
  validateRuntimeEnvironment,
  validateSafetyValues,
};
