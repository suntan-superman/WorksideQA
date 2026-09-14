const fs = require('node:fs');
const path = require('node:path');
const {
  spawnCommand,
  spawnCommandSync,
  terminateProcessTree,
  acquireObserverLock,
} = require('../../qa-utils/src');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FLOW_DIRECTORY = path.join(ROOT, 'packages', 'qa-core', 'src', 'rendered-runtime-flows');
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 250;

function readAppState(adb, deviceId, appId, execute = spawnCommandSync, env = process.env) {
  const pid = execute(adb, ['-s', deviceId, 'shell', 'pidof', appId], { env, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const pidText = String(pid.stdout || '').trim();
  const appPid = pid.status === 0 && /^\d+(?:\s+\d+)*$/.test(pidText) ? Number(pidText.split(/\s+/)[0]) : null;
  const foreground = execute(adb, ['-s', deviceId, 'shell', 'dumpsys', 'activity', 'activities'], { env, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const activityText = String(foreground.stdout || '');
  const escapedAppId = appId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // dumpsys includes historical tasks as well as the current activity. Only
  // resumed/focused lines establish foreground ownership; seeing the package
  // elsewhere must not turn a launcher snapshot into an app-ready snapshot.
  const foregroundLines = activityText.split(/\r?\n/).filter((line) => /(?:m?ResumedActivity|topResumedActivity|mFocusedApp|topDisplayFocusedRootTask)/i.test(line));
  const foregroundText = foregroundLines.join('\n');
  const appForeground = new RegExp(`(?:^|[\\s/])${escapedAppId}(?:[/\\s])`).test(foregroundText);
  return {
    appPid,
    appForeground,
    launcherForeground: !appForeground && /launcher|home|devlauncher/i.test(foregroundText || activityText),
    activityText: activityText.slice(-12_000),
  };
}

function commandSnapshot(command, args, result, startedAt, endedAt) {
  return {
    command,
    args: [...args],
    displayCommand: [command, ...args].map((argument) => /\s/.test(argument) ? JSON.stringify(argument) : argument).join(' '),
    exitCode: Number.isInteger(result?.status) ? result.status : null,
    signal: result?.signal || null,
    stdout: String(result?.stdout || '').slice(-4000),
    stderr: String(result?.stderr || '').slice(-4000),
    error: result?.error ? String(result.error.message || result.error) : null,
    elapsedMs: Math.max(0, endedAt - startedAt),
  };
}

function commandFailure(code, label, snapshot) {
  const detail = snapshot.stderr || snapshot.error || snapshot.stdout || `exit code ${snapshot.exitCode}`;
  return {
    ok: false,
    code,
    ...snapshot,
    error: `${label} failed (${code}): ${detail}`,
  };
}

function runLaunchCommand(command, args, execute, env, timeout, now = Date.now) {
  const startedAt = now();
  let result;
  try {
    result = execute(command, args, { env, encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) || {};
  } catch (error) {
    result = { error };
  }
  const endedAt = now();
  return { result, snapshot: commandSnapshot(command, args, result, startedAt, endedAt) };
}

function verifyLaunchTarget(adb, deviceId, appId, launchUri, execute = spawnCommandSync, env = process.env, options = {}) {
  const now = options.now || Date.now;
  const expectedActivity = options.expectedActivity || 'com.merxus.mobile.MainActivity';
  const runShell = (args, timeout) => runLaunchCommand(adb, ['-s', deviceId, 'shell', ...args], execute, env, timeout, now);
  const runHost = (args, timeout) => runLaunchCommand(adb, ['-s', deviceId, ...args], execute, env, timeout, now);

  const packageCheck = runShell(['pm', 'list', 'packages', appId], 5000);
  if (packageCheck.result.error || packageCheck.result.status !== 0 || !String(packageCheck.result.stdout || '').split(/\r?\n/).some((line) => line.trim() === `package:${appId}`)) {
    return commandFailure('APP_PACKAGE_MISSING', `Package ${appId}`, packageCheck.snapshot);
  }

  const activityCheck = runShell(['dumpsys', 'package', appId], 8000);
  const activityText = `${activityCheck.result.stdout || ''}\n${activityCheck.result.stderr || ''}`;
  if (activityCheck.result.error || activityCheck.result.status !== 0 || !activityText.includes(expectedActivity)) {
    return commandFailure('ACTIVITY_RESOLUTION_FAILED', `Activity ${expectedActivity}`, activityCheck.snapshot);
  }

  const deepLinkCheck = runShell(['cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.VIEW', '-d', launchUri], 8000);
  const resolved = `${deepLinkCheck.result.stdout || ''}\n${deepLinkCheck.result.stderr || ''}`;
  const expectedComponent = `${appId}/${expectedActivity}`;
  if (deepLinkCheck.result.error || deepLinkCheck.result.status !== 0 || !resolved.includes(appId) || !resolved.includes(expectedActivity)) {
    const failure = commandFailure('DEEPLINK_RESOLUTION_FAILED', `Deep link ${launchUri} did not resolve to ${expectedComponent}`, deepLinkCheck.snapshot);
    failure.resolvedOutput = resolved.slice(-4000);
    return failure;
  }

  const reverseCheck = runHost(['reverse', '--list'], 5000);
  const reverseText = `${reverseCheck.result.stdout || ''}\n${reverseCheck.result.stderr || ''}`;
  if (!/(?:^|\s)tcp:8081\s+tcp:8081(?:\s|$)/m.test(reverseText)) {
    const reverseSetup = runHost(['reverse', 'tcp:8081', 'tcp:8081'], 5000);
    if (reverseSetup.result.error || reverseSetup.result.status !== 0) {
      return commandFailure('ADB_REVERSE_SETUP_FAILED', 'ADB reverse tcp:8081 -> tcp:8081', reverseSetup.snapshot);
    }
  }
  return {
    ok: true,
    expectedActivity,
    expectedComponent,
    deepLink: launchUri,
    reverse: 'tcp:8081 -> tcp:8081',
    checks: { package: packageCheck.snapshot, activity: activityCheck.snapshot, deepLink: deepLinkCheck.snapshot, reverse: reverseCheck.snapshot },
  };
}

function startApplication(adb, deviceId, appId, launchUri, execute = spawnCommandSync, env = process.env, options = {}) {
  const now = options.now || Date.now;
  const stopArgs = ['-s', deviceId, 'shell', 'am', 'force-stop', appId];
  const stop = runLaunchCommand(adb, stopArgs, execute, env, 5000, now);
  if (stop.result.error || stop.result.status !== 0) return commandFailure('ADB_LAUNCH_FAILED', 'force-stop', stop.snapshot);
  // Keep launch non-blocking: semantic readiness owns startup timing, while
  // adb returns the raw intent result immediately. The argument array is
  // passed directly so encoded URIs and spaces are never shell-expanded.
  const launchArgs = ['-s', deviceId, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', launchUri, '-p', appId];
  const launch = runLaunchCommand(adb, launchArgs, execute, env, 15_000, now);
  if (launch.result.error) {
    const timeout = launch.result.error.code === 'ETIMEDOUT' || /timed? ?out/i.test(String(launch.result.error.message || ''));
    return commandFailure(timeout ? 'LAUNCH_COMMAND_TIMEOUT' : 'ADB_LAUNCH_FAILED', 'launch', launch.snapshot);
  }
  if (launch.result.status !== 0) return commandFailure('ADB_LAUNCH_FAILED', 'launch', launch.snapshot);
  return { ok: true, command: adb, args: launchArgs, launch: launch.snapshot, stop: stop.snapshot };
}

function prepareApplicationLaunch(adb, deviceId, appId, launchUri, execute = spawnCommandSync, env = process.env, options = {}) {
  return verifyLaunchTarget(adb, deviceId, appId, launchUri, execute, env, options);
}

function runFlow(maestro, deviceId, flowPath, env, timeoutMs, spawn = spawnCommand, terminate = terminateProcessTree) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(maestro, ['--device', deviceId, 'test', '--no-ansi', flowPath], { env, cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { resolve({ ok: false, code: null, error: error.message, output: '' }); return; }
    let output = '';
    let timedOut = false;
    const capture = (chunk) => { output = (output + String(chunk)).slice(-32_000); };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const timer = setTimeout(() => { timedOut = true; terminate(child); }, timeoutMs);
    const finish = (code, signal, error = null) => { clearTimeout(timer); resolve({ ok: !timedOut && !error && code === 0, code, signal, error, output, timedOut }); };
    child.once('error', (error) => finish(null, null, error));
    child.once('close', finish);
  });
}

function readUiHierarchyResult(adb, deviceId, execute = spawnCommandSync, env = process.env) {
  const dump = execute(adb, ['-s', deviceId, 'shell', 'uiautomator', 'dump', '/sdcard/worksideqa-readiness.xml'], {
    env, encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (dump.error || dump.status !== 0) return { xml: '', error: dump.stderr || dump.error?.message || `uiautomator dump exited with ${dump.status}`, status: dump.status };
  const hierarchy = execute(adb, ['-s', deviceId, 'shell', 'cat', '/sdcard/worksideqa-readiness.xml'], {
    env, encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (hierarchy.error || hierarchy.status !== 0) return { xml: '', error: hierarchy.stderr || hierarchy.error?.message || `hierarchy read exited with ${hierarchy.status}`, status: hierarchy.status };
  return { xml: String(hierarchy.stdout || ''), error: null, status: 0 };
}

function readUiHierarchy(adb, deviceId, execute = spawnCommandSync, env = process.env) {
  return readUiHierarchyResult(adb, deviceId, execute, env).xml;
}

function hierarchySummary(xml) {
  const resourceIds = new Set();
  const visibleText = new Set();
  const contentDescriptions = new Set();
  const classes = new Set();
  const nodePattern = /<node\b[^>]*>/g;
  for (const node of String(xml || '').match(nodePattern) || []) {
    const read = (name) => {
      const match = node.match(`${name}="`)
        ? node.match(new RegExp(`${name}="([^"]*)"`))
        : null;
      return match ? match[1].replace(/&quot;/g, '"').trim() : '';
    };
    const id = read('resource-id');
    const text = read('text');
    const description = read('content-desc');
    const className = read('class');
    if (id) resourceIds.add(id);
    if (text) visibleText.add(text);
    if (description) contentDescriptions.add(description);
    if (className) classes.add(className);
  }
  return {
    resourceIds: [...resourceIds].slice(0, 200),
    visibleText: [...visibleText].slice(0, 200),
    contentDescriptions: [...contentDescriptions].slice(0, 200),
    classes: [...classes].slice(0, 100),
  };
}

function hierarchyHas(xml, selector) {
  return new RegExp(`resource-id=["']${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(String(xml || ''));
}

function classifyIntermediate(summary) {
  const text = [...(summary.visibleText || []), ...(summary.contentDescriptions || [])].join(' ');
  if (/loading|initializ|restor|bootstrap|preparing/i.test(text)) return 'APP_BOOTSTRAP_LOADING';
  const appResourceIds = (summary.resourceIds || []).filter((id) => id !== 'qa-environment-root');
  if (!appResourceIds.length && !summary.visibleText?.length && !summary.contentDescriptions?.length) return 'APP_BOOTSTRAP_NO_CONTENT';
  return 'APP_INTERMEDIATE_SCREEN';
}

function captureFailureArtifacts({ artifactDirectory, adb, deviceId, execute, env, hierarchy, state }) {
  if (!artifactDirectory) return {};
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const artifacts = {};
  if (hierarchy) {
    const hierarchyPath = path.join(artifactDirectory, 'hierarchy.xml');
    fs.writeFileSync(hierarchyPath, hierarchy, 'utf8');
    artifacts.hierarchyPath = hierarchyPath;
  }
  if (state?.activityText) {
    const activityPath = path.join(artifactDirectory, 'foreground-activity.txt');
    fs.writeFileSync(activityPath, state.activityText, 'utf8');
    artifacts.foregroundActivityPath = activityPath;
  }
  try {
    const screenshot = execute(adb, ['-s', deviceId, 'exec-out', 'screencap', '-p'], {
      env, encoding: null, timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!screenshot.error && screenshot.status === 0 && screenshot.stdout) {
      const screenshotPath = path.join(artifactDirectory, 'screenshot.png');
      fs.writeFileSync(screenshotPath, screenshot.stdout);
      artifacts.screenshotPath = screenshotPath;
    }
  } catch { /* diagnostics must never change readiness behavior */ }
  try {
    const logcat = execute(adb, ['-s', deviceId, 'logcat', '-d', '-t', '250'], {
      env, encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!logcat.error && logcat.status === 0) {
      const useful = String(logcat.stdout || '').split(/\r?\n/).filter((line) => /ReactNative|Expo|ExpoModules|AndroidRuntime|com\.merxus\.mobile\.qa|FATAL|\bE\//i.test(line)).slice(-120).join('\n');
      if (useful) {
        const logPath = path.join(artifactDirectory, 'runtime-logcat.txt');
        fs.writeFileSync(logPath, useful, 'utf8');
        artifacts.runtimeLogcatPath = logPath;
      }
    }
  } catch { /* diagnostics must never change readiness behavior */ }
  return artifacts;
}

function appReadinessFailure(reason, state, startedAt, timeoutMs, details = {}) {
  const finishedAt = details.probeEndMs ?? Date.now();
  return {
    ok: false,
    reason,
    appPid: state?.appPid || null,
    launchStartedAt: new Date(startedAt).toISOString(),
    probeStart: new Date(startedAt).toISOString(),
    probeEnd: new Date(finishedAt).toISOString(),
    qaRootReadyAt: details.qaRootReadyAt || null,
    stableScreenReadyAt: details.stableScreenReadyAt || null,
    appReadyAt: details.stableScreenReadyAt || null,
    elapsedMs: finishedAt - startedAt,
    timeoutMs,
    logicalBudgetMs: timeoutMs,
    failureCode: reason,
    launcherForeground: Boolean(state?.launcherForeground),
    foregroundActivity: state?.activityText || null,
    readinessSource: 'maestro',
    ...details,
  };
}

function observerFailureMarker(output) {
  return /uiautomationservice\s+already\s+registered|uiautomation(?:service)?\s+(?:startup|registration|connection)|observer\s+(?:failed|timeout|timed out)|hierarchy\s+(?:observer|dump)\s+(?:failed|unavailable)/i.test(String(output || ''));
}

function captureObserverProcesses(adb, deviceId, execute = spawnCommandSync, env = process.env, hostExecute = spawnCommandSync) {
  const hostCommand = process.platform === 'win32' ? 'tasklist.exe' : 'ps';
  const hostArgs = process.platform === 'win32' ? ['/FO', 'CSV', '/NH'] : ['-eo', 'pid=,comm=,args='];
  let hostOutput = '';
  try {
    const result = hostExecute(hostCommand, hostArgs, { env, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    hostOutput = String(result?.stdout || '');
  } catch { /* diagnostics must not prevent a readiness probe */ }
  let deviceOutput = '';
  try {
    const result = execute(adb, ['-s', deviceId, 'shell', 'ps', '-A'], { env, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    deviceOutput = String(result?.stdout || '');
  } catch { /* diagnostics must not prevent a readiness probe */ }
  const combined = `${hostOutput}\n${deviceOutput}`;
  const matching = combined.split(/\r?\n/).filter((line) => /maestro|dev\.mobile\.maestro|androidjunitrunner|uiautomator/i.test(line));
  return {
    hostProcesses: hostOutput.split(/\r?\n/).filter((line) => /maestro|java/i.test(line)).slice(-80),
    deviceProcesses: deviceOutput.split(/\r?\n/).filter((line) => /maestro|instrumentation|uiautomator/i.test(line)).slice(-80),
    activeDriverProcesses: matching.slice(-80),
  };
}

async function waitForObserverIdle(capture, now, sleep, deadline, pollMs = 100) {
  let snapshot = capture();
  while (snapshot?.activeDriverProcesses?.length && now() < deadline) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
    snapshot = capture();
  }
  return { idle: !snapshot?.activeDriverProcesses?.length, snapshot };
}

async function confirmLauncherForeground(readState, adb, deviceId, appId, execute, env, now, sleep, deadline) {
  const observations = [];
  const first = readState(adb, deviceId, appId, execute, env);
  observations.push({ at: now(), state: first });
  if (!first.launcherForeground) return { confirmed: false, observations };
  const remaining = deadline - now();
  if (remaining <= 0) return { confirmed: false, observations };
  await sleep(Math.min(250, remaining));
  const second = readState(adb, deviceId, appId, execute, env);
  observations.push({ at: now(), state: second });
  return { confirmed: Boolean(second.launcherForeground), observations };
}

async function waitForRenderedRuntime(options = {}) {
  const {
    adb, maestro, deviceId, appId, launchUri,
    execute = spawnCommandSync, spawn = spawnCommand, terminate = terminateProcessTree, runFlowImplementation = runFlow,
    now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readHierarchy = null, readHierarchyResult = readUiHierarchyResult, readState = readAppState,
    timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS, artifactDirectory,
  } = options;
  if (!adb || !maestro || !deviceId || !appId || !launchUri) throw new Error('Rendered runtime probe requires adb, maestro, deviceId, appId, and launchUri.');
  const env = options.env || process.env;
  const rootFlow = path.join(FLOW_DIRECTORY, 'qa-root.yaml');
  if (!fs.existsSync(rootFlow)) throw new Error(`Rendered runtime flow is missing: ${rootFlow}`);
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const launchPreparation = options.preflight === false
    ? { ok: true, skipped: true }
    : prepareApplicationLaunch(adb, deviceId, appId, launchUri, execute, env, { now, expectedActivity: options.expectedActivity });
  if (!launchPreparation.ok) {
    return {
      ...appReadinessFailure(launchPreparation.code || 'ADB_LAUNCH_FAILED', null, startedAt, timeoutMs, {
        probeEndMs: now(), launchDiagnostics: launchPreparation,
      }),
      error: launchPreparation.error || null,
    };
  }
  if (now() >= deadline) {
    return {
      ...appReadinessFailure('LAUNCH_COMMAND_TIMEOUT', null, startedAt, timeoutMs, {
        probeEndMs: now(), launchDiagnostics: launchPreparation,
      }),
      error: 'No logical readiness budget remained after launch preflight.',
    };
  }
  const launch = startApplication(adb, deviceId, appId, launchUri, execute, env, { now });
  if (!launch.ok) return { ...appReadinessFailure(launch.code || 'ADB_LAUNCH_FAILED', null, startedAt, timeoutMs, { probeEndMs: now(), launchDiagnostics: { preparation: launchPreparation, launch } }), error: launch.error || null };
  const observerStartedAt = now();
  const beforeObserver = readState(adb, deviceId, appId, execute, env);
  const observerBudget = Math.max(0, deadline - now());
  if (!observerBudget) return { ...appReadinessFailure('QA_ROOT_NOT_READY', beforeObserver, startedAt, timeoutMs, { probeEndMs: now(), observerFailureAt: new Date(now()).toISOString(), observerAttempts: [] }) };
  const observerProcessesBefore = options.observerProcessSnapshot
    ? options.observerProcessSnapshot('before')
    : captureObserverProcesses(adb, deviceId, execute, env);
  if (observerProcessesBefore?.activeDriverProcesses?.length) {
    return { ...appReadinessFailure('OBSERVER_BUSY', beforeObserver, startedAt, timeoutMs, { probeEndMs: now(), observerProcessesBefore }) , error: 'A Maestro/UiAutomation process is already active.' };
  }
  const lockPath = options.observerLockPath || path.join(ROOT, '.worksideqa', 'maestro-observer.lock');
  let observerLock;
  try {
    observerLock = options.acquireObserverLock
      ? options.acquireObserverLock(lockPath, { product: options.product || appId, deviceId, appId, flow: path.basename(rootFlow) })
      : acquireObserverLock(lockPath, { product: options.product || appId, deviceId, appId, flow: path.basename(rootFlow) });
  } catch (error) {
    return { ...appReadinessFailure('OBSERVER_BUSY', beforeObserver, startedAt, timeoutMs, { probeEndMs: now(), observerLock: { path: lockPath, error: error.message } }), error: error.message };
  }
  if (!observerLock?.ok) {
    const error = observerLock.error || new Error('Maestro observer lock is busy.');
    return { ...appReadinessFailure('OBSERVER_BUSY', beforeObserver, startedAt, timeoutMs, { probeEndMs: now(), observerLock: { path: observerLock.path || lockPath, owner: observerLock.owner || null, error: error.message } }), error: error.message };
  }
  let root;
  try {
    root = await runFlowImplementation(maestro, deviceId, rootFlow, env, observerBudget, spawn, terminate);
  } catch (error) {
    root = { ok: false, code: null, signal: null, timedOut: false, error, output: '' };
  } finally {
    observerLock.release();
  }
  const observerCapture = (phase) => options.observerProcessSnapshot
    ? options.observerProcessSnapshot(phase)
    : captureObserverProcesses(adb, deviceId, execute, env);
  const observerIdle = root.ok
    ? await waitForObserverIdle(() => observerCapture('after'), now, sleep, deadline)
    : (() => { const snapshot = observerCapture('after'); return { idle: !snapshot?.activeDriverProcesses?.length, snapshot }; })();
  const observerProcessesAfter = observerIdle.snapshot;
  const afterObserver = readState(adb, deviceId, appId, execute, env);
  if (root.ok && !observerIdle.idle) {
    return {
      ...appReadinessFailure('OBSERVER_CONFLICT', afterObserver, startedAt, timeoutMs, {
        probeEndMs: now(), observerFailureAt: new Date(now()).toISOString(), observerProcessesBefore, observerProcessesAfter,
        observerLock: { path: lockPath, owner: observerLock.owner || null }, launchDiagnostics: { preparation: launchPreparation, launch },
      }),
      error: 'Maestro instrumentation remained active after the observer exited.',
    };
  }
  const observerAttempt = {
    before: { timestamp: new Date(observerStartedAt).toISOString(), appPid: beforeObserver.appPid || null, appPidAlive: Boolean(beforeObserver.appPid), foregroundActivity: beforeObserver.activityText || null, appForeground: Boolean(beforeObserver.appForeground), launcherForeground: Boolean(beforeObserver.launcherForeground) },
    after: { timestamp: new Date(now()).toISOString(), appPid: afterObserver.appPid || null, appPidAlive: Boolean(afterObserver.appPid), foregroundActivity: afterObserver.activityText || null, appForeground: Boolean(afterObserver.appForeground), launcherForeground: Boolean(afterObserver.launcherForeground) },
    result: { ok: Boolean(root.ok), code: root.code, signal: root.signal, timedOut: Boolean(root.timedOut), error: root.error || null },
    output: String(root.output || '').slice(-2000),
    observerProcessesBefore,
    observerProcessesAfter,
    observerCleanupVerified: observerIdle.idle,
  };
  let state = readState(adb, deviceId, appId, execute, env);
  if (!root.ok) {
    const failureAt = now();
    let reason;
    if (!state.appPid) reason = beforeObserver.appPid ? 'APP_PROCESS_EXITED' : 'APP_PROCESS_NOT_STARTED';
    else if (/uiautomationservice\s+already\s+registered/i.test(String(root.output || ''))) reason = 'OBSERVER_CONFLICT';
    else if (observerFailureMarker(root.output) || root.timedOut) reason = 'OBSERVER_FAILURE';
    else if (state.launcherForeground) {
      const launcher = await confirmLauncherForeground(readState, adb, deviceId, appId, execute, env, now, sleep, deadline);
      reason = launcher.confirmed ? 'LAUNCHER_FOREGROUND' : 'QA_ROOT_NOT_READY';
      observerAttempt.launcherConfirmation = launcher.observations.map((item) => ({ timestamp: new Date(item.at).toISOString(), appPid: item.state.appPid || null, appPidAlive: Boolean(item.state.appPid), foregroundActivity: item.state.activityText || null, launcherForeground: Boolean(item.state.launcherForeground) }));
    } else if (state.appForeground) reason = 'APP_FOREGROUND_AND_NOT_READY';
    else reason = 'QA_ROOT_NOT_READY';
    const failed = appReadinessFailure(reason, state, startedAt, timeoutMs, { probeEndMs: failureAt, observerFailureAt: (reason === 'OBSERVER_FAILURE' || reason === 'OBSERVER_CONFLICT' ? new Date(failureAt).toISOString() : null), observerAttempts: [observerAttempt], flowOutput: String(root.output || '').slice(-2000), launchDiagnostics: { preparation: launchPreparation, launch }, observerLock: { path: lockPath, owner: observerLock.owner || null }, observerProcessesBefore });
    failed.diagnosticArtifacts = captureFailureArtifacts({ artifactDirectory, adb, deviceId, execute, env, hierarchy: '', state });
    return failed;
  }
  const rootReadyAt = now();
  let lastHierarchy = '';
  let lastSummary = null;
  let intermediateAt = null;
  let intermediateKind = null;
  let hierarchyError = null;
  let lastHierarchyAt = rootReadyAt;
  while (now() <= deadline) {
    state = readState(adb, deviceId, appId, execute, env);
    if (!state.appPid) {
      return { ...appReadinessFailure('APP_PROCESS_EXITED', state, startedAt, timeoutMs, { probeEndMs: now(), qaRootReadyAt: new Date(rootReadyAt).toISOString(), intermediateState: lastSummary, intermediateStateKind: intermediateKind, intermediateStateAt: intermediateAt !== null ? new Date(intermediateAt).toISOString() : null, lastHierarchyAt: new Date(lastHierarchyAt).toISOString(), observerAttempts: [observerAttempt] }) };
    }
    if (!state.appForeground) {
      const launcher = await confirmLauncherForeground(readState, adb, deviceId, appId, execute, env, now, sleep, deadline);
      if (launcher.confirmed) {
        return { ...appReadinessFailure('LAUNCHER_FOREGROUND', state, startedAt, timeoutMs, { probeEndMs: now(), qaRootReadyAt: new Date(rootReadyAt).toISOString(), intermediateState: lastSummary, intermediateStateKind: intermediateKind, intermediateStateAt: intermediateAt !== null ? new Date(intermediateAt).toISOString() : null, lastHierarchyAt: new Date(lastHierarchyAt).toISOString(), observerAttempts: [observerAttempt], foregroundConfirmation: launcher.observations.map((item) => ({ timestamp: new Date(item.at).toISOString(), foregroundActivity: item.state.activityText || null, appPid: item.state.appPid || null, appPidAlive: Boolean(item.state.appPid), launcherForeground: Boolean(item.state.launcherForeground) })) }) };
      }
    }
    if (now() > deadline) break;
    const hierarchyRead = readHierarchy
      ? readHierarchy(adb, deviceId, execute, env)
      : readHierarchyResult(adb, deviceId, execute, env);
    const hierarchy = typeof hierarchyRead === 'string' ? hierarchyRead : String(hierarchyRead?.xml || '');
    if (!hierarchy && hierarchyRead && typeof hierarchyRead === 'object' && hierarchyRead.error) hierarchyError = String(hierarchyRead.error).slice(-2000);
    if (hierarchy) {
      lastHierarchy = hierarchy;
      lastHierarchyAt = now();
      lastSummary = hierarchySummary(hierarchy);
      const loginReady = hierarchyHas(hierarchy, 'screen.auth.login');
      const dashboardReady = hierarchyHas(hierarchy, 'screen.dashboard.ready');
      if (loginReady || dashboardReady) {
        const readyAt = now();
        return {
          ok: true,
          appPid: state.appPid || null,
          launchStartedAt: new Date(startedAt).toISOString(),
          probeStart: new Date(startedAt).toISOString(),
          probeEnd: new Date(readyAt).toISOString(),
          qaRootReadyAt: new Date(rootReadyAt).toISOString(),
          stableScreenReadyAt: new Date(readyAt).toISOString(),
          appReadyAt: new Date(readyAt).toISOString(),
          elapsedMs: readyAt - startedAt,
          timeoutMs,
          logicalBudgetMs: timeoutMs,
          observerFailureAt: null,
          failureCode: null,
          readySelector: loginReady ? 'screen.auth.login' : 'screen.dashboard.ready',
          readinessSource: 'maestro',
          observerAttempts: [observerAttempt],
          launchDiagnostics: { preparation: launchPreparation, launch },
          intermediateState: lastSummary,
          intermediateStateKind: intermediateKind,
          intermediateStateAt: intermediateAt !== null ? new Date(intermediateAt).toISOString() : null,
          intermediateStateDurationMs: intermediateAt !== null ? Math.max(0, readyAt - intermediateAt) : null,
          lastHierarchyAt: new Date(lastHierarchyAt).toISOString(),
        };
      }
      if (!intermediateAt) {
        intermediateAt = lastHierarchyAt;
        intermediateKind = classifyIntermediate(lastSummary);
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }
  const details = {
    qaRootReadyAt: new Date(rootReadyAt).toISOString(),
    intermediateState: lastSummary,
    intermediateStateKind: intermediateKind,
    intermediateStateAt: intermediateAt !== null ? new Date(intermediateAt).toISOString() : null,
    intermediateStateDurationMs: intermediateAt !== null ? Math.max(0, now() - intermediateAt) : null,
    lastHierarchyAt: new Date(lastHierarchyAt).toISOString(),
    hierarchyError,
    hierarchy: lastHierarchy.slice(-16_000) || null,
    observerAttempts: [observerAttempt],
    launchDiagnostics: { preparation: launchPreparation, launch },
  };
  const failed = appReadinessFailure('STABLE_SCREEN_NOT_READY', state, startedAt, timeoutMs, { ...details, probeEndMs: now(), stableScreenReadyAt: null });
  if (!lastHierarchy && hierarchyError) {
    failed.reason = 'UI_HIERARCHY_UNAVAILABLE';
    failed.failureCode = failed.reason;
  }
  failed.diagnosticArtifacts = captureFailureArtifacts({ artifactDirectory, adb, deviceId, execute, env, hierarchy: lastHierarchy, state });
  return failed;
}

module.exports = { DEFAULT_TIMEOUT_MS, readAppState, readUiHierarchy, readUiHierarchyResult, hierarchySummary, captureObserverProcesses, verifyLaunchTarget, prepareApplicationLaunch, startApplication, runFlow, waitForRenderedRuntime };
