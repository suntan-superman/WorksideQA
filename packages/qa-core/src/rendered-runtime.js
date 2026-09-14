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

function readAppState(adb, deviceId, appId, execute = spawnCommandSync, env = process.env) {
  const pid = execute(adb, ['-s', deviceId, 'shell', 'pidof', appId], { env, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const pidText = String(pid.stdout || '').trim();
  const appPid = pid.status === 0 && /^\d+(?:\s+\d+)*$/.test(pidText) ? Number(pidText.split(/\s+/)[0]) : null;
  const foreground = execute(adb, ['-s', deviceId, 'shell', 'dumpsys', 'activity', 'activities'], { env, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const activityText = String(foreground.stdout || '');
  const escapedAppId = appId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const appForeground = new RegExp(`(?:^|[\\s/])${escapedAppId}(?:[/\\s])`).test(activityText)
    || (/(?:m?ResumedActivity|topResumedActivity)/.test(activityText) && activityText.includes(appId));
  return { appPid, appForeground, launcherForeground: !appForeground && /launcher|home|devlauncher/i.test(activityText) };
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

function appReadinessFailure(reason, state, startedAt, timeoutMs) {
  const finishedAt = Date.now();
  return { ok: false, reason, appPid: state?.appPid || null, launchStartedAt: new Date(startedAt).toISOString(), qaRootReadyAt: null, appReadyAt: null, elapsedMs: finishedAt - startedAt, timeoutMs, launcherForeground: Boolean(state?.launcherForeground), readinessSource: 'maestro' };
}

async function waitForRenderedRuntime(options = {}) {
  const { adb, maestro, deviceId, appId, launchUri, execute = spawnCommandSync, spawn = spawnCommand, terminate = terminateProcessTree, now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  if (!adb || !maestro || !deviceId || !appId || !launchUri) throw new Error('Rendered runtime probe requires adb, maestro, deviceId, appId, and launchUri.');
  const env = options.env || process.env;
  const rootFlow = path.join(FLOW_DIRECTORY, 'qa-root.yaml');
  if (!fs.existsSync(rootFlow)) throw new Error(`Rendered runtime flow is missing: ${rootFlow}`);
  const startedAt = now();
  const launch = startApplication(adb, deviceId, appId, launchUri, execute, env);
  if (!launch.ok) return { ...appReadinessFailure('LAUNCH_FAILED', null, startedAt, timeoutMs), error: launch.error || null };
  const root = await runFlow(maestro, deviceId, rootFlow, env, Math.min(FLOW_TIMEOUT_MS + CLI_STARTUP_GRACE_MS, timeoutMs + CLI_STARTUP_GRACE_MS), spawn, terminate);
  const state = readAppState(adb, deviceId, appId, execute, env);
  if (!root.ok) return { ...appReadinessFailure(state.launcherForeground ? 'APP_NOT_FOREGROUND' : 'QA_ROOT_NOT_READY', state, startedAt, timeoutMs), flowOutput: root.output.slice(-2000) };
  const rootReadyAt = now();
  const output = readUiHierarchy(adb, deviceId, execute, env);
  const loginReady = output.includes('resource-id') && output.includes('screen.auth.login');
  const dashboardReady = output.includes('resource-id') && output.includes('screen.dashboard.ready');
  if (!state.appPid || !state.appForeground) return { ...appReadinessFailure('APP_NOT_FOREGROUND', state, startedAt, timeoutMs), qaRootReadyAt: new Date(rootReadyAt).toISOString() };
  if (!loginReady && !dashboardReady) return { ...appReadinessFailure('AUTH_OR_DASHBOARD_NOT_READY', state, startedAt, timeoutMs), qaRootReadyAt: new Date(rootReadyAt).toISOString(), flowOutput: output.slice(-4000) };
  const readyAt = now();
  return { ok: true, appPid: state.appPid || null, launchStartedAt: new Date(startedAt).toISOString(), qaRootReadyAt: new Date(rootReadyAt).toISOString(), appReadyAt: new Date(readyAt).toISOString(), elapsedMs: readyAt - startedAt, timeoutMs, readySelector: loginReady ? 'screen.auth.login' : 'screen.dashboard.ready', readinessSource: 'maestro' };
}

module.exports = { DEFAULT_TIMEOUT_MS, readAppState, readUiHierarchy, startApplication, runFlow, waitForRenderedRuntime };
