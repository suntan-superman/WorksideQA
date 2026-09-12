const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { parseAuthoritativeResult } = require('./authoritative-result');
const { ensureDir, fileExists, fromRoot, spawnCommand, terminateProcessTree, toPosixPath, writeJson } = require("../../qa-utils/src");
const { resolveConfiguredDevice, validateDeviceDescriptors } = require('./device-selection');
const { spawnMaestro, spawnMaestroSync, terminateMaestro } = require("./maestro-process");

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
  if (!fixtures.sourceEnvKey && !mobile.applicationSourceEnvKey) {
    throw new Error("A fixture source environment key is required for fixture orchestration.");
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
  if (fixtures.negativeVerification) {
    const verification = fixtures.negativeVerification;
    if (!verification.command || !Array.isArray(verification.args) || verification.args.length === 0) {
      throw new Error("Negative-path backend verification must declare a command and argument array.");
    }
    if (!Array.isArray(verification.cases) || verification.cases.length === 0) {
      throw new Error("Negative-path backend verification must declare supported cases.");
    }
    if (unique(verification.cases).length !== verification.cases.length) {
      throw new Error("Negative-path backend verification case names must be unique.");
    }
  }
  if (fixtures.workoutVerification) {
    const verification = fixtures.workoutVerification;
    if (!verification.command || !Array.isArray(verification.args) || verification.args.length === 0) {
      throw new Error("Workout backend verification must declare a command and argument array.");
    }
    if (!Array.isArray(verification.cases) || verification.cases.length === 0) {
      throw new Error("Workout backend verification must declare supported cases.");
    }
    if (unique(verification.cases).length !== verification.cases.length) {
      throw new Error("Workout backend verification case names must be unique.");
    }
  }
  if (fixtures.coachingVerification) {
    const verification = fixtures.coachingVerification;
    if (!verification.command || !Array.isArray(verification.args) || verification.args.length === 0) {
      throw new Error("Coaching backend verification must declare a command and argument array.");
    }
    if (!Array.isArray(verification.cases) || verification.cases.length === 0) {
      throw new Error("Coaching backend verification must declare supported cases.");
    }
    if (unique(verification.cases).length !== verification.cases.length) {
      throw new Error("Coaching backend verification case names must be unique.");
    }
  }
  return fixtures;
}

