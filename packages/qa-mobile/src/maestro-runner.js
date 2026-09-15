const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { parseAuthoritativeResult } = require('./authoritative-result');
const { collectCorrelationSources, emptyCorrelationDiagnostics } = require('./ui-correlation');
const { acquireObserverLock, ensureDir, fileExists, fromRoot, spawnCommand, terminateProcessTree, toPosixPath, writeJson } = require("../../qa-utils/src");
const { resolveConfiguredDevice, validateDeviceDescriptors } = require('./device-selection');
const { spawnMaestro, spawnMaestroSync, terminateMaestro } = require("./maestro-process");
const { runBackendIdentityPreflight, validateBackendIdentityContract } = require('./backend-identity-preflight');
const { dismissAndroidIme } = require('./android-ime');
const { resolveTool } = require('../../qa-core/src/tool-resolver');

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

function configuredRoleCredentialKeys(mobile) {
  return unique(Object.values(mobile?.fixtures?.roleCredentialEnvKeys || {}).filter(Boolean));
}

function configuredMaestroCredentialKeys(mobile) {
  return unique([...configuredCredentialKeys(mobile), ...configuredRoleCredentialKeys(mobile)]);
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
  const allowedCredentialKeys = configuredMaestroCredentialKeys(mobile);
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
  // A flow may opt into the same bounded post-dismiss re-anchor architecture
  // for a field whose viewport is known to move on iOS. Keep the device
  // defaults intact so already-certified flows remain byte-for-byte stable.
  const keyboardDismissRules = selectedDevice.platform === 'ios' && selectedDevice.kind === 'simulator'
    ? (flow.iosKeyboardDismissAfterEdit || selectedDevice.keyboardDismissAfterEdit || []) : [];
  const iosTextInputFocusRules = selectedDevice.platform === 'ios' && selectedDevice.kind === 'simulator'
    ? (flow.iosTextInputFocus || []) : [];
  const iosReloadAnchor = selectedDevice.platform === 'ios'
    ? flow.iosReloadAnchor || null : null;
  const iosReloadActivation = selectedDevice.platform === 'ios'
    ? flow.iosReloadActivation || null : null;
  const iosPostReloadReanchor = selectedDevice.platform === 'ios'
    ? flow.iosPostReloadReanchor || null : null;
  const iosNonCenteredScrollTargets = selectedDevice.platform === 'ios'
    ? new Set(flow.iosNonCenteredScrollTargets || []) : new Set();
  const iosReloadCompletionOracle = selectedDevice.platform === 'ios'
    ? flow.iosReloadCompletionOracle || null : null;
  const iosPostReloadValueOracle = selectedDevice.platform === 'ios'
    ? flow.iosPostReloadValueOracle || null : null;
  let reloadCompletionObserved = false;
  const androidImeDismissRules = selectedDevice.platform === 'android'
    ? flow.androidImeDismissAfterEdit || [] : [];
  const androidImeDismissBoundaries = [];
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
    const isProductReloadCompletion = command?.extendedWaitUntil?.visible?.id === (iosReloadCompletionOracle?.productMarkerId || 'settings.sms.reloaded');
    if (iosPostReloadReanchor && isProductReloadCompletion) {
      reloadCompletionObserved = true;
    }
    if (iosReloadCompletionOracle && isProductReloadCompletion) continue;
    const isReloadStateCompletion = iosPostReloadValueOracle &&
      command?.extendedWaitUntil?.visible?.id === iosPostReloadValueOracle.completionStateId &&
      command.extendedWaitUntil.visible.text === `^${iosPostReloadValueOracle.completionState}$`;
    if (isReloadStateCompletion) reloadCompletionObserved = true;
    if (iosPostReloadValueOracle && reloadCompletionObserved) {
      if (command?.scrollUntilVisible?.element?.id === iosPostReloadValueOracle.sourceId) continue;
      if (command?.assertVisible?.id === iosPostReloadValueOracle.sourceId) {
        runtimeCommands.push({
          assertVisible: {
            ...command.assertVisible,
            id: iosPostReloadValueOracle.oracleId,
          },
        });
        continue;
      }
    }
    // On configured iOS simulator fields dismiss BEFORE the value assertion:
    // the keyboard can hide an otherwise correctly edited input. Consume only
    // the exact input -> assertion -> hideKeyboard pair; other flows stay intact.
    const nextCommand = commands[commandIndex + 1];
    const dismissRule = command?.assertVisible &&
      (nextCommand === 'hideKeyboard' || (nextCommand && Object.hasOwn(nextCommand, 'hideKeyboard')))
      ? keyboardDismissRules.find((rule) => command.assertVisible.id === rule.fieldId &&
          Object.hasOwn(commands[commandIndex - 1] || {}, 'inputText')) : null;
    const androidDismissRule = command?.assertVisible &&
      (nextCommand === 'hideKeyboard' || (nextCommand && Object.hasOwn(nextCommand, 'hideKeyboard')))
      ? androidImeDismissRules.find((rule) => command.assertVisible.id === rule.fieldId &&
          Object.hasOwn(commands[commandIndex - 1] || {}, 'inputText')) : null;
    if (dismissRule || androidDismissRule) {
      if (androidDismissRule) {
        // Android Maestro hideKeyboard is implemented as a Back event, while
        // tapping a non-input marker can leave the native IME window active.
        // End this application stage after the exact-value assertion so the
        // runner can dismiss and verify the IME without a second UI observer.
        runtimeCommands.push(command);
        androidImeDismissBoundaries.push({
          commandCount: runtimeCommands.length,
          rule: androidDismissRule,
        });
        commandIndex += 1;
        continue;
      }
      if (dismissRule.scrollToTarget) runtimeCommands.push({ scrollUntilVisible: { element: { id: dismissRule.targetId }, direction: 'UP', timeout: 5000 } });
      runtimeCommands.push({ extendedWaitUntil: { visible: { id: dismissRule.targetId }, timeout: 5000 } });
      runtimeCommands.push({ tapOn: { id: dismissRule.targetId } });
      if (dismissRule.reanchorAfterDismiss?.targetId) {
        // iOS can reposition the outer form substantially when the fixed
        // keyboard-dismiss control is tapped. Re-expose the edited field
        // before asserting its value; this is semantic and bounded.
        const reanchorScroll = {
          element: { id: dismissRule.reanchorAfterDismiss.targetId },
          direction: dismissRule.reanchorAfterDismiss.direction || 'UP',
          ...(dismissRule.reanchorAfterDismiss.timeoutMs ? { timeout: dismissRule.reanchorAfterDismiss.timeoutMs } : {}),
          ...(dismissRule.reanchorAfterDismiss.centerElement === false ? {} : { centerElement: true }),
        };
        runtimeCommands.push({
          scrollUntilVisible: reanchorScroll,
        });
      }
      runtimeCommands.push(command);
      commandIndex += 1;
      continue;
    }
    if (!command || typeof command !== "object" || !("launchApp" in command)) {
      appendOverlaySweepers((rule) => rule.checkpoints.beforeAssertIds?.includes(command?.assertVisible?.id));
      const focusRule = iosTextInputFocusRules.find((rule) => command?.tapOn?.id === rule.fieldId);
      const focusEraseCommand = commands[commandIndex + 1];
      const focusInputCommand = commands[commandIndex + 2];
      if (focusRule && focusEraseCommand && typeof focusEraseCommand === 'object' && Object.hasOwn(focusEraseCommand, 'eraseText') && focusInputCommand && typeof focusInputCommand === 'object' && Object.hasOwn(focusInputCommand, 'inputText')) {
        runtimeCommands.push(
          { assertVisible: { id: focusRule.markerId, text: '^blurred$' } },
          { tapOn: { id: focusRule.helperId } },
          { extendedWaitUntil: {
            visible: { id: focusRule.markerId, text: '^focused$' },
            timeout: focusRule.focusTimeoutMs || 5000,
          } },
          { pressKey: 'backspace' },
          focusInputCommand,
        );
        commandIndex += 2;
        continue;
      }
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
      const isReloadTraversal = command?.scrollUntilVisible?.element?.id === 'settings.sms.reload';
      if (isReloadTraversal && iosReloadAnchor?.targetId) {
        // On iOS the long SMS form can skip the short Reload node while
        // traversing. Save is the adjacent, proven action-row anchor; locating
        // it never presses or mutates the control.
        runtimeCommands.push({
          scrollUntilVisible: {
            ...command.scrollUntilVisible,
            element: { id: iosReloadAnchor.targetId },
            direction: iosReloadAnchor.direction || command.scrollUntilVisible.direction,
            ...(iosReloadAnchor.timeoutMs ? { timeout: iosReloadAnchor.timeoutMs } : {}),
            ...(iosReloadAnchor.centerElement === false ? { centerElement: false } : { centerElement: true }),
          },
        });
        if (iosReloadAnchor.followUp?.targetId) {
          // The Save action-row anchor can leave the short Reload control just
          // below the iOS accessibility viewport. One bounded semantic
          // traversal exposes the real control without pressing Save.
          runtimeCommands.push({
            scrollUntilVisible: {
              ...command.scrollUntilVisible,
              element: { id: iosReloadAnchor.followUp.targetId },
              direction: iosReloadAnchor.followUp.direction || 'DOWN',
              ...(iosReloadAnchor.followUp.timeoutMs ? { timeout: iosReloadAnchor.followUp.timeoutMs } : {}),
              ...(iosReloadAnchor.followUp.centerElement === false ? { centerElement: false } : { centerElement: true }),
            },
          });
        }
        appendOverlaySweepers((rule) => rule.checkpoints.afterTapIds?.includes(command?.tapOn?.id));
        continue;
      }
      const isReloadActivation = command?.tapOn?.id === 'settings.sms.reload';
      if (isReloadActivation && iosReloadActivation?.helperId) {
        // Some iOS simulator configurations expose the real Reload node but
        // do not reliably deliver its semantic tap to React Native. A flow
        // must explicitly opt in to this accommodation; Android and all
        // other flows retain the real control tap unchanged.
        runtimeCommands.push({ tapOn: { id: iosReloadActivation.helperId } });
        if (iosReloadActivation.stateId) {
          runtimeCommands.push({
            extendedWaitUntil: {
              visible: {
                id: iosReloadActivation.stateId,
                ...(iosReloadActivation.state ? { text: `^${iosReloadActivation.state}$` } : {}),
              },
              timeout: iosReloadActivation.timeoutMs || 10000,
            },
          });
        }
        continue;
      }
      const isPostReloadReanchor = iosPostReloadReanchor && reloadCompletionObserved &&
        command?.scrollUntilVisible?.element?.id === iosPostReloadReanchor?.targetId;
      if (isPostReloadReanchor) {
        const postReloadScroll = { ...command.scrollUntilVisible };
        delete postReloadScroll.centerElement;
        runtimeCommands.push({
          scrollUntilVisible: {
            ...postReloadScroll,
            ...(iosPostReloadReanchor.direction ? { direction: iosPostReloadReanchor.direction } : {}),
            ...(iosPostReloadReanchor.timeoutMs ? { timeout: iosPostReloadReanchor.timeoutMs } : {}),
            ...(iosPostReloadReanchor.centerElement === true ? { centerElement: true } : {}),
          },
        });
        continue;
      }
      const scrollTargetId = command?.scrollUntilVisible?.element?.id;
      if (scrollTargetId && iosNonCenteredScrollTargets.has(scrollTargetId)) {
        const nonCenteredScroll = { ...command.scrollUntilVisible };
        delete nonCenteredScroll.centerElement;
        runtimeCommands.push({ scrollUntilVisible: nonCenteredScroll });
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
  } else if (androidImeDismissBoundaries.length > 0) {
    stages = [];
    let commandStart = 0;
    for (let index = 0; index < androidImeDismissBoundaries.length; index += 1) {
      const boundary = androidImeDismissBoundaries[index];
      const applicationPath = index === 0
        ? destinationPath
        : path.join(path.dirname(destinationPath), `runtime-application-${index + 1}.yaml`);
      writeRuntimeFlow(applicationPath, runtimeCommands.slice(commandStart, boundary.commandCount));
      stages.push({
        name: index === 0 ? 'application-before-ime-dismiss' : `application-before-ime-dismiss-${index + 1}`,
        kind: 'application',
        path: applicationPath,
      });
      stages.push({
        name: index === 0 ? 'android-ime-dismiss' : `android-ime-dismiss-${index + 1}`,
        kind: 'android-ime-dismiss',
        imeDismiss: {
          strategy: boundary.rule.strategy,
          timeoutMs: boundary.rule.timeoutMs,
        },
      });
      commandStart = boundary.commandCount;
    }
    if (commandStart >= runtimeCommands.length) {
      throw new Error(`Flow ${flow.name} Android IME dismissal must be followed by application commands.`);
    }
    const resumePath = path.join(path.dirname(destinationPath), 'runtime-resume.yaml');
    writeRuntimeFlow(resumePath, runtimeCommands.slice(commandStart));
    stages.push({ name: 'application-resume', kind: 'application', path: resumePath });
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
  return resolveMaestroProcessBudget(flow, maestro, selectedDevice).effectiveWatchdogMs;
}

function resolveMaestroProcessBudget(flow, maestro, selectedDevice = null) {
  // Undeclared products retain runProcess's historical ten-minute default.
  const declaredFlowTimeoutMs = Number(flow.timeoutMs ?? maestro.timeoutMs ?? 10 * 60 * 1000);
  // Keep the flow timeout as the logical baseline while allowing slower device
  // automation runtimes to opt into more execution time; CLI startup stays separate.
  const runtimeMultiplier = Number(selectedDevice?.runtimeTimeoutMultiplier ?? 1);
  const startupGraceMs = Number(maestro.processStartupGraceMs ?? 0);
  const effectiveWatchdogMs = Math.ceil(declaredFlowTimeoutMs * runtimeMultiplier) + startupGraceMs;
  if (!Number.isSafeInteger(declaredFlowTimeoutMs) || declaredFlowTimeoutMs <= 0
    || !Number.isFinite(runtimeMultiplier) || runtimeMultiplier < 1
    || !Number.isSafeInteger(startupGraceMs) || startupGraceMs < 0
    || !Number.isSafeInteger(effectiveWatchdogMs) || effectiveWatchdogMs > 2147483647) {
    throw new Error('Maestro process timeout must be finite, positive and within the Node timer limit.');
  }
  return { declaredFlowTimeoutMs, runtimeMultiplier, startupGraceMs, effectiveWatchdogMs };
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
  if (mobile.phase0?.backendIdentityVerify) {
    if (!fixtures || !Array.isArray(mobile.phase0.backendIdentityVerify.owners) || mobile.phase0.backendIdentityVerify.owners.length === 0) {
      throw new Error('Backend identity preflight requires product-owned fixtures and a bounded owner list.');
    }
    if (!Array.isArray(mobile.phase0.authPreflightCommand) || mobile.phase0.authPreflightCommand.length < 2) {
      throw new Error('Backend identity preflight requires phase0.authPreflightCommand.');
    }
    validateBackendIdentityContract(mobile, mobile.phase0);
  }

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
    if (flow.androidImeDismissAfterEdit != null) {
      const rules = flow.androidImeDismissAfterEdit;
      if (!Array.isArray(rules) || rules.length === 0 || rules.some((rule) => (
        !rule || typeof rule.fieldId !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(rule.fieldId) ||
        rule.strategy !== 'android-keyevent-escape' || !Number.isInteger(rule.timeoutMs) ||
        rule.timeoutMs <= 0 || rule.timeoutMs > 30000
      )) || unique(rules.map((rule) => rule.fieldId)).length !== rules.length) {
        throw new Error(`Flow ${flow.name} androidImeDismissAfterEdit requires unique field IDs, android-keyevent-escape strategy and bounded timeoutMs.`);
      }
    }
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
      const accountCredentialPrefixes = { 'user-a': 'userA', 'user-b': 'userB', 'manager-a': 'managerA', 'staff-a': 'staffA' };
      if (!Object.hasOwn(accountCredentialPrefixes, flow.account)) {
        throw new Error(`Flow ${flow.name} must declare account user-a, user-b, manager-a, or staff-a.`);
      }
      const accountPrefix = accountCredentialPrefixes[flow.account];
      const accountCredentialKeys = [
        fixtures.credentialEnvKeys?.[`${accountPrefix}Email`] || fixtures.roleCredentialEnvKeys?.[`${accountPrefix}Email`],
        fixtures.credentialEnvKeys?.[`${accountPrefix}Password`] || fixtures.roleCredentialEnvKeys?.[`${accountPrefix}Password`],
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
  for (const key of configuredRoleCredentialKeys(mobile).filter((candidate) => flow.requiredEnv?.includes(candidate))) {
    const value = environment[key];
    if (!value) throw new Error(`Missing required role fixture environment variable: ${key}`);
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
      : workoutPath ? "workout" : negativePath ? "non-mutation" : flow.mutationExpected === false ? "non-mutation" : "mutation",
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
    const timeoutMs = Number(options.timeoutMs ?? 10 * 60 * 1000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
      throw new Error('Process timeout must be a bounded positive integer.');
    }
    const spawnOptions = {
      cwd: options.cwd,
      env: options.env,
      stdio: ["inherit", "pipe", "pipe"],
    };
    let observerLock = null;
    if (command === "maestro" && options.serializeMaestro !== false) {
      const lockPath = options.observerLockPath || fromRoot('.worksideqa', 'maestro-observer.lock');
      observerLock = acquireObserverLock(lockPath, {
        product: options.product || null,
        deviceId: options.deviceId || null,
        stage: options.stage || 'process',
        command: 'maestro',
      });
      if (!observerLock.ok) {
        const error = observerLock.error || new Error('Maestro observer is busy.');
        error.code = error.code || 'OBSERVER_BUSY';
        reject(error);
        return;
      }
    }
    let child;
    try {
      child = command === "maestro"
        ? spawnMaestro(args, spawnOptions)
        : spawnCommand(command, args, spawnOptions);
    } catch (error) {
      observerLock?.release();
      reject(error);
      return;
    }
    const stdout = createOutputSink(process.stdout, options.logStream, options.secretValues);
    const stderr = createOutputSink(process.stderr, options.logStream, options.secretValues);
    let timedOut = false;
    let cancelled = false;
    let timeout;
    let escalationTimer;
    let stopping = false;
    let capturedOutput = '';
    let capturedErrorOutput = '';
    const terminate = (signal) => command === "maestro"
      ? terminateMaestro(child, signal)
      : terminateProcessTree(child, signal);
    const stop = () => {
      if (stopping) return;
      stopping = true;
      terminate('SIGTERM');
      if (process.platform !== "win32") {
        escalationTimer = setTimeout(() => terminate('SIGKILL'), 5000);
        escalationTimer.unref();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      timeout = {
        code: 'WORKSIDEQA_PROCESS_TIMEOUT',
        declaredFlowTimeoutMs: options.watchdog?.declaredFlowTimeoutMs ?? timeoutMs,
        startupGraceMs: options.watchdog?.startupGraceMs ?? 0,
        effectiveWatchdogMs: timeoutMs,
        runtimeMultiplier: options.watchdog?.runtimeMultiplier ?? 1,
        stage: options.stage || 'process',
        ...(options.stageName ? { stageName: options.stageName } : {}),
      };
      stderr.write(`\n${JSON.stringify(timeout)}\n`);
      stderr.flush();
      stop();
    }, timeoutMs);
    const cancel = () => {
      cancelled = true;
      clearTimeout(timer);
      stop();
    };
    process.once('SIGINT', cancel);
    child.stdout.on("data", (chunk) => {
      stdout.write(chunk);
      if (options.captureOutput) capturedOutput = (capturedOutput + chunk.toString()).slice(-1024 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      stderr.write(chunk);
      if (options.captureOutput) capturedErrorOutput = (capturedErrorOutput + chunk.toString()).slice(-1024 * 1024);
    });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      process.removeListener('SIGINT', cancel);
      observerLock?.release();
      stdout.flush();
      stderr.flush();
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code, signal) => {
      cleanup();
      resolve({ code, signal, timedOut, ...(timeout ? { timeout } : {}), ...(cancelled ? { cancelled } : {}), ...(options.captureOutput ? { stdout: redact(capturedOutput, options.secretValues), stderr: redact(capturedErrorOutput, options.secretValues) } : {}) });
    });
  });
}

function processFailed(outcome) {
  return outcome.code !== 0 || outcome.timedOut || outcome.cancelled;
}

function processFailureMetadata(outcome) {
  if (outcome.timeout) return { errorCode: outcome.timeout.code, timeout: outcome.timeout };
  if (outcome.code === 'OBSERVER_BUSY' || outcome.code === 'OBSERVER_CONFLICT') return { errorCode: outcome.code };
  if (outcome.code === 'ANDROID_IME_DISMISS_FAILED') {
    return { errorCode: outcome.code, ...(outcome.diagnostics ? { imeDismissFailure: outcome.diagnostics } : {}) };
  }
  if (outcome.cancelled || outcome.errorCode === 'WORKSIDEQA_PROCESS_CANCELLED') return { errorCode: 'WORKSIDEQA_PROCESS_CANCELLED' };
  return {};
}

function imeDismissalResultFields(dismissals) {
  if (!Array.isArray(dismissals) || dismissals.length === 0) return {};
  const latest = dismissals.at(-1);
  return {
    androidImeDismissals: dismissals,
    keyboardDismissStrategy: latest.keyboardDismissStrategy,
    imeVisibleBefore: latest.imeVisibleBefore,
    imeVisibleAfter: latest.imeVisibleAfter,
    dismissElapsedMs: latest.dismissElapsedMs,
  };
}

function assertProcessSucceeded(outcome, description) {
  if (processFailed(outcome)) {
    const metadata = processFailureMetadata(outcome);
    throw Object.assign(new Error(`${metadata.errorCode || description}: exited with ${outcome.code ?? 'unknown'}.`), metadata);
  }
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
  const { mobile } = validated;
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
          stage: 'fixture',
        });
        assertProcessSucceeded(fixtureOutcome, 'Product fixture reset');
        fixtureStatus = "passed";
        console.log(`[Fixture] Applied ${flow.fixtureScenario}`);
      } catch (error) {
        const preflightDiagnostics = error.preflightDiagnostics || {};
        console.error(`[Preflight] ${JSON.stringify(preflightDiagnostics)}`);
        const result = {
          flow: flow.name,
          status: "failed",
          failureStage: "fixture",
          ...processFailureMetadata(error),
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

    let backendPreflightStatus = "skipped";
    let backendPreflight = null;
    if (mobile.phase0?.backendIdentityVerify && fixturePlan) {
      backendPreflightStatus = "pending";
      try {
        console.log('[Preflight] Verifying canonical backend identities');
        backendPreflight = await runBackendIdentityPreflight({
          validated,
          flow,
          fixturePlan,
          runProcess,
          logStream,
          secretValues,
          generation,
        });
        backendPreflightStatus = "passed";
        console.log('[Preflight] Canonical backend identities passed');
      } catch (error) {
        const result = {
          flow: flow.name,
          generation,
          status: "failed",
          failureStage: "backend-preflight",
          preflight: { status: "failed", ...(error.preflightDiagnostics || {}) },
          stages: {
            fixture: { status: fixtureStatus, scenario: flow.fixtureScenario || null },
            backendPreflight: { status: "failed" },
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
        throw new Error(`BACKEND PREFLIGHT FAILED: ${flow.name}\n${error.message}\n${JSON.stringify(preflightDiagnostics)}\nSee ${relativeArtifacts}.`);
      }
    }

    let outcome;
    let uiOutput = '';
    let uiErrorOutput = '';
    const androidImeDismissals = [];
    const applicationFlowNames = [];
    const applicationStartedAt = Date.now();
    try {
      if (runtimeFlow.launchPlan) {
        if (runtimeFlow.launchPlan.clearState) {
          const clearOutcome = await runProcess(runtimeFlow.launchPlan.clearCommand, runtimeFlow.launchPlan.clearArgs, {
            cwd: fromRoot(),
            env: runnerEnv,
            logStream,
            secretValues,
            timeoutMs: flow.timeoutMs || validated.maestro.timeoutMs,
            stage: 'clear-state',
          });
          assertProcessSucceeded(clearOutcome, `${runtimeFlow.launchPlan.platform} QA state clear`);
        }
        const launchOutcome = await runProcess(runtimeFlow.launchPlan.launchCommand, runtimeFlow.launchPlan.launchArgs, {
          cwd: fromRoot(),
          env: runnerEnv,
          logStream,
          secretValues,
          timeoutMs: flow.timeoutMs || validated.maestro.timeoutMs,
          stage: 'launch',
        });
        assertProcessSucceeded(launchOutcome, `${runtimeFlow.launchPlan.platform} QA launch URI`);
      }
      const runtimeStages = runtimeFlow.stages || [{ name: 'application', kind: 'application', path: runtimeFlow.path }];
      for (let stageIndex = 0; stageIndex < runtimeStages.length; stageIndex += 1) {
        const stage = runtimeStages[stageIndex];
        if (stage.kind === 'android-ime-dismiss') {
          const adb = resolveTool('adb', runnerEnv);
          const artifactPath = path.join(artifactDirectory, `${stage.name}.json`);
          if (!adb.path) {
            const error = new Error(`ANDROID_IME_DISMISS_FAILED: ${adb.error || 'ADB executable could not be resolved.'}`);
            error.code = 'ANDROID_IME_DISMISS_FAILED';
            error.diagnostics = {
              keyboardDismissStrategy: stage.imeDismiss.strategy,
              deviceId: selectedDevice?.id || null,
              reason: adb.error || 'ADB executable could not be resolved.',
            };
            writeJson(artifactPath, { status: 'failed', ...error.diagnostics });
            throw error;
          }
          console.log(`[Android IME] Dismissing and verifying on ${selectedDevice.id}`);
          try {
            const dismissal = await dismissAndroidIme({
              deviceId: selectedDevice.id,
              timeoutMs: stage.imeDismiss.timeoutMs,
              adbPath: adb.path,
              environment: runnerEnv,
            });
            const record = { stage: stage.name, status: 'passed', ...dismissal };
            androidImeDismissals.push(record);
            writeJson(artifactPath, record);
            logStream.write(`[Android IME] ${JSON.stringify(record)}\n`);
            console.log(`[Android IME] CLOSED (${record.dismissElapsedMs}ms)`);
          } catch (error) {
            const record = { stage: stage.name, status: 'failed', ...(error.diagnostics || {}) };
            androidImeDismissals.push(record);
            writeJson(artifactPath, record);
            logStream.write(`[Android IME] ${JSON.stringify(record)}\n`);
            throw error;
          }
          continue;
        }
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
        const watchdog = resolveMaestroProcessBudget(flow, validated.maestro, selectedDevice);
        logStream.write(`[WorksideQA watchdog] ${JSON.stringify({ ...watchdog, stage: stage.kind, stageName: stage.name })}\n`);
        outcome = await runProcess("maestro", stageArgs, {
          cwd: fromRoot(),
          env: runnerEnv,
          product: config.key,
          deviceId: selectedDevice?.id || null,
          logStream,
          secretValues,
          timeoutMs: watchdog.effectiveWatchdogMs,
          watchdog,
          stage: stage.kind,
          stageName: stage.name,
          captureOutput: Boolean(flow.authoritativeResult),
        });
        if (processFailed(outcome)) break;
        if (stage.kind === 'application') {
          uiOutput += `${outcome.stdout || ''}\n`;
          uiErrorOutput += `${outcome.stderr || ''}\n`;
          applicationFlowNames.push(path.basename(stage.path, path.extname(stage.path)));
        }
      }
    } catch (error) {
      const result = {
        flow: flow.name,
        status: "failed",
        failureStage: "ui",
        ...imeDismissalResultFields(androidImeDismissals),
        ...processFailureMetadata(error),
        stages: {
          fixture: { status: fixtureStatus, scenario: flow.fixtureScenario || null },
          backendPreflight: { status: backendPreflightStatus },
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
    if (processFailed(outcome)) {
      const result = {
        flow: flow.name,
        status: "failed",
        failureStage: "ui",
        ...imeDismissalResultFields(androidImeDismissals),
        ...processFailureMetadata(outcome),
        exitCode: outcome.code,
        signal: outcome.signal || null,
        stages: {
          fixture: { status: fixtureStatus, scenario: flow.fixtureScenario || null },
          backendPreflight: { status: backendPreflightStatus },
          ui: { status: "failed", exitCode: outcome.code, ...processFailureMetadata(outcome) },
          backend: { status: "not-run", verification: backendName },
        },
        report: toPosixPath(path.relative(fromRoot(), junitPath)),
        artifacts: relativeArtifacts,
      };
      results.push(result);
      writeJson(path.join(flowDirectory, "result.json"), result);
      writeJson(path.join(runDirectory, "summary.json"), { status: "failed", results });
      logStream.end();
      throw new Error(`${processFailureMetadata(outcome).errorCode || uiFailureLabel}: ${flow.name} (exit ${outcome.code ?? "unknown"}). See ${relativeArtifacts}.`);
    }

    let backendStatus = backendPlan ? "pending" : "skipped";
    let authoritativeResult;
    let correlationDiagnostics = flow.authoritativeResult ? emptyCorrelationDiagnostics() : undefined;
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
          stage: 'backend',
          captureOutput: Boolean(flow.authoritativeResult),
        });
        if (!processFailed(backendOutcome) && flow.authoritativeResult) {
          const sources = await collectCorrelationSources({ stdout: uiOutput, stderr: uiErrorOutput, artifactDirectory, applicationFlowNames, notBeforeMs: applicationStartedAt });
          authoritativeResult = parseAuthoritativeResult(backendOutcome.stdout, flow.authoritativeResult, sources, generation);
          correlationDiagnostics = Object.fromEntries(Object.keys(emptyCorrelationDiagnostics()).map((key) => [key, authoritativeResult[key]]));
          if (authoritativeResult.uiCorrelations) {
            correlationDiagnostics.uiCorrelations = authoritativeResult.uiCorrelations;
            correlationDiagnostics.backendCorrelations = authoritativeResult.backendCorrelations;
          }
        }
      } catch (error) {
        if (error.correlationDiagnostics) correlationDiagnostics = error.correlationDiagnostics;
        backendOutcome = { code: null, signal: null, error };
      }
      if (correlationDiagnostics) logStream.write(`[WorksideQA correlation] ${JSON.stringify(correlationDiagnostics)}\n`);
      if (processFailed(backendOutcome)) {
        const result = {
          flow: flow.name,
          status: "failed",
          failureStage: "backend",
          ...imeDismissalResultFields(androidImeDismissals),
          ...(correlationDiagnostics || {}),
          ...processFailureMetadata(backendOutcome),
          exitCode: outcome.code,
          backendExitCode: backendOutcome.code,
          stages: {
            fixture: { status: fixtureStatus, scenario: flow.fixtureScenario || null },
            backendPreflight: { status: backendPreflightStatus },
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
        throw new Error(`${processFailureMetadata(backendOutcome).errorCode || backendFailureLabel}: ${flow.name} (exit ${backendOutcome.code ?? "unknown"}).${detail} See ${relativeArtifacts}.`);
      }
      backendStatus = "passed";
      console.log(`[Backend] Passed ${backendPlan.verificationName}`);
    }

    const result = {
      flow: flow.name,
      generation,
      ...imeDismissalResultFields(androidImeDismissals),
      ...(authoritativeResult ? { authoritativeResult } : {}),
      ...(correlationDiagnostics || {}),
      status: "passed",
      exitCode: outcome.code,
      signal: outcome.signal || null,
      device: selectedDevice ? { descriptor: selectedDevice.descriptorName, id: selectedDevice.id, platform: selectedDevice.platform, kind: selectedDevice.kind, appId: selectedDevice.appId, osVersion: selectedDevice.osVersion, appVersion: selectedDevice.appVersion, appBuild: selectedDevice.appBuild } : null,
      stages: {
        fixture: { status: fixtureStatus, scenario: flow.fixtureScenario || null },
        backendPreflight: { status: backendPreflightStatus, ...(backendPreflight ? { identities: backendPreflight.identities } : {}) },
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
  runBackendIdentityPreflight,
  buildBackendVerificationPlan,
  buildDeviceLaunchFlow,
  buildMaestroTestArgs,
  buildFixtureResetPlan,
  collectEnvironmentReferences,
  normalizeFlowName,
  resolveMaestroProcessTimeoutMs,
  resolveMaestroProcessBudget,
  runProcess,
  runMaestroFlows,
  selectFlows,
  validateFixtureConfiguration,
  validateMaestroConfiguration,
};
