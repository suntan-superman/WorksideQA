const fs = require('node:fs');
const path = require('node:path');
const {
  spawnCommand,
  spawnCommandSync,
  terminateProcessTree,
} = require('../../qa-utils/src');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FLOW_DIRECTORY = path.join(ROOT, 'packages', 'qa-core', 'src', 'rendered-runtime-flows');
const DEFAULT_TIMEOUT_MS = 60_000;
const FLOW_TIMEOUT_MS = 60_000;
const CLI_STARTUP_GRACE_MS = 30_000;
const DEFAULT_POLL_MS = 250;

function readAppState(adb, deviceId, appId, execute = spawnCommandSync, env = process.env) {
  const pid = execute(adb, ['-s', deviceId, 'shell', 'pidof', appId], { env, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const pidText = String(pid.stdout || '').trim();
  const appPid = pid.status === 0 && /^\d+(?:\s+\d+)*$/.test(pidText) ? Number(pidText.split(/\s+/)[0]) : null;
  const foreground = execute(adb, ['-s', deviceId, 'shell', 'dumpsys', 'activity', 'activities'], { env, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const activityText = String(foreground.stdout || '');
  const escapedAppId = appId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const appForeground = new RegExp(`(?:^|[\\s/])${escapedAppId}(?:[/\\s])`).test(activityText)
    || (/(?:m?ResumedActivity|topResumedActivity)/.test(activityText) && activityText.includes(appId));
  return {
    appPid,
    appForeground,
    launcherForeground: !appForeground && /launcher|home|devlauncher/i.test(activityText),
    activityText: activityText.slice(-12_000),
  };
}

function startApplication(adb, deviceId, appId, launchUri, execute = spawnCommandSync, env = process.env) {
  const stop = execute(adb, ['-s', deviceId, 'shell', 'am', 'force-stop', appId], { env, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (stop.error || stop.status !== 0) return { ok: false, error: `force-stop failed: ${stop.stderr || stop.error?.message || stop.status}` };
  const launch = execute(adb, ['-s', deviceId, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', launchUri, '-p', appId], { env, encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return launch.error || launch.status !== 0 ? { ok: false, error: `launch failed: ${launch.stderr || launch.error?.message || launch.status}` } : { ok: true };
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

function readUiHierarchy(adb, deviceId, execute = spawnCommandSync, env = process.env) {
  const dump = execute(adb, ['-s', deviceId, 'shell', 'uiautomator', 'dump', '/sdcard/worksideqa-readiness.xml'], {
    env, encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (dump.error || dump.status !== 0) return '';
  const hierarchy = execute(adb, ['-s', deviceId, 'shell', 'cat', '/sdcard/worksideqa-readiness.xml'], {
    env, encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return hierarchy.error || hierarchy.status !== 0 ? '' : String(hierarchy.stdout || '');
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
  const finishedAt = Date.now();
  return {
    ok: false,
    reason,
    appPid: state?.appPid || null,
    launchStartedAt: new Date(startedAt).toISOString(),
    qaRootReadyAt: details.qaRootReadyAt || null,
    appReadyAt: null,
    elapsedMs: finishedAt - startedAt,
    timeoutMs,
    launcherForeground: Boolean(state?.launcherForeground),
    foregroundActivity: state?.activityText || null,
    readinessSource: 'maestro',
    ...details,
  };
}

async function waitForRenderedRuntime(options = {}) {
  const {
    adb, maestro, deviceId, appId, launchUri,
    execute = spawnCommandSync, spawn = spawnCommand, terminate = terminateProcessTree,
    now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readHierarchy = readUiHierarchy, readState = readAppState,
    timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS, artifactDirectory,
  } = options;
  if (!adb || !maestro || !deviceId || !appId || !launchUri) throw new Error('Rendered runtime probe requires adb, maestro, deviceId, appId, and launchUri.');
  const env = options.env || process.env;
  const rootFlow = path.join(FLOW_DIRECTORY, 'qa-root.yaml');
  if (!fs.existsSync(rootFlow)) throw new Error(`Rendered runtime flow is missing: ${rootFlow}`);
  const startedAt = now();
  const launch = startApplication(adb, deviceId, appId, launchUri, execute, env);
  if (!launch.ok) return { ...appReadinessFailure('LAUNCH_FAILED', null, startedAt, timeoutMs), error: launch.error || null };
  const deadline = startedAt + timeoutMs;
  const root = await runFlow(maestro, deviceId, rootFlow, env, Math.min(FLOW_TIMEOUT_MS + CLI_STARTUP_GRACE_MS, Math.max(1, deadline - now()) + CLI_STARTUP_GRACE_MS), spawn, terminate);
  let state = readState(adb, deviceId, appId, execute, env);
  if (!root.ok) {
    const reason = state.launcherForeground ? 'APP_NOT_FOREGROUND' : (!state.appPid ? 'APP_EXITED' : 'QA_ROOT_NOT_READY');
    return { ...appReadinessFailure(reason, state, startedAt, timeoutMs), flowOutput: root.output.slice(-2000) };
  }
  const rootReadyAt = now();
  let lastHierarchy = '';
  let lastSummary = null;
  let intermediateAt = null;
  let intermediateKind = null;
  let lastHierarchyAt = rootReadyAt;
  while (now() <= deadline) {
    state = readState(adb, deviceId, appId, execute, env);
    if (!state.appPid) {
      return { ...appReadinessFailure('APP_EXITED', state, startedAt, timeoutMs, { qaRootReadyAt: new Date(rootReadyAt).toISOString(), intermediateState: lastSummary, intermediateStateKind: intermediateKind, intermediateStateAt: intermediateAt !== null ? new Date(intermediateAt).toISOString() : null, lastHierarchyAt: new Date(lastHierarchyAt).toISOString() }) };
    }
    if (state.launcherForeground || !state.appForeground) {
      return { ...appReadinessFailure('APP_NOT_FOREGROUND', state, startedAt, timeoutMs, { qaRootReadyAt: new Date(rootReadyAt).toISOString(), intermediateState: lastSummary, intermediateStateKind: intermediateKind, intermediateStateAt: intermediateAt !== null ? new Date(intermediateAt).toISOString() : null, lastHierarchyAt: new Date(lastHierarchyAt).toISOString() }) };
    }
    const hierarchy = readHierarchy(adb, deviceId, execute, env);
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
          qaRootReadyAt: new Date(rootReadyAt).toISOString(),
          appReadyAt: new Date(readyAt).toISOString(),
          elapsedMs: readyAt - startedAt,
          timeoutMs,
          readySelector: loginReady ? 'screen.auth.login' : 'screen.dashboard.ready',
          readinessSource: 'maestro',
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
    hierarchy: lastHierarchy.slice(-16_000) || null,
  };
  const failed = appReadinessFailure('AUTH_OR_DASHBOARD_NOT_READY', state, startedAt, timeoutMs, details);
  failed.diagnosticArtifacts = captureFailureArtifacts({ artifactDirectory, adb, deviceId, execute, env, hierarchy: lastHierarchy, state });
  return failed;
}

module.exports = { DEFAULT_TIMEOUT_MS, readAppState, readUiHierarchy, hierarchySummary, startApplication, runFlow, waitForRenderedRuntime };