function backendVerificationName(flow) {
  return flow.backendCoachingVerification || flow.backendWorkoutVerification || flow.backendNegativeVerification || flow.backendVerification || null;
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

function buildDeviceLaunchFlow(flow, selectedDevice, destinationPath) {
  if (!selectedDevice?.launchUri) {
    return { path: flow.path, launchPlan: null };
  }
  if (!['android', 'ios'].includes(selectedDevice.platform)) {
    throw new Error(`Device launchUri is unsupported for platform ${selectedDevice.platform}.`);
  }
  if (selectedDevice.platform === 'ios' && selectedDevice.kind !== 'simulator') {
    throw new Error('iOS launchUri execution requires an explicitly selected simulator.');
  }

  const source = fs.readFileSync(flow.path, "utf8");
  const documents = YAML.parseAllDocuments(source);
  const header = documents[0].toJS();
  const commands = documents[1].toJS();
  const launches = [];
  const runtimeCommands = [];
  const systemOverlaySweepers = selectedDevice.platform === 'ios' && Array.isArray(selectedDevice.systemOverlaySweepers)
    ? selectedDevice.systemOverlaySweepers
    : [];
  const deterministicTextFields = selectedDevice.platform === 'ios' && Array.isArray(selectedDevice.deterministicTextEntry)
    ? selectedDevice.deterministicTextEntry
    : [];
  const deterministicTextReset = selectedDevice.platform === 'ios'
    ? selectedDevice.deterministicTextReset
    : null;
  let deterministicTextResetApplied = false;
  const buildOverlaySweeper = (rule) => ({
    repeat: {
      times: rule.attempts,
      commands: [{
        runFlow: {
          when: { visible: rule.visible },
          commands: [{
            tapOn: {
              text: rule.tap,
              ...(rule.below ? { below: { text: rule.below } } : {}),
            },
          }],
        },
      }, {
        waitForAnimationToEnd: { timeout: rule.pollSettleTimeoutMs },
      }],
    },
  });
  const appendOverlaySweepers = (predicate) => {
    for (const rule of systemOverlaySweepers.filter(predicate)) {
      runtimeCommands.push(buildOverlaySweeper(rule));
    }
  };

  for (let commandIndex = 0; commandIndex < commands.length; commandIndex += 1) {
    const command = commands[commandIndex];
    if (!command || typeof command !== "object" || !("launchApp" in command)) {
      appendOverlaySweepers((rule) => rule.checkpoints.beforeAssertIds?.includes(command?.assertVisible?.id));
      const field = deterministicTextFields.find((candidate) => command?.tapOn?.id === candidate.id);
      const eraseCommand = commands[commandIndex + 1];
      const inputCommand = commands[commandIndex + 2];
      if (field && eraseCommand && typeof eraseCommand === 'object' && Object.hasOwn(eraseCommand, 'eraseText') && inputCommand && typeof inputCommand === 'object' && Object.hasOwn(inputCommand, 'inputText')) {
        const inputValue = typeof inputCommand.inputText === 'string' ? inputCommand.inputText : inputCommand.inputText?.text;
        if (deterministicTextReset && !deterministicTextResetApplied) {
          runtimeCommands.push({
            extendedWaitUntil: {
              visible: { id: deterministicTextReset.readySelector },
              timeout: deterministicTextReset.readyTimeoutMs,
            },
          });
          appendOverlaySweepers((rule) => rule.checkpoints.beforeCredentialReset === true);
          runtimeCommands.push({ tapOn: { id: deterministicTextReset.id } });
          deterministicTextResetApplied = true;
        }
        runtimeCommands.push(
          command,
          inputCommand
        );
        if (field.assertExact && typeof inputValue === 'string' && inputValue) {
          runtimeCommands.push({ assertVisible: { id: field.id, text: `^${inputValue}$` } });
        }
        commandIndex += 2;
        continue;
      }
      runtimeCommands.push(command);
      appendOverlaySweepers((rule) => rule.checkpoints.afterTapIds?.includes(command?.tapOn?.id));
      continue;
    }
    launches.push(command.launchApp);
    const dismissLabels = Array.isArray(selectedDevice.launchDismissIfVisible)
      ? selectedDevice.launchDismissIfVisible
      : selectedDevice.launchDismissIfVisible
        ? [selectedDevice.launchDismissIfVisible]
        : [];
    for (const label of selectedDevice.platform === 'ios' ? dismissLabels : []) {
      runtimeCommands.push({
        runFlow: {
          when: { visible: label },
          commands: [{ tapOn: label }],
        },
      });
    }
    appendOverlaySweepers((rule) => rule.checkpoints.afterLaunchDismissals === true);
    runtimeCommands.push({
      extendedWaitUntil: {
        visible: { id: selectedDevice.launchReadySelector },
        timeout: selectedDevice.launchReadyTimeoutMs || 30000,
      },
    });
    // Sweep once more after readiness to close an overlay that materialized
    // while the dev-client bundle was becoming interactive.
    appendOverlaySweepers((rule) => rule.checkpoints.afterLaunchReady === true);
  }

  if (launches.length === 0) {
    throw new Error(`Flow ${flow.name} must launch the app before applying device launchUri metadata.`);
  }
  if (launches.length !== 1) {
    throw new Error(`Flow ${flow.name} must contain exactly one launchApp command when device launchUri metadata is used.`);
  }

  ensureDir(path.dirname(destinationPath));
  const writeRuntimeFlow = (flowPath, flowCommands) => {
    fs.writeFileSync(
      flowPath,
      `${YAML.stringify(header).trimEnd()}\n---\n${YAML.stringify(flowCommands)}`,
      "utf8"
    );
  };
  let stages = [{ name: 'application', kind: 'application', path: destinationPath }];
  const externalOverlay = selectedDevice.platform === 'ios' ? selectedDevice.externalSystemOverlay : null;
  if (externalOverlay) {
    const boundaryIndexes = runtimeCommands
      .map((command, index) => command?.tapOn?.id === externalOverlay.afterTapId ? index : -1)
      .filter((index) => index >= 0);
    if (boundaryIndexes.length !== 1) {
      throw new Error(
        `Flow ${flow.name} must contain exactly one ${externalOverlay.afterTapId} tap for external iOS system-overlay handling.`
      );
    }
    const boundaryIndex = boundaryIndexes[0];
    const overlayPath = path.join(path.dirname(destinationPath), 'runtime-system-overlay.yaml');
    const resumePath = path.join(path.dirname(destinationPath), 'runtime-resume.yaml');
    const overlayCommands = [{
      repeat: {
        times: externalOverlay.attempts,
        commands: [{
          runFlow: {
            when: { visible: externalOverlay.visible },
            commands: [{
              tapOn: {
                text: externalOverlay.tap,
                ...(externalOverlay.below ? { below: { text: externalOverlay.below } } : {}),
              },
            }],
          },
        }, {
          waitForAnimationToEnd: { timeout: externalOverlay.pollSettleTimeoutMs },
        }],
      },
    }];
    writeRuntimeFlow(destinationPath, runtimeCommands.slice(0, boundaryIndex + 1));
    writeRuntimeFlow(overlayPath, overlayCommands);
    writeRuntimeFlow(resumePath, runtimeCommands.slice(boundaryIndex + 1));
    stages = [
      { name: 'application-login', kind: 'application', path: destinationPath },
      { name: 'system-overlay', kind: 'system-overlay', path: overlayPath },
      { name: 'application-resume', kind: 'application', path: resumePath },
    ];
  } else {
    writeRuntimeFlow(destinationPath, runtimeCommands);
  }
  const clearState = Boolean(launches[0]?.clearState);
  let clearCommand = null;
  let clearArgs = [];
  let launchCommand;
  let launchArgs;

  if (selectedDevice.platform === 'android') {
    clearCommand = 'adb';
    clearArgs = ["-s", selectedDevice.id, "shell", "pm", "clear", selectedDevice.appId];
    launchCommand = 'adb';
    launchArgs = [
      "-s", selectedDevice.id, "shell", "am", "start", "-W",
      "-a", "android.intent.action.VIEW",
      "-d", selectedDevice.launchUri,
      "-p", selectedDevice.appId,
    ];
  } else {
    const clearFlowPath = path.join(path.dirname(destinationPath), 'clear-state.yaml');
    if (clearState) {
      fs.writeFileSync(
        clearFlowPath,
        `${YAML.stringify(header).trimEnd()}\n---\n${YAML.stringify([{ launchApp: launches[0] }])}`,
        'utf8'
      );
      clearCommand = 'maestro';
      clearArgs = [
        '--device', selectedDevice.id,
        'test',
        '--no-ansi',
        toPosixPath(path.relative(fromRoot(), clearFlowPath)),
      ];
    }
    launchCommand = 'xcrun';
    launchArgs = ['simctl', 'openurl', selectedDevice.id, selectedDevice.launchUri];
  }

  return {
    path: destinationPath,
    stages,
    launchPlan: {
      platform: selectedDevice.platform,
      clearState,
      clearCommand,
      clearArgs,
      launchCommand,
      launchArgs,
    },
  };
}

function buildMaestroTestArgs({ selectedDevice, artifactPath, junitPath, environmentValues, flowPath }) {
  const environmentArgs = Object.entries(environmentValues).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  return [
    ...(selectedDevice ? ["--device", selectedDevice.id] : []),
    "test",
    "--no-ansi",
    `--test-output-dir=${artifactPath}`,
    `--debug-output=${artifactPath}`,
    "--format",
    "junit",
    "--output",
    junitPath,
    ...environmentArgs,
    flowPath,
  ];
}

function resolveMaestroProcessTimeoutMs(flow, maestro, selectedDevice = null) {
  const flowTimeoutMs = Number(flow.timeoutMs || maestro.timeoutMs);
  // Keep the flow timeout as the logical baseline while allowing slower device
  // automation runtimes to opt into more execution time; CLI startup stays separate.
  const runtimeMultiplier = Number(selectedDevice?.runtimeTimeoutMultiplier || 1);
  return Math.ceil(flowTimeoutMs * runtimeMultiplier) + Number(maestro.processStartupGraceMs || 0);
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
  if (mobile.devices) validateDeviceDescriptors(mobile);

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
  if (maestro.processStartupGraceMs != null && (!Number.isInteger(maestro.processStartupGraceMs) || maestro.processStartupGraceMs < 0)) {
    throw new Error("mobile.maestro.processStartupGraceMs must be a non-negative integer.");
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
    const verificationDeclarations = [flow.backendVerification, flow.backendNegativeVerification, flow.backendWorkoutVerification, flow.backendCoachingVerification].filter(Boolean);
    if (verificationDeclarations.length > 1) {
      throw new Error(`Flow ${flow.name} cannot declare more than one backend verification type.`);
    }
    if (flow.backendWorkoutVerification && !fixtures.workoutVerification?.cases?.includes(flow.backendWorkoutVerification)) {
      throw new Error(`Flow ${flow.name} references unsupported workout backend verification ${flow.backendWorkoutVerification}.`);
    }
    if (flow.backendCoachingVerification && !fixtures.coachingVerification?.cases?.includes(flow.backendCoachingVerification)) {
      throw new Error(`Flow ${flow.name} references unsupported coaching backend verification ${flow.backendCoachingVerification}.`);
    }
    if (flow.backendNegativeVerification) {
      if (!flow.negativePath) {
        throw new Error(`Flow ${flow.name} must declare negativePath for negative-path backend verification.`);
      }
      if (!flow.fixtureScenario) {
        throw new Error(`Flow ${flow.name} must declare a fixture scenario before backend verification.`);
      }
      if (!fixtures.negativeVerification?.cases?.includes(flow.backendNegativeVerification)) {
        throw new Error(`Flow ${flow.name} references unsupported negative-path backend verification ${flow.backendNegativeVerification}.`);
      }
    }
    if (backendVerificationName(flow)) {
      if (!flow.fixtureScenario) {
        throw new Error(`Flow ${flow.name} must declare a fixture scenario before backend verification.`);
      }
      if (flow.backendVerification && !fixtures.verification?.mutations?.includes(flow.backendVerification)) {
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

function buildFixtureResetPlan(validated, flow, environment = process.env, generation = null) {
  if (!flow.fixtureScenario) return null;
  const { mobile } = validated;
  const fixtures = mobile.fixtures;
  const sourceKey = fixtures.sourceEnvKey || mobile.applicationSourceEnvKey;
  const configuredSource = String(environment[sourceKey] || "").trim();
  if (!configuredSource) {
    throw new Error(`Missing ${sourceKey}; set it to the product-owned fixture repository before running ${flow.name}.`);
  }

  let sourceDirectory;
  try {
    sourceDirectory = fs.realpathSync(configuredSource);
  } catch {
    throw new Error(`${sourceKey} does not resolve to a readable directory: ${configuredSource}`);
  }
  const packageRelativePath = fixtures.packageJsonRelative || "functions/package.json";
  const fixturePackage = path.join(sourceDirectory, packageRelativePath);
  if (!fileExists(fixturePackage)) {
    throw new Error(`${sourceKey} is missing ${packageRelativePath} at ${sourceDirectory}.`);
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
    FIREBASE_PROJECT_ID: mobile.environment.firebaseProjectId,
    ...(fixtures.environment || {}),
    ...(generation && fixtures.passGeneration ? { MERXUS_MAESTRO_GENERATION: generation } : {}),
  };

  return {
    command: fixtures.command,
    args: [
      ...fixtures.args,
      "--scenario",
      flow.fixtureScenario,
      "--apply",
      "--confirm-reset",
      ...(generation && fixtures.passGeneration ? ["--generation", generation] : []),
    ],
    cwd: sourceDirectory,
    env: fixtureEnvironment,
    secretValues: Object.values(credentialValues).sort((left, right) => right.length - left.length),
  };
}

function buildBackendVerificationPlan(validated, flow, environment = process.env, generation = null) {
  const verificationName = backendVerificationName(flow);
  if (!verificationName) return null;
  const fixturePlan = buildFixtureResetPlan(validated, flow, environment, generation);
  const negativePath = Boolean(flow.backendNegativeVerification);
  const workoutPath = Boolean(flow.backendWorkoutVerification);
  const coachingPath = Boolean(flow.backendCoachingVerification);
  const verification = coachingPath
    ? validated.mobile.fixtures.coachingVerification
    : workoutPath
    ? validated.mobile.fixtures.workoutVerification
    : negativePath
      ? validated.mobile.fixtures.negativeVerification
      : validated.mobile.fixtures.verification;
  return {
    ...fixturePlan,
    command: verification.command,
    args: [
      ...verification.args,
      verification.argumentName || (negativePath || workoutPath || coachingPath ? "--case" : "--mutation"),
      verificationName,
      ...(verification.includeScenario ? ["--scenario", flow.fixtureScenario] : []),
      ...(generation && validated.mobile.fixtures.passGeneration ? ["--generation", generation] : []),
    ],
    verificationName,
    verificationKind: coachingPath
      ? (flow.coachingNonMutation ? "coaching-non-mutation" : "coaching")
      : workoutPath ? "workout" : negativePath ? "non-mutation" : "mutation",
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
    const spawnOptions = {
      cwd: options.cwd,
      env: options.env,
      stdio: ["inherit", "pipe", "pipe"],
    };
    const child = command === "maestro"
      ? spawnMaestro(args, spawnOptions)
      : spawnCommand(command, args, spawnOptions);
    const stdout = createOutputSink(process.stdout, options.logStream, options.secretValues);
    const stderr = createOutputSink(process.stderr, options.logStream, options.secretValues);
    const timeoutMs = Number(options.timeoutMs || 10 * 60 * 1000);
    let timedOut = false;
    let capturedOutput = '';
    const terminate = (signal) => command === "maestro"
      ? terminateMaestro(child, signal)
      : terminateProcessTree(child, signal);
    const timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      if (process.platform !== "win32") {
        setTimeout(() => terminate('SIGKILL'), 5000).unref();
      }
    }, timeoutMs);
    const cancel = () => terminate('SIGTERM');
    process.once('SIGINT', cancel);
    child.stdout.on("data", (chunk) => {
      stdout.write(chunk);
      if (options.captureOutput) capturedOutput = (capturedOutput + chunk.toString()).slice(-1024 * 1024);
    });
    child.stderr.on("data", (chunk) => stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      process.removeListener('SIGINT', cancel);
      stdout.flush();
      stderr.flush();
      resolve({ code, signal, timedOut, ...(options.captureOutput ? { stdout: redact(capturedOutput, options.secretValues) } : {}) });
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
  const selectedDevice = validated.mobile.devices
    ? resolveConfiguredDevice(validated.mobile, options.device)
    : null;
  if ((selectedDevice?.platform === 'ios' || !selectedDevice) && process.platform !== "darwin") {
    throw new Error(`${config.key} iOS Maestro execution is restricted to macOS. Use --validate on other platforms.`);
  }

  const runnerEnv = {
    ...process.env,
    MAESTRO_CLI_NO_ANALYTICS: "true",
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true",
    MAESTRO_DISABLE_UPDATE_CHECK: "true",
  };
  const version = spawnMaestroSync(["--version"], { cwd: fromRoot(), env: runnerEnv, encoding: "utf8" });
  if (version.error || version.status !== 0) {
    throw new Error("Maestro is not installed or is not available on PATH.");
  }

  const runDirectory = options.runDirectory
    ? ensureDir(path.resolve(options.runDirectory))
    : fromRoot(validated.maestro.reportDirectory, timestampSlug(), selectedDevice?.platform || "unspecified");
  ensureDir(runDirectory);
  if (selectedDevice) {
    writeJson(path.join(runDirectory, 'device.json'), {
      descriptor: selectedDevice.descriptorName,
      id: selectedDevice.id,
      name: selectedDevice.name,
      platform: selectedDevice.platform,
      kind: selectedDevice.kind,
      appId: selectedDevice.appId,
      osVersion: selectedDevice.osVersion,
      appVersion: selectedDevice.appVersion,
      appBuild: selectedDevice.appBuild,
      launchUri: selectedDevice.launchUri,
      launchReadySelector: selectedDevice.launchReadySelector,
      launchDismissIfVisible: selectedDevice.launchDismissIfVisible,
      systemOverlaySweepers: selectedDevice.systemOverlaySweepers,
      deterministicTextReset: selectedDevice.deterministicTextReset,
      deterministicTextEntry: selectedDevice.deterministicTextEntry,
      runtimeTimeoutMultiplier: selectedDevice.runtimeTimeoutMultiplier,
      externalSystemOverlay: selectedDevice.externalSystemOverlay,
    });
  }
  console.log(`Maestro ${String(version.stdout || version.stderr).trim()}`);
  console.log(`Artifacts: ${toPosixPath(path.relative(fromRoot(), runDirectory))}`);

  const results = [];
  for (const flow of selected) {
    const generation = `${config.key}-maestro-${Date.now()}-${flow.name}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const backendName = backendVerificationName(flow);
    const uiFailureLabel = flow.backendCoachingVerification
      ? "UI COACHING FLOW FAILED"
      : flow.backendWorkoutVerification
      ? "UI WORKOUT FLOW FAILED"
      : flow.negativePath
        ? "UI NEGATIVE-PATH FAIL"
        : "UI FAILED";
    const environmentValues = requireFlowEnvironment(flow);
    const flowDirectory = ensureDir(path.join(runDirectory, flow.name));
    const artifactDirectory = ensureDir(path.join(flowDirectory, "artifacts"));
    const junitPath = path.join(flowDirectory, "junit.xml");
    const logPath = path.join(flowDirectory, "runner.log");
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    let fixturePlan;
    let backendPlan;
    try {
      fixturePlan = buildFixtureResetPlan(validated, flow, process.env, generation);
      backendPlan = buildBackendVerificationPlan(validated, flow, process.env, generation);
    } catch (error) {
      const result = {
        flow: flow.name,
        status: "failed",
        failureStage: "fixture-setup",
        stages: {
          fixture: { status: "failed", scenario: flow.fixtureScenario || null },
          ui: { status: "not-run" },
          backend: { status: "not-run", verification: backendName },
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
    const runtimeFlow = buildDeviceLaunchFlow(
      flow,
      selectedDevice,
      path.join(flowDirectory, "runtime-flow.yaml")
    );
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
          timeoutMs: validated.maestro.timeoutMs,
        });
        if (fixtureOutcome.code !== 0) {
          throw new Error(`Product fixture reset exited with ${fixtureOutcome.code ?? "unknown"}.`);
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
            backend: { status: "not-run", verification: backendName },
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
    let uiOutput = '';
    try {
      if (runtimeFlow.launchPlan) {
        if (runtimeFlow.launchPlan.clearState) {
          const clearOutcome = await runProcess(runtimeFlow.launchPlan.clearCommand, runtimeFlow.launchPlan.clearArgs, {
            cwd: fromRoot(),
            env: runnerEnv,
            logStream,
            secretValues,
            timeoutMs: flow.timeoutMs || validated.maestro.timeoutMs,
          });
          if (clearOutcome.code !== 0) throw new Error(`${runtimeFlow.launchPlan.platform} QA state clear exited with ${clearOutcome.code ?? "unknown"}.`);
        }
        const launchOutcome = await runProcess(runtimeFlow.launchPlan.launchCommand, runtimeFlow.launchPlan.launchArgs, {
          cwd: fromRoot(),
          env: runnerEnv,
          logStream,
          secretValues,
          timeoutMs: flow.timeoutMs || validated.maestro.timeoutMs,
        });
        if (launchOutcome.code !== 0) throw new Error(`${runtimeFlow.launchPlan.platform} QA launch URI exited with ${launchOutcome.code ?? "unknown"}.`);
      }
      const runtimeStages = runtimeFlow.stages || [{ name: 'application', kind: 'application', path: runtimeFlow.path }];
      for (let stageIndex = 0; stageIndex < runtimeStages.length; stageIndex += 1) {
        const stage = runtimeStages[stageIndex];
        const stageJunitPath = stageIndex === runtimeStages.length - 1
          ? relativeJunit
          : toPosixPath(path.relative(fromRoot(), path.join(flowDirectory, `junit-${stage.name}.xml`)));
        const stageArgs = buildMaestroTestArgs({
          selectedDevice,
          artifactPath: relativeArtifacts,
          junitPath: stageJunitPath,
          environmentValues,
          flowPath: toPosixPath(path.relative(fromRoot(), stage.path)),
        });
        console.log(`[Maestro] Stage ${stageIndex + 1}/${runtimeStages.length}: ${stage.name}`);
        outcome = await runProcess("maestro", stageArgs, {
          cwd: fromRoot(),
          env: runnerEnv,
          logStream,
          secretValues,
          timeoutMs: resolveMaestroProcessTimeoutMs(flow, validated.maestro, selectedDevice),
          captureOutput: Boolean(flow.authoritativeResult),
        });
        uiOutput += outcome.stdout || '';
        if (outcome.code !== 0) break;
      }
    } catch (error) {
      const result = {
        flow: flow.name,
        status: "failed",
        failureStage: "ui",
        stages: {
          fixture: { status: fixtureStatus, scenario: flow.fixtureScenario || null },
          ui: { status: "failed" },
          backend: { status: "not-run", verification: backendName },
        },
        report: toPosixPath(path.relative(fromRoot(), junitPath)),
        artifacts: relativeArtifacts,
      };
      results.push(result);
      writeJson(path.join(flowDirectory, "result.json"), result);
      writeJson(path.join(runDirectory, "summary.json"), { status: "failed", results });
      logStream.end();
      throw new Error(`${uiFailureLabel}: ${flow.name}\n${error.message}. See ${relativeArtifacts}.`);
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
          backend: { status: "not-run", verification: backendName },
        },
        report: toPosixPath(path.relative(fromRoot(), junitPath)),
        artifacts: relativeArtifacts,
      };
      results.push(result);
      writeJson(path.join(flowDirectory, "result.json"), result);
      writeJson(path.join(runDirectory, "summary.json"), { status: "failed", results });
      logStream.end();
      throw new Error(`${uiFailureLabel}: ${flow.name} (exit ${outcome.code ?? "unknown"}). See ${relativeArtifacts}.`);
    }

    let backendStatus = backendPlan ? "pending" : "skipped";
    let authoritativeResult;
    if (backendPlan) {
      console.log(`[Backend] Verifying ${backendPlan.verificationKind} ${backendPlan.verificationName}`);
      let backendOutcome;
      try {
        backendOutcome = await runProcess(backendPlan.command, backendPlan.args, {
          cwd: backendPlan.cwd,
          env: backendPlan.env,
          logStream,
          secretValues,
          timeoutMs: validated.maestro.timeoutMs,
          captureOutput: Boolean(flow.authoritativeResult),
        });
        if (backendOutcome.code === 0 && flow.authoritativeResult) {
          authoritativeResult = parseAuthoritativeResult(backendOutcome.stdout, flow.authoritativeResult, uiOutput, generation);
        }
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
            backend: { status: "failed", verification: backendName, kind: backendPlan.verificationKind, exitCode: backendOutcome.code },
          },
          report: toPosixPath(path.relative(fromRoot(), junitPath)),
          artifacts: relativeArtifacts,
        };
        results.push(result);
        writeJson(path.join(flowDirectory, "result.json"), result);
        writeJson(path.join(runDirectory, "summary.json"), { status: "failed", results });
        logStream.end();
        const detail = backendOutcome.error ? ` ${backendOutcome.error.message}` : "";
        const backendFailureLabel = ["non-mutation", "coaching-non-mutation"].includes(backendPlan.verificationKind)
          ? "UI PASS / BACKEND NON-MUTATION FAIL"
          : backendPlan.verificationKind === "coaching"
            ? "UI PASS / BACKEND ADAPTATION FAIL"
            : "UI PASS / BACKEND FAIL";
        throw new Error(`${backendFailureLabel}: ${flow.name} (exit ${backendOutcome.code ?? "unknown"}).${detail} See ${relativeArtifacts}.`);
      }
      backendStatus = "passed";
      console.log(`[Backend] Passed ${backendPlan.verificationName}`);
    }

    const result = {
      flow: flow.name,
      generation,
      ...(authoritativeResult ? { authoritativeResult } : {}),
      status: "passed",
      exitCode: outcome.code,
      signal: outcome.signal || null,
      device: selectedDevice ? { descriptor: selectedDevice.descriptorName, id: selectedDevice.id, platform: selectedDevice.platform, kind: selectedDevice.kind, appId: selectedDevice.appId, osVersion: selectedDevice.osVersion, appVersion: selectedDevice.appVersion, appBuild: selectedDevice.appBuild } : null,
      stages: {
        fixture: { status: fixtureStatus, scenario: flow.fixtureScenario || null },
        ui: { status: "passed", exitCode: outcome.code },
        backend: { status: backendStatus, verification: backendName, kind: backendPlan?.verificationKind || null },
      },
      report: toPosixPath(path.relative(fromRoot(), junitPath)),
      artifacts: relativeArtifacts,
    };
    results.push(result);
    writeJson(path.join(flowDirectory, "result.json"), result);
    logStream.end();
    const backendSuccessLabel = backendPlan?.verificationKind === "coaching-non-mutation"
      ? "UI PASS / BACKEND NON-MUTATION PASS"
      : "UI PASS / BACKEND PASS";
    console.log(backendPlan ? `[Maestro] ${backendSuccessLabel}: ${flow.name}` : `[Maestro] Passed ${flow.name}`);
  }

  writeJson(path.join(runDirectory, "summary.json"), { status: "passed", results });
  return { runDirectory, results };
}

module.exports = {
  buildBackendVerificationPlan,
  buildDeviceLaunchFlow,
  buildMaestroTestArgs,
  buildFixtureResetPlan,
  collectEnvironmentReferences,
  normalizeFlowName,
  resolveMaestroProcessTimeoutMs,
  runProcess,
  runMaestroFlows,
  selectFlows,
  validateFixtureConfiguration,
  validateMaestroConfiguration,
};
