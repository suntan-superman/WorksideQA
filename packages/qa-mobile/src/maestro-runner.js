const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const YAML = require("yaml");
const { ensureDir, fileExists, fromRoot, toPosixPath, writeJson } = require("../../qa-utils/src");

const FORBIDDEN_FLOW_TARGETS = [
  { pattern: /https?:\/\//i, description: "network endpoint" },
  { pattern: /\b(?:production|prod)\b/i, description: "production environment marker" },
];

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function normalizeFlowName(value) {
  return String(value || "").trim().replace(/\.ya?ml$/i, "");
}

function unique(values) {
  return [...new Set(values)];
}

function configuredCredentialKeys(mobile) {
  return unique(Object.values(mobile?.fixtures?.credentialEnvKeys || {}).filter(Boolean));
}

function validateFixtureConfiguration(mobile, productKey) {
  const fixtures = mobile?.fixtures;
  if (!fixtures) return null;
  if (!productKey || fixtures.owner !== productKey) {
    throw new Error("Each product must remain the owner of its Maestro fixture/reset implementation.");
  }
  if (!fixtures.command || !Array.isArray(fixtures.args) || fixtures.args.length === 0) {
    throw new Error("Product fixtures must declare a command and argument array.");
  }
  if (!Array.isArray(fixtures.scenarios) || fixtures.scenarios.length === 0) {
    throw new Error("Product fixtures must declare at least one supported scenario.");
  }
  if (unique(fixtures.scenarios).length !== fixtures.scenarios.length) {
    throw new Error("Product fixture scenario names must be unique.");
  }
  if (!mobile.applicationSourceEnvKey) {
    throw new Error("mobile.applicationSourceEnvKey is required for fixture orchestration.");
  }
  if (configuredCredentialKeys(mobile).length === 0) {
    throw new Error("Product fixture credential environment keys are required.");
  }
  if (fixtures.verification) {
    const verification = fixtures.verification;
    if (!verification.command || !Array.isArray(verification.args) || verification.args.length === 0) {
      throw new Error("Backend verification must declare a command and argument array.");
    }
    if (!Array.isArray(verification.mutations) || verification.mutations.length === 0) {
      throw new Error("Backend verification must declare supported mutations.");
    }
    if (unique(verification.mutations).length !== verification.mutations.length) {
      throw new Error("Backend verification mutation names must be unique.");
    }
  }
  return fixtures;
}

function collectEnvironmentReferences(source) {
  return unique([...source.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((match) => match[1]));
}

function validateFlowFile(flow, mobile) {
  const flowPath = path.isAbsolute(flow.path) ? flow.path : fromRoot(flow.path);
  if (!fileExists(flowPath)) {
    throw new Error(`Maestro flow file not found: ${flow.path}`);
  }

  const source = fs.readFileSync(flowPath, "utf8");
  const documents = YAML.parseAllDocuments(source);
  const yamlErrors = documents.flatMap((document) => document.errors || []);
  if (yamlErrors.length > 0) {
    throw new Error(`Invalid YAML in ${flow.path}: ${yamlErrors.map((error) => error.message).join("; ")}`);
  }
  if (documents.length !== 2) {
    throw new Error(`${flow.path} must contain one flow header and one command document separated by ---.`);
  }

  const header = documents[0].toJS();
  const commands = documents[1].toJS();
  if (!header || header.appId !== mobile.appId) {
    throw new Error(`${flow.path} must target the manifest appId ${mobile.appId}.`);
  }
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error(`${flow.path} must contain at least one Maestro command.`);
  }

  for (const forbidden of FORBIDDEN_FLOW_TARGETS) {
    if (forbidden.pattern.test(source)) {
      throw new Error(`${flow.path} contains a forbidden ${forbidden.description}.`);
    }
  }

  const expectedFileName = `${flow.name}.yaml`;
  if (path.basename(flowPath) !== expectedFileName) {
    throw new Error(`Flow ${flow.name} must use the matching filename ${expectedFileName}.`);
  }

  const references = collectEnvironmentReferences(source);
  const requiredEnv = unique(flow.requiredEnv || []);
  const allowedCredentialKeys = configuredCredentialKeys(mobile);
  for (const key of references) {
    if (!requiredEnv.includes(key)) {
      throw new Error(`${flow.path} references ${key}, but the manifest does not declare it in requiredEnv.`);
    }
    if (!allowedCredentialKeys.includes(key)) {
      throw new Error(`${flow.path} references undeclared credential key ${key}.`);
    }
  }
  for (const key of requiredEnv) {
    if (!references.includes(key)) {
      throw new Error(`Flow ${flow.name} declares unused required environment variable ${key}.`);
    }
  }

  return { ...flow, path: flowPath, references };
}

function validateMaestroConfiguration(config) {
  const mobile = config.mobile;
  if (!mobile?.enabled) throw new Error(`Mobile testing is not enabled for ${config.key}.`);
  if (mobile.orchestrationAuthority !== "worksideqa") {
    throw new Error("WorksideQA must remain the Maestro orchestration authority.");
  }
  if (!mobile.appId || !mobile.productionAppId || mobile.appId === mobile.productionAppId) {
    throw new Error("A distinct QA appId is required for Maestro execution.");
  }
  if (mobile.environment?.name !== "maestro") {
    throw new Error("The mobile environment must be explicitly named maestro.");
  }
  if (mobile.environment?.backend !== "firebase-emulators") {
    throw new Error("Maestro execution requires the Firebase emulator backend.");
  }
  if (mobile.environment?.externalNotificationsAllowed !== false) {
    throw new Error("External notifications must be disabled for Maestro execution.");
  }
  if (!mobile.environment?.firebaseProjectId) {
    throw new Error("The Maestro Firebase project id is required.");
  }
  if (mobile.environment.firebaseProjectId === config.firebase?.projectId) {
    throw new Error("The Maestro Firebase project must not match the product's production Firebase project.");
  }

  const fixtures = validateFixtureConfiguration(mobile, config.key);

  const maestro = mobile.maestro;
  if (!maestro?.reportDirectory || path.isAbsolute(maestro.reportDirectory) || maestro.reportDirectory.includes("..")) {
    throw new Error("mobile.maestro.reportDirectory must be a repository-relative path without parent traversal.");
  }
  if (!toPosixPath(maestro.reportDirectory).startsWith("reports/")) {
    throw new Error("Maestro reports must remain under the WorksideQA reports directory.");
  }
  if (!maestro.defaultSuite || !maestro.suites?.[maestro.defaultSuite]) {
    throw new Error("mobile.maestro.defaultSuite must reference a configured suite.");
  }

  const flows = (mobile.flows || []).map((flow) => validateFlowFile(flow, mobile));
  const flowNames = flows.map((flow) => flow.name);
  if (unique(flowNames).length !== flowNames.length) throw new Error("Maestro flow names must be unique.");
  for (const flow of flows) {
    if (flow.fixtureScenario && !fixtures) {
      throw new Error(`Flow ${flow.name} declares a fixture scenario without product-owned fixture configuration.`);
    }
    if (flow.fixtureScenario && !fixtures.scenarios.includes(flow.fixtureScenario)) {
      throw new Error(`Flow ${flow.name} references unsupported fixture scenario ${flow.fixtureScenario}.`);
    }
    if (flow.backendVerification) {
      if (!flow.fixtureScenario) {
        throw new Error(`Flow ${flow.name} must declare a fixture scenario before backend verification.`);
      }
      if (!fixtures.verification?.mutations?.includes(flow.backendVerification)) {
        throw new Error(`Flow ${flow.name} references unsupported backend verification ${flow.backendVerification}.`);
      }
      if (!["user-a", "user-b"].includes(flow.account)) {
        throw new Error(`Flow ${flow.name} must declare account user-a or user-b.`);
      }
      const accountPrefix = flow.account === "user-a" ? "userA" : "userB";
      const accountCredentialKeys = [
        fixtures.credentialEnvKeys?.[`${accountPrefix}Email`],
        fixtures.credentialEnvKeys?.[`${accountPrefix}Password`],
      ];
      if (accountCredentialKeys.some((key) => !key || !flow.requiredEnv?.includes(key))) {
        throw new Error(`Flow ${flow.name} must declare the email and password environment keys for ${flow.account}.`);
      }
    }
  }

  for (const [suiteName, suiteFlows] of Object.entries(maestro.suites || {})) {
    if (!Array.isArray(suiteFlows) || suiteFlows.length === 0) {
      throw new Error(`Maestro suite ${suiteName} must contain at least one flow.`);
    }
    for (const flowName of suiteFlows) {
      if (!flowNames.includes(flowName)) {
        throw new Error(`Maestro suite ${suiteName} references unknown flow ${flowName}.`);
      }
    }
  }

  return { mobile, maestro, flows };
}

function buildFixtureResetPlan(validated, flow, environment = process.env) {
  if (!flow.fixtureScenario) return null;
  const { mobile } = validated;
  const fixtures = mobile.fixtures;
  const sourceKey = mobile.applicationSourceEnvKey;
  const configuredSource = String(environment[sourceKey] || "").trim();
  if (!configuredSource) {
    throw new Error(`Missing ${sourceKey}; set it to the local SageSet/mobile repository before running ${flow.name}.`);
  }

  let sourceDirectory;
  try {
    sourceDirectory = fs.realpathSync(configuredSource);
  } catch {
    throw new Error(`${sourceKey} does not resolve to a readable directory: ${configuredSource}`);
  }
  const functionsPackage = path.join(sourceDirectory, "functions", "package.json");
  if (!fileExists(functionsPackage)) {
    throw new Error(`${sourceKey} must point to SageSet/mobile (missing functions/package.json at ${sourceDirectory}).`);
  }

  const credentialValues = {};
  for (const key of configuredCredentialKeys(mobile)) {
    const value = environment[key];
    if (!value) throw new Error(`Missing required SageSet fixture environment variable: ${key}`);
    credentialValues[key] = value;
  }

  const emulatorPorts = mobile.environment.emulators || {};
  const fixtureEnvironment = {
    ...environment,
    ...credentialValues,
    SAGESET_MAESTRO_ENVIRONMENT: "emulator",
    SAGESET_MAESTRO_FIREBASE_PROJECT_ID: mobile.environment.firebaseProjectId,
    SAGESET_MAESTRO_ALLOW_EXTERNAL_NOTIFICATIONS: "false",
    FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${emulatorPorts.auth}`,
    FIRESTORE_EMULATOR_HOST: `127.0.0.1:${emulatorPorts.firestore}`,
    FIREBASE_STORAGE_EMULATOR_HOST: `127.0.0.1:${emulatorPorts.storage}`,
    GCLOUD_PROJECT: mobile.environment.firebaseProjectId,
  };

  return {
    command: fixtures.command,
    args: [
      ...fixtures.args,
      "--scenario",
      flow.fixtureScenario,
      "--apply",
      "--confirm-reset",
    ],
    cwd: sourceDirectory,
    env: fixtureEnvironment,
    secretValues: Object.values(credentialValues).sort((left, right) => right.length - left.length),
  };
}

function buildBackendVerificationPlan(validated, flow, environment = process.env) {
  if (!flow.backendVerification) return null;
  const fixturePlan = buildFixtureResetPlan(validated, flow, environment);
  const verification = validated.mobile.fixtures.verification;
  return {
    ...fixturePlan,
    command: verification.command,
    args: [
      ...verification.args,
      "--mutation",
      flow.backendVerification,
    ],
  };
}

function selectFlows(validated, options = {}) {
  const { maestro, flows } = validated;
  if (options.flow) {
    const requested = normalizeFlowName(options.flow);
    const flow = flows.find((candidate) => normalizeFlowName(candidate.name) === requested);
    if (!flow) throw new Error(`Unknown Maestro flow: ${options.flow}`);
    return [flow];
  }

  const suiteName = options.suite || maestro.defaultSuite;
  const suite = maestro.suites[suiteName];
  if (!suite) throw new Error(`Unknown Maestro suite: ${suiteName}`);
  return suite.map((name) => flows.find((flow) => flow.name === name));
}

function redact(text, secretValues) {
  return secretValues.reduce((output, value) => {
    if (!value) return output;
    return output.split(value).join("[REDACTED]");
  }, String(text));
}

function createOutputSink(stream, logStream, secretValues) {
  let pending = "";
  return {
    write(chunk) {
      pending += chunk.toString();
      const lines = pending.split(/(?<=\n)/);
      pending = lines.pop() || "";
      for (const line of lines) {
        const safe = redact(line, secretValues);
        stream.write(safe);
        logStream.write(safe);
      }
    },
    flush() {
      if (!pending) return;
      const safe = redact(pending, secretValues);
      stream.write(safe);
      logStream.write(safe);
      pending = "";
    },
  };
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    const stdout = createOutputSink(process.stdout, options.logStream, options.secretValues);
    const stderr = createOutputSink(process.stderr, options.logStream, options.secretValues);
    child.stdout.on("data", (chunk) => stdout.write(chunk));
    child.stderr.on("data", (chunk) => stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      stdout.flush();
      stderr.flush();
      resolve({ code, signal });
    });
  });
}

function requireFlowEnvironment(flow) {
  const values = {};
  for (const key of flow.requiredEnv || []) {
    const value = process.env[key];
    if (!value) throw new Error(`Missing required environment variable for ${flow.name}: ${key}`);
    values[key] = value;
  }
  return values;
}

async function runMaestroFlows(config, options = {}) {
  const validated = validateMaestroConfiguration(config);
  const selected = selectFlows(validated, options);
  if (options.validateOnly) return { validated, selected };
  if (process.platform !== "darwin") {
    throw new Error("SageSet Maestro execution is restricted to macOS. Use --validate on other platforms.");
  }

  const runnerEnv = {
    ...process.env,
    MAESTRO_CLI_NO_ANALYTICS: "true",
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true",
    MAESTRO_DISABLE_UPDATE_CHECK: "true",
  };
  const version = spawnSync("maestro", ["--version"], { cwd: fromRoot(), env: runnerEnv, encoding: "utf8" });
  if (version.error || version.status !== 0) {
    throw new Error("Maestro is not installed or is not available on PATH.");
  }

  const runDirectory = fromRoot(validated.maestro.reportDirectory, timestampSlug());
  ensureDir(runDirectory);
  console.log(`Maestro ${String(version.stdout || version.stderr).trim()}`);
  console.log(`Artifacts: ${toPosixPath(path.relative(fromRoot(), runDirectory))}`);

  const results = [];
  for (const flow of selected) {
    const environmentValues = requireFlowEnvironment(flow);
    const flowDirectory = ensureDir(path.join(runDirectory, flow.name));
    const artifactDirectory = ensureDir(path.join(flowDirectory, "artifacts"));
    const junitPath = path.join(flowDirectory, "junit.xml");
    const logPath = path.join(flowDirectory, "runner.log");
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    let fixturePlan;
    let backendPlan;
    try {
      fixturePlan = buildFixtureResetPlan(validated, flow);
      backendPlan = buildBackendVerificationPlan(validated, flow);
    } catch (error) {
      const result = {
        flow: flow.name,
        status: "failed",
        failureStage: "fixture-setup",
        stages: {
          fixture: { status: "failed", scenario: flow.fixtureScenario || null },
          ui: { status: "not-run" },
          backend: { status: "not-run", verification: flow.backendVerification || null },
        },
      };
      results.push(result);
      writeJson(path.join(flowDirectory, "result.json"), result);
      writeJson(path.join(runDirectory, "summary.json"), { status: "failed", results });
      logStream.end();
      throw new Error(`FIXTURE SETUP FAILED: ${flow.name}\n${error.message}`);
    }
    const secretValues = unique([
      ...Object.values(environmentValues),
      ...(fixturePlan?.secretValues || []),
      ...(backendPlan?.secretValues || []),
    ]).sort((left, right) => right.length - left.length);
    const relativeArtifacts = toPosixPath(path.relative(fromRoot(), artifactDirectory));
    const relativeJunit = toPosixPath(path.relative(fromRoot(), junitPath));
    const relativeFlow = toPosixPath(path.relative(fromRoot(), flow.path));
    const environmentArgs = Object.entries(environmentValues).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    const args = [
      "test",
      "--no-ansi",
      `--test-output-dir=${relativeArtifacts}`,
      `--debug-output=${relativeArtifacts}`,
      "--format",
      "junit",
      "--output",
      relativeJunit,
      ...environmentArgs,
      relativeFlow,
    ];

    console.log(`\n[Maestro] Running ${flow.name}`);
    let fixtureStatus = fixturePlan ? "pending" : "skipped";
    if (fixturePlan) {
      try {
        console.log(`[Fixture] Applying ${flow.fixtureScenario}`);
        const fixtureOutcome = await runProcess(fixturePlan.command, fixturePlan.args, {
          cwd: fixturePlan.cwd,
          env: fixturePlan.env,
          logStream,
          secretValues,
        });
        if (fixtureOutcome.code !== 0) {
          throw new Error(`SageSet fixture reset exited with ${fixtureOutcome.code ?? "unknown"}.`);
        }
        fixtureStatus = "passed";
        console.log(`[Fixture] Applied ${flow.fixtureScenario}`);
      } catch (error) {
        const result = {
          flow: flow.name,
          status: "failed",
          failureStage: "fixture",
          stages: {
            fixture: { status: "failed", scenario: flow.fixtureScenario || null },
            ui: { status: "not-run" },
            backend: { status: "not-run", verification: flow.backendVerification || null },
          },
          report: toPosixPath(path.relative(fromRoot(), junitPath)),
          artifacts: relativeArtifacts,
        };
        results.push(result);
        writeJson(path.join(flowDirectory, "result.json"), result);
        writeJson(path.join(runDirectory, "summary.json"), { status: "failed", results });
        logStream.end();
        throw new Error(`FIXTURE FAILED: ${flow.name}\n${error.message}. See ${relativeArtifacts}.`);
      }
    }

    let outcome;
    try {
      outcome = await runProcess("maestro", args, {
        cwd: fromRoot(),
        env: runnerEnv,
        logStream,
        secretValues,
      });
    } catch (error) {
      const result = {
        flow: flow.name,
        status: "failed",
        failureStage: "ui",
        stages: {
          fixture: { status: fixtureStatus, scenario: flow.fixtureScenario || null },
          ui: { status: "failed" },
          backend: { status: "not-run", verification: flow.backendVerification || null },
        },
        report: toPosixPath(path.relative(fromRoot(), junitPath)),
        artifacts: relativeArtifacts,
      };
      results.push(result);
      writeJson(path.join(flowDirectory, "result.json"), result);
      writeJson(path.join(runDirectory, "summary.json"), { status: "failed", results });
      logStream.end();
      throw new Error(`UI FAILED: ${flow.name}\n${error.message}. See ${relativeArtifacts}.`);
    }
    if (outcome.code !== 0) {
      const result = {
        flow: flow.name,
        status: "failed",
        failureStage: "ui",
        exitCode: outcome.code,
        signal: outcome.signal || null,
        stages: {
          fixture: { status: fixtureStatus, scenario: flow.fixtureScenario || null },
          ui: { status: "failed", exitCode: outcome.code },
          backend: { status: "not-run", verification: flow.backendVerification || null },
        },
        report: toPosixPath(path.relative(fromRoot(), junitPath)),
        artifacts: relativeArtifacts,
      };
      results.push(result);
      writeJson(path.join(flowDirectory, "result.json"), result);
      writeJson(path.join(runDirectory, "summary.json"), { status: "failed", results });
      logStream.end();
      throw new Error(`UI FAILED: ${flow.name} (exit ${outcome.code ?? "unknown"}). See ${relativeArtifacts}.`);
    }

    let backendStatus = backendPlan ? "pending" : "skipped";
    if (backendPlan) {
      console.log(`[Backend] Verifying ${flow.backendVerification}`);
      let backendOutcome;
      try {
        backendOutcome = await runProcess(backendPlan.command, backendPlan.args, {
          cwd: backendPlan.cwd,
          env: backendPlan.env,
          logStream,
          secretValues,
        });
      } catch (error) {
        backendOutcome = { code: null, signal: null, error };
      }
      if (backendOutcome.code !== 0) {
        const result = {
          flow: flow.name,
          status: "failed",
          failureStage: "backend",
          exitCode: outcome.code,
          backendExitCode: backendOutcome.code,
          stages: {
            fixture: { status: fixtureStatus, scenario: flow.fixtureScenario || null },
            ui: { status: "passed", exitCode: outcome.code },
            backend: { status: "failed", verification: flow.backendVerification, exitCode: backendOutcome.code },
          },
          report: toPosixPath(path.relative(fromRoot(), junitPath)),
          artifacts: relativeArtifacts,
        };
        results.push(result);
        writeJson(path.join(flowDirectory, "result.json"), result);
        writeJson(path.join(runDirectory, "summary.json"), { status: "failed", results });
        logStream.end();
        const detail = backendOutcome.error ? ` ${backendOutcome.error.message}` : "";
        throw new Error(`UI PASS / BACKEND FAIL: ${flow.name} (exit ${backendOutcome.code ?? "unknown"}).${detail} See ${relativeArtifacts}.`);
      }
      backendStatus = "passed";
      console.log(`[Backend] Passed ${flow.backendVerification}`);
    }

    const result = {
      flow: flow.name,
      status: "passed",
      exitCode: outcome.code,
      signal: outcome.signal || null,
      stages: {
        fixture: { status: fixtureStatus, scenario: flow.fixtureScenario || null },
        ui: { status: "passed", exitCode: outcome.code },
        backend: { status: backendStatus, verification: flow.backendVerification || null },
      },
      report: toPosixPath(path.relative(fromRoot(), junitPath)),
      artifacts: relativeArtifacts,
    };
    results.push(result);
    writeJson(path.join(flowDirectory, "result.json"), result);
    logStream.end();
    console.log(backendPlan ? `[Maestro] UI PASS / BACKEND PASS: ${flow.name}` : `[Maestro] Passed ${flow.name}`);
  }

  writeJson(path.join(runDirectory, "summary.json"), { status: "passed", results });
  return { runDirectory, results };
}

module.exports = {
  buildBackendVerificationPlan,
  buildFixtureResetPlan,
  collectEnvironmentReferences,
  normalizeFlowName,
  runMaestroFlows,
  selectFlows,
  validateFixtureConfiguration,
  validateMaestroConfiguration,
};
