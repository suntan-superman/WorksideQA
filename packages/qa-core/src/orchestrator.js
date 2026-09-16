#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('cross-spawn');
const { spawnCommandSync } = require('../../qa-utils/src');
const { fromRoot } = require('../../qa-utils/src');
const { parsePowerShellConfig, mergedEnvironment, runDoctor, DEFAULTS, resolveCommand } = require('./doctor');
const { resolveTools, withToolPaths } = require('./tool-resolver');
const { prewarmMetroBundle, DEFAULT_PREWARM_TIMEOUT_MS } = require('./metro-bundle');
const { ensureAndroidEmulator } = require('./android-emulator');

const STATE_DIRECTORY = fromRoot('.worksideqa');
const STATE_PATH = path.join(STATE_DIRECTORY, 'runtime-state.json');
const LOG_DIRECTORY = path.join(STATE_DIRECTORY, 'logs');
const POLL_MS = 500;
const READY_TIMEOUT_MS = 120000;
const TERMINATION_TIMEOUT_MS = 10000;

function parseArgs(argv) {
  const options = { action: 'status', product: null, service: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--product') options.product = String(argv[++i] || '').trim().toLowerCase();
    else if (arg === '--service') options.service = String(argv[++i] || '').trim().toLowerCase();
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--start') options.action = 'start';
    else if (arg === '--stop') options.action = 'stop';
    else if (arg === '--restart') options.action = 'restart';
    else if (arg === 'start' || arg === 'stop' || arg === 'status' || arg === 'restart') options.action = arg;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.product && !['merxus', 'sageset'].includes(options.product)) throw new Error('--product must be merxus or sageset.');
  return options;
}

function helpText() {
  return `WorksideQA service orchestration

Usage:
  npm run qa:start -- --product merxus
  npm run qa:start -- --product sageset
  npm run qa:status [-- --product merxus|sageset]
  npm run qa:stop [-- --product merxus|sageset]
  npm run qa:restart:merxus:metro
  npm run qa:restart:merxus:firebase
  npm run qa:restart:merxus:backend
  npm run qa:restart:sageset:firebase

The orchestrator owns only processes recorded in .worksideqa/runtime-state.json.
It never kills an unrecorded process or changes a port to avoid a conflict.
`;
}

function canonicalMerxusMetroEnvironment(env) {
  // These values are deliberately authoritative for qa:start. A production
  // EXPO_PUBLIC_* variable inherited by a shell must never silently change
  // the runtime served to the QA package.
  const canonical = { ...env };
  for (const key of ['EXPO_PUBLIC_FIREBASE_API_KEY', 'EXPO_PUBLIC_FIREBASE_APP_ID', 'EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET', 'EXPO_PUBLIC_FIXTURE_GENERATION']) delete canonical[key];
  return {
    ...canonical,
    MERXUS_MOBILE_ENVIRONMENT: 'maestro',
    MERXUS_QA_ENVIRONMENT: 'maestro',
    EXPO_PUBLIC_ENVIRONMENT: 'maestro',
    EXPO_PUBLIC_API_BASE_URL: 'http://127.0.0.1:8787',
    EXPO_PUBLIC_FIREBASE_PROJECT_ID: 'merxus-maestro-local',
    EXPO_PUBLIC_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    EXPO_PUBLIC_FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    EXPO_PUBLIC_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
    EXPO_PUBLIC_ALLOW_EXTERNAL_PROVIDERS: 'false',
    EXPO_NO_DOTENV: '1',
  };
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return state && typeof state === 'object' ? state : { version: 1, products: {} };
  } catch {
    return { version: 1, products: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIRECTORY, { recursive: true });
  const temporary = `${STATE_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), products: state.products || {} }, null, 2)}\n`);
  fs.renameSync(temporary, STATE_PATH);
}

function serviceDefinitions(product, env, tools = null) {
  const resolved = tools || {};
  const npm = resolved.npm?.path || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const firebase = resolved.firebase?.path || (process.platform === 'win32' ? 'firebase.cmd' : 'firebase');
  if (product === 'sageset') {
    const root = path.resolve(env.SAGESET_MOBILE_REPO || DEFAULTS.sagesetRoot);
    return [{
      service: 'firebase', role: 'firebase-emulators', cwd: path.dirname(root), executable: firebase,
      args: ['emulators:start', '--project', 'sageset-maestro-local', '--only', 'auth,firestore,storage,functions'],
      ports: [9099, 8080, 9199, 5001],
      env: { ...env, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' },
    }];
  }
  const mobile = env.MERXUS_MOBILE_REPO || path.join(DEFAULTS.merxusRoot, 'mobile');
  const backend = env.MERXUS_BACKEND_REPO || path.join(DEFAULTS.merxusRoot, 'merxus-ai-backend');
  const web = path.join(DEFAULTS.merxusRoot, 'web');
  return [
    {
      service: 'firebase', role: 'firebase-emulators', cwd: web, executable: firebase,
      args: ['emulators:start', '--project', 'merxus-maestro-local', '--config', 'firebase.json', '--only', 'auth,firestore,storage'],
      ports: [9099, 8080, 9199], env,
    },
    {
      service: 'backend', role: 'qa-backend', cwd: backend, executable: npm,
      args: ['run', 'qa:maestro:serve'], ports: [8787], env,
    },
    {
      service: 'metro', role: 'maestro-metro', cwd: mobile, executable: npm,
      args: ['exec', '--', 'expo', 'start', '--dev-client', '--host', 'lan', '--port', '8081', '--clear'], ports: [8081], env: canonicalMerxusMetroEnvironment(env),
    },
  ];
}

function pidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch (error) {
    // Windows reports EPERM for a live process when this Node process lacks
    // query/termination rights. Treat it as alive; processInfo/identity checks
    // still decide whether it is ours.
    return error?.code === 'EPERM';
  }
}

function processInfo(pid) {
  if (!pidAlive(pid)) return null;
  if (process.platform !== 'win32') return { pid: Number(pid) };
  const outcome = spawnCommandSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress`], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  if (outcome.error || outcome.status !== 0) return { pid: Number(pid) };
  try { return JSON.parse(String(outcome.stdout || '{}')); } catch { return { pid: Number(pid) }; }
}

function processTreePids(rootPid) {
  if (process.platform !== 'win32') return [Number(rootPid)];
  const outcome = spawnCommandSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  if (outcome.error || outcome.status !== 0) return [Number(rootPid)];
  let rows;
  try { rows = JSON.parse(String(outcome.stdout || '[]')); } catch { return [Number(rootPid)]; }
  if (!Array.isArray(rows)) rows = [rows];
  const descendants = new Set([Number(rootPid)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const pid = Number(row.ProcessId || 0);
      const parent = Number(row.ParentProcessId || 0);
      if (pid && descendants.has(parent) && !descendants.has(pid)) { descendants.add(pid); changed = true; }
    }
  }
  return [...descendants];
}

function processTreeMetadata(rootPid, infoResolver = processInfo, treeResolver = processTreePids) {
  return treeResolver(rootPid).map((pid) => {
    return normalizeProcessInfo(pid, infoResolver(pid));
  }).filter((item) => item.pid > 0);
}

function normalizeProcessInfo(pid, info = {}) {
  return {
    pid: Number(pid),
    parentPid: Number(info.ParentProcessId || info.parentProcessId || 0) || null,
    executable: String(info.Name || info.name || info.executable || ''),
    commandLine: String(info.CommandLine || info.commandLine || info.commandline || ''),
    startedAt: info.CreationDate || info.creationDate || info.startedAt || null,
  };
}

function normalizedCommand(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function processIdentityMatches(expected, actual) {
  if (!expected || !actual || Number(expected.pid) !== Number(actual.pid)) return false;
  // CreationDate protects against accepting a recycled PID.  A missing value
  // is tolerated only for legacy records created before metadata was stored.
  // For modern records, an uninspectable live PID is not safe to adopt: it may
  // have been reused by an unrelated process.
  if (expected.startedAt && !actual.startedAt) return false;
  if (expected.startedAt && actual.startedAt && String(expected.startedAt) !== String(actual.startedAt)) return false;
  if (expected.executable && !actual.executable) return false;
  if (expected.executable && actual.executable && normalizedCommand(expected.executable) !== normalizedCommand(actual.executable)) return false;
  if (expected.commandLine && !actual.commandLine) return false;
  if (expected.commandLine && actual.commandLine && normalizedCommand(expected.commandLine) !== normalizedCommand(actual.commandLine)) return false;
  return true;
}

function concretePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function reconcileRecord(record, ownerResolver = portOwner, infoResolver = processInfo, aliveResolver = pidAlive) {
  if (!record) return { state: 'NOT RUNNING', owned: false, recovered: false, portOwners: [] };
  const storedTree = Array.isArray(record.processTree) ? record.processTree :
    (Array.isArray(record.processTreePids) ? record.processTreePids.map((pid) => ({ pid })) : []);
  const currentTree = storedTree.map((expected) => {
    const pid = Number(expected.pid);
    if (!aliveResolver(pid)) return null;
    const actual = normalizeProcessInfo(pid, infoResolver(pid));
    return processIdentityMatches(expected, actual) ? { ...expected, ...actual, pid } : { mismatch: true, expected, actual };
  }).filter(Boolean);
  const mismatched = currentTree.find((item) => item.mismatch);
  // Normalize malformed resolver values so stale metadata can never turn an
  // informational value such as "unknown" into a phantom live collision.
  const portOwners = (record.ports || record.port ? (record.ports || [record.port]) : []).map((port) => ({ port, pid: concretePid(ownerResolver(port)) }));
  const known = new Map(currentTree.filter((item) => !item.mismatch).map((item) => [Number(item.pid), item]));
  const foreign = portOwners.find((item) => item.pid && !known.has(Number(item.pid)) && Number(item.pid) !== Number(record.pid));
  // Persisted records can outlive their processes (for example after a
  // reboot). When every expected port is free, an identity mismatch is
  // stale metadata rather than a live collision. Reconcile it without
  // adopting or terminating any process. A real listener remains a conflict.
  if (mismatched && !portOwners.some((item) => item.pid)) {
    return {
      state: 'STALE', owned: false, recovered: false, stale: true, portOwners,
      currentTree, mismatch: mismatched,
      reason: `recorded PID ${mismatched.expected?.pid} identity is stale and expected ports are free`,
    };
  }
  if (foreign || mismatched) {
    return {
      state: 'CONFLICT', owned: false, recovered: false, portOwners, mismatch: mismatched || foreign,
      reason: foreign ? `port ${foreign.port} owner PID ${foreign.pid} is not in the recorded tree` : `recorded PID ${mismatched.expected?.pid} identity changed`,
    };
  }
  const rootAlive = aliveResolver(record.rootPid || record.pid);
  const rootOwned = rootAlive && commandMatches(record, infoResolver(record.rootPid || record.pid));
  const descendantPort = portOwners.some((item) => item.pid && Number(item.pid) !== Number(record.pid) && known.has(Number(item.pid)));
  if (!rootAlive && !currentTree.some((item) => !item.mismatch) && !portOwners.some((item) => item.pid)) {
    return {
      state: 'STALE', owned: false, recovered: false, stale: true, portOwners,
      currentTree, reason: 'recorded service tree is gone and expected ports are free',
    };
  }
  const recovered = !rootOwned && (currentTree.some((item) => Number(item.pid) !== Number(record.pid)) || descendantPort);
  if (rootOwned) return { state: 'RUNNING', owned: true, recovered: false, portOwners, currentTree };
  if (recovered) {
    record.rootPid = Number(record.rootPid || record.pid);
    record.startupGeneration = record.startupGeneration || `${record.startedAt || 'legacy'}-${record.runtimeHash || 'unknown'}`;
    record.processTree = currentTree.filter((item) => !item.mismatch).map((item) => ({
      pid: Number(item.pid), parentPid: Number(item.ParentProcessId || item.parentPid || 0) || null,
      executable: String(item.Name || item.executable || ''), commandLine: String(item.CommandLine || item.commandLine || ''),
      startedAt: item.CreationDate || item.creationDate || item.startedAt || null,
    }));
    record.processTreePids = record.processTree.map((item) => item.pid);
    record.reconciledAt = new Date().toISOString();
    return { state: 'RECOVERED', owned: true, recovered: true, portOwners, currentTree, reason: 'matched recorded descendant identity' };
  }
  return { state: 'NOT RUNNING', owned: false, recovered: false, portOwners, currentTree };
}

function commandMatches(record, info) {
  if (!info || !record) return false;
  if (process.platform !== 'win32') return true;
  const command = String(info.CommandLine || info.commandLine || '').toLowerCase();
  const expected = [record.executable, ...(record.args || [])].join(' ').toLowerCase();
  return command.includes(String(record.service || '').toLowerCase()) || command.includes(path.basename(String(record.executable || '')).toLowerCase()) || expected.split(/\s+/).filter((token) => token.length > 3).some((token) => command.includes(token));
}

function portOwner(port) {
  if (process.platform === 'win32') {
    const output = spawnCommandSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    if (output.error || output.status !== 0) return null;
    const match = String(output.stdout || '').match(new RegExp(`^\\s*TCP\\s+\\S+:${Number(port)}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'im'));
    return match ? Number(match[1]) : null;
  }
  const output = spawnCommandSync('lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  const match = String(output.stdout || '').trim().match(/^\d+/);
  return match ? Number(match[0]) : null;
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = require('node:net').createConnection({ host, port });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function maestroActivity() {
  if (process.platform === 'win32') {
    const outcome = spawnCommandSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match "(?i)maestro(\\.bat)?\\s+(test|hierarchy)|maestro\\.jar" } | Select-Object -First 1 ProcessId'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return !outcome.error && /\d+/.test(String(outcome.stdout || '')) ? 'active' : 'idle';
  }
  const outcome = spawnCommandSync('pgrep', ['-f', 'maestro'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  return !outcome.error && outcome.status === 0 ? 'active' : 'idle';
}

async function waitForPorts(ports, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await Promise.all(ports.map((port) => portOpen(port)));
    if (ready.every(Boolean)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return false;
}

function spawnService(definition, product) {
  fs.mkdirSync(LOG_DIRECTORY, { recursive: true });
  const logPath = path.join(LOG_DIRECTORY, `${definition.service}.log`);
  // Give the long-running child its own log file descriptors. Keeping a
  // parent-owned stdout/stderr relay open would leave active pipe handles in
  // the qa:start process after readiness, preventing the CLI from returning
  // to the caller. The descriptors are closed in the parent immediately
  // after spawn; the child retains the inherited file handles for its
  // lifetime, so startup/failure logs remain available without pinning the
  // orchestrator process.
  let stdoutFd;
  let stderrFd;
  try {
    stdoutFd = fs.openSync(logPath, 'a');
    stderrFd = fs.openSync(logPath, 'a');
    const child = spawn(definition.executable, definition.args, {
      cwd: definition.cwd,
      env: { ...definition.env, NO_UPDATE_NOTIFIER: '1' },
      // Services must survive the short-lived qa:start CLI on every platform.
      // Windows uses an independent process group as well; ownership and
      // cleanup remain safe because each recorded tree member is terminated
      // individually after identity verification when qa:stop is requested.
      detached: true,
      windowsHide: true,
      stdio: ['ignore', stdoutFd, stderrFd],
    });
    return finishSpawnedService(child, definition, product, logPath);
  } finally {
    if (stdoutFd !== undefined) {
      try { fs.closeSync(stdoutFd); } catch { /* child inherited the fd */ }
    }
    if (stderrFd !== undefined) {
      try { fs.closeSync(stderrFd); } catch { /* child inherited the fd */ }
    }
  }
}

function finishSpawnedService(child, definition, product, logPath) {
  let exitInfo = null;
  child.once('error', (error) => {
    exitInfo = { code: null, signal: null, error: error.message };
  });
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal };
  });
  child.unref();
  const runtimeIdentity = `${definition.cwd}|${definition.executable}|${definition.args.join(' ')}`;
  const startupGeneration = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  return {
    record: {
      product, service: definition.service, role: definition.role, pid: child.pid,
    rootPid: child.pid, startupGeneration,
    startedAt: new Date().toISOString(), cwd: definition.cwd,
    executable: definition.executable, path: definition.executable, args: definition.args, port: definition.ports[0], ports: definition.ports,
    logPath, runtimeHash: crypto.createHash('sha256').update(runtimeIdentity).digest('hex'),
    processTreePids: [child.pid], processTree: [],
    },
    child,
    getExitInfo: () => exitInfo,
  };
}

function tailLog(logPath, maxLines = 12) {
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).join('\n');
  } catch { return '(log unavailable)'; }
}

async function waitForServiceReady(service, timeoutMs = READY_TIMEOUT_MS, readinessProbe = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exitInfo = service.getExitInfo();
    if (exitInfo) return { ready: false, reason: 'PROCESS_EXITED', exitInfo };
    if (await waitForPorts(service.record.ports, 500)) {
      const probe = readinessProbe ? await readinessProbe() : true;
      if (probe === true || probe?.ready === true) return { ready: true, probe: probe === true ? null : probe };
      if (probe?.fatal) return { ready: false, reason: probe.reason || 'READINESS_FAILED', detail: probe.detail || probe.error || null, probe };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const exitInfo = service.getExitInfo();
  return exitInfo ? { ready: false, reason: 'PROCESS_EXITED', exitInfo } : { ready: false, reason: 'READINESS_TIMEOUT' };
}

async function prewarmCanonicalMetro(env, platform = 'android') {
  const mobileRoot = env.MERXUS_MOBILE_REPO || path.join(DEFAULTS.merxusRoot, 'mobile');
  const { verifyExpoConfig } = require('../../qa-mobile/src/merxus-mobile-runtime');
  return prewarmMetroBundle({
    baseUrl: env.WORKSIDEQA_METRO_URL || 'http://127.0.0.1:8081',
    platform,
    timeoutMs: Number(env.WORKSIDEQA_METRO_BUNDLE_PREWARM_TIMEOUT_MS || DEFAULT_PREWARM_TIMEOUT_MS),
    validateManifest: (manifest) => verifyExpoConfig(manifest?.extra?.expoClient, mobileRoot, `prewarmed Metro ${platform} manifest`, platform),
  });
}

function metroServedRuntimeReady(env) {
  const tool = path.join(fromRoot(), 'packages', 'qa-mobile', 'src', 'merxus-mobile-runtime.js');
  const result = spawnCommandSync(process.execPath, [tool, '--mobile-root', env.MERXUS_MOBILE_REPO, '--served-only'], {
    cwd: fromRoot(), env, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return !result.error && result.status === 0;
}

function reportServiceFailure(record, readiness) {
  const exitInfo = readiness.exitInfo || {};
  process.stderr.write(`FAILED ${record.product}/${record.service}\n`);
  process.stderr.write(`PID: ${record.pid}\n`);
  if (readiness.reason === 'PROCESS_EXITED') {
    process.stderr.write(`Exit code: ${exitInfo.code == null ? '(none)' : exitInfo.code}\n`);
    if (exitInfo.signal) process.stderr.write(`Signal: ${exitInfo.signal}\n`);
    if (exitInfo.error) process.stderr.write(`Error: ${exitInfo.error}\n`);
  } else {
    process.stderr.write(`Reason: ${readiness.reason}\n`);
  }
  if (readiness.detail) process.stderr.write(`Detail: ${readiness.detail}\n`);
  if (readiness.probe?.bundlePrewarmElapsedMs != null) process.stderr.write(`Bundle prewarm elapsed: ${readiness.probe.bundlePrewarmElapsedMs}ms\n`);
  process.stderr.write(`Log: ${record.logPath}\n`);
  process.stderr.write(`Last error:\n${tailLog(record.logPath)}\n`);
  process.stderr.write('Startup aborted.\n');
}

function runFixtureCommand(product, env, args) {
  const cwd = product === 'merxus'
    ? (env.MERXUS_BACKEND_REPO || path.join(DEFAULTS.merxusRoot, 'merxus-ai-backend'))
    : path.dirname(env.SAGESET_MOBILE_REPO || DEFAULTS.sagesetRoot);
  const executable = resolveCommand('npm', env) || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  return spawnCommandSync(executable, args, {
    cwd, env: { ...env, NO_UPDATE_NOTIFIER: '1' }, encoding: 'utf8', timeout: 120000,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function fixtureFailure(product, stage, generation, outcome) {
  const output = `${String(outcome?.stdout || '')}\n${String(outcome?.stderr || '')}`.trim();
  const lines = output.split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
  process.stderr.write(`FAILED ${product}/${stage}\nGeneration: ${generation}\nExit code: ${outcome?.status == null ? '(none)' : outcome.status}\n`);
  if (lines) process.stderr.write(`Last error:\n${lines}\n`);
  process.stderr.write('Startup aborted before Metro certification. Services remain available for diagnosis.\n');
}

async function verifyBackendIdentities(env) {
  const backendUrl = String(env.MERXUS_QA_BACKEND_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
  const owners = [
    ['Owner A', env.MERXUS_MAESTRO_OWNER_A_EMAIL],
    ['Owner B', env.MERXUS_MAESTRO_OWNER_B_EMAIL],
  ];
  for (const [label, rawEmail] of owners) {
    const email = String(rawEmail || '').trim().toLowerCase();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let response;
    try {
      response = await fetch(`${backendUrl}/api/auth/check-email`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }), signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw new Error(`${label} backend identity check failed: ${error.name === 'AbortError' ? 'timeout' : error.message}`);
    }
    clearTimeout(timer);
    const body = await response.json().catch(() => ({}));
    if (response.status !== 200 || body.exists !== true || body.provider !== 'email' || body.hasWorkspace !== true) {
      throw new Error(`${label} backend identity check failed (HTTP ${response.status}, exists=${body.exists === true}, provider=${body.provider || 'none'}, hasWorkspace=${body.hasWorkspace === true})`);
    }
  }
}

function fixtureCommands(product, generation) {
  const scenario = product === 'merxus' ? 'login-owner-a' : 'clean';
  return {
    scenario,
    verify: product === 'merxus' ? ['run', 'qa:maestro:auth:verify'] : ['--prefix', 'functions', 'run', 'verify:maestro-fixtures'],
    reset: product === 'merxus'
      ? ['run', 'qa:maestro:reset', '--', '--scenario', scenario, '--generation', generation, '--apply', '--confirm-reset']
      : ['--prefix', 'functions', 'run', 'reset:maestro-fixtures', '--', '--scenario', scenario, '--apply', '--confirm-reset'],
  };
}

async function bootstrapFixtures(product, env, state) {
  const generation = `${product === 'merxus' ? 'merxus-maestro' : 'sageset-maestro'}-worksideqa-start-${Date.now()}`;
  const commands = fixtureCommands(product, generation);
  const fixture = { generation, bootstrapTimestamp: new Date().toISOString(), scenario: commands.scenario, resetPerformed: false, authVerification: 'pending', backendIdentityVerification: 'pending' };
  const verifyArgs = commands.verify;
  let verify = runFixtureCommand(product, env, verifyArgs);
  if (verify.error || verify.status !== 0) {
    const resetArgs = commands.reset;
    const reset = runFixtureCommand(product, env, resetArgs);
    if (reset.error || reset.status !== 0) {
      fixtureFailure(product, 'fixture-bootstrap', generation, reset);
      throw new Error(`${product} fixture bootstrap failed.`);
    }
    fixture.resetPerformed = true;
    verify = runFixtureCommand(product, env, verifyArgs);
  }
  if (verify.error || verify.status !== 0) {
    fixtureFailure(product, 'auth-verification', generation, verify);
    throw new Error(`${product} canonical auth verification failed.`);
  }
  fixture.authVerification = 'passed';
  if (product === 'merxus') {
    try { await verifyBackendIdentities(env); } catch (error) {
      fixtureFailure(product, 'backend-identity-verification', generation, { status: 1, stderr: error.message });
      throw error;
    }
  }
  fixture.backendIdentityVerification = 'passed';
  state.products[product].fixture = fixture;
  saveState(state);
  process.stdout.write(`Fixtures ${product}: READY (generation ${generation})\n`);
  process.stdout.write(`${product === 'merxus' ? 'Owner A' : 'User A'}: VERIFIED\n`);
  process.stdout.write(`${product === 'merxus' ? 'Owner B' : 'User B'}: VERIFIED\n`);
  if (product === 'merxus') process.stdout.write('Backend identities: VERIFIED\n');
  return fixture;
}

function ownedRecord(record) {
  if (!record || !pidAlive(record.pid)) return false;
  const info = processInfo(record.pid);
  const rootEntry = Array.isArray(record.processTree) && record.processTree.find((item) => Number(item.pid) === Number(record.rootPid || record.pid));
  if (rootEntry && processIdentityMatches(rootEntry, normalizeProcessInfo(record.pid, info))) return true;
  return commandMatches(record, info);
}

function processBelongsTo(record, pid) {
  if (!record || !pidAlive(pid)) return false;
  if (Number(pid) === Number(record.pid)) return true;
  // POSIX services are started detached as a process group. Once the recorded
  // leader is owned, its listener is trusted to be a member of that group;
  // Windows requires explicit parent-chain inspection because npm.cmd wraps
  // the actual listener process.
  if (process.platform !== 'win32') return true;
  const seen = new Set();
  let current = Number(pid);
  while (current > 0 && !seen.has(current)) {
    seen.add(current);
    const info = processInfo(current);
    const parent = Number(info?.ParentProcessId || info?.parentProcessId || 0);
    if (!parent) return false;
    if (parent === Number(record.pid)) return true;
    current = parent;
  }
  return false;
}

function verifiedProcessTreePids(record) {
  const tree = Array.isArray(record?.processTree) ? record.processTree :
    (Array.isArray(record?.processTreePids) ? record.processTreePids.map((pid) => ({ pid })) : []);
  return tree.map((expected) => {
    const pid = Number(expected.pid);
    if (!pidAlive(pid)) return null;
    const actual = processInfo(pid);
    return processIdentityMatches(expected, { ...actual, pid }) ? pid : null;
  }).filter(Boolean);
}

function terminationTree(record, ownership, options = {}) {
  const aliveResolver = options.aliveResolver || pidAlive;
  const infoResolver = options.infoResolver || processInfo;
  const tree = Array.isArray(ownership?.currentTree) && ownership.currentTree.length
    ? ownership.currentTree
    : (Array.isArray(record?.processTree) ? record.processTree :
      (Array.isArray(record?.processTreePids) ? record.processTreePids.map((pid) => ({ pid })) : []));
  return tree.map((expected) => {
    const pid = Number(expected?.pid);
    if (!pid || !aliveResolver(pid)) return null;
    const actual = normalizeProcessInfo(pid, infoResolver(pid));
    // Termination is deliberately stricter than status reconciliation. A
    // process with missing or changed identity is never a kill target.
    const hasMetadata = Boolean(expected?.executable || expected?.commandLine || expected?.startedAt);
    const verified = hasMetadata
      ? Boolean(actual.executable && actual.commandLine && processIdentityMatches(expected, actual))
      : (pid === Number(record?.rootPid || record?.pid) && commandMatches(record, actual));
    return verified ? pid : null;
  }).filter(Boolean);
}

function busyPorts(record, ownerResolver = portOwner) {
  return (record?.ports || (record?.port ? [record.port] : []))
    .map((port) => ({ port: Number(port), pid: ownerResolver(Number(port)) }))
    .filter((item) => item.pid);
}

async function waitForTermination(record, pids, options = {}) {
  const aliveResolver = options.aliveResolver || pidAlive;
  const infoResolver = options.infoResolver || processInfo;
  const ownerResolver = options.ownerResolver || portOwner;
  const portOpenResolver = options.portOpenResolver || portOpen;
  const pollMs = options.pollMs || POLL_MS;
  const deadline = Date.now() + (options.timeoutMs || TERMINATION_TIMEOUT_MS);
  const isStillVerified = (pid) => {
    if (!aliveResolver(pid)) return false;
    const expected = (record.processTree || []).find((item) => Number(item.pid) === Number(pid));
    const actual = normalizeProcessInfo(pid, infoResolver(pid));
    if (expected && (expected.executable || expected.commandLine || expected.startedAt)) {
      return Boolean(actual.executable && actual.commandLine && processIdentityMatches(expected, actual));
    }
    return Number(pid) === Number(record.rootPid || record.pid) && commandMatches(record, actual);
  };
  const readRemaining = async () => {
    const remainingPids = pids.filter(isStillVerified);
    const remainingPorts = [];
    for (const port of (record.ports || (record.port ? [record.port] : []))) {
      const owner = ownerResolver(Number(port));
      const open = owner ? true : await portOpenResolver(Number(port));
      if (owner || open) remainingPorts.push({ port: Number(port), pid: owner || null });
    }
    return { remainingPids, remainingPorts };
  };
  while (Date.now() < deadline) {
    const result = await readRemaining();
    if (!result.remainingPids.length && !result.remainingPorts.length) return result;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return readRemaining();
}

async function terminateRecord(record, options = {}) {
  const ownership = options.ownership || reconcileRecord(
    record,
    options.ownerResolver || portOwner,
    options.infoResolver || processInfo,
    options.aliveResolver || pidAlive,
  );
  if (ownership.state === 'CONFLICT') {
    return { stopped: false, reason: 'ownership conflict; no process was terminated', remainingPids: [], remainingPorts: busyPorts(record, options.ownerResolver || portOwner) };
  }
  const pids = terminationTree(record, ownership, options);
  const aliveResolver = options.aliveResolver || pidAlive;
  if (!pids.length && aliveResolver(Number(record?.rootPid || record?.pid))) {
    return { stopped: false, reason: 'verified process tree is unavailable; ownership preserved', remainingPids: [Number(record.rootPid || record.pid)], remainingPorts: busyPorts(record, options.ownerResolver || portOwner) };
  }
  if (!pids.length) {
    const verification = await waitForTermination(record, [], options);
    if (verification.remainingPorts.length) return { stopped: false, reason: 'expected port remained after termination', attemptedPids: [], remainingPids: [], remainingPorts: verification.remainingPorts };
    return { stopped: true, cleaned: true, attemptedPids: [] };
  }

  const platform = options.platform || process.platform;
  const attemptedPids = [];
  if (platform === 'win32') {
    const taskkill = options.taskkill || ((pid) => spawnCommandSync('taskkill.exe', ['/PID', String(pid), '/F'], { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    // Target every verified recorded PID individually. Do not pass /T: a
    // recursive taskkill could terminate an unrecorded child that appeared
    // after the last verified tree snapshot. A newly spawned/unrecorded child
    // must instead remain visible as incomplete cleanup.
    for (const pid of [...pids].sort((a, b) => b - a)) {
      attemptedPids.push(pid);
      try { taskkill(pid); } catch { /* verification below reports survivors */ }
    }
  } else {
    try { process.kill(-Number(record.pid), 'SIGTERM'); } catch { return { stopped: false, reason: 'process termination failed', attemptedPids: [Number(record.pid)] }; }
    attemptedPids.push(Number(record.pid));
  }
  const verification = await waitForTermination(record, pids, options);
  if (verification.remainingPids.length || verification.remainingPorts.length) {
    return {
      stopped: false,
      reason: 'verified process tree or expected port remained after termination',
      attemptedPids,
      remainingPids: verification.remainingPids,
      remainingPorts: verification.remainingPorts,
    };
  }
  return { stopped: true, cleaned: true, attemptedPids, remainingPids: [], remainingPorts: [] };
}

function assertPortsAvailable(definition, existingRecord, ownerResolver = portOwner) {
  for (const port of definition.ports) {
    const owner = ownerResolver(port);
    const ownerInfo = owner ? processInfo(owner) : null;
    const treeEntry = existingRecord && Array.isArray(existingRecord.processTree)
      ? existingRecord.processTree.find((item) => Number(item.pid) === Number(owner)) : null;
    const known = existingRecord && Number(owner) > 0 && (
      (Number(existingRecord.pid) === Number(owner) && commandMatches(existingRecord, ownerInfo)) ||
      (treeEntry && processIdentityMatches(treeEntry, normalizeProcessInfo(owner, ownerInfo || {})) && commandMatches(existingRecord, ownerInfo))
    );
    if (owner && !known) {
      throw new Error(`Cannot start ${definition.service}: port ${port} is owned by PID ${owner}, not a WorksideQA-recorded process.`);
    }
  }
}

async function startProduct(product) {
  const local = parsePowerShellConfig(DEFAULTS.localConfig);
  const initialEnv = mergedEnvironment(local);
  const tools = resolveTools(initialEnv);
  const env = withToolPaths(initialEnv, Object.values(tools));
  const configCheck = await runDoctor({ product, offline: true, skipAuth: true, strict: false, environment: env, localConfig: local });
  if (configCheck.checks.some((check) => check.status === 'failed')) {
    printReport(configCheck);
    throw new Error(`${product} configuration is not ready; no service was started.`);
  }
  const unresolved = Object.values(tools).filter((tool) => !tool.path);
  if (unresolved.length) throw new Error(`Required tool resolution failed: ${unresolved.map((tool) => tool.error || tool.name).join('; ')}`);
  const definitions = serviceDefinitions(product, env, tools);
  const state = loadState();
  state.products[product] = state.products[product] || { services: [] };
  const records = state.products[product].services || [];
  // Reconcile every recorded service before starting any dependency. This
  // makes reboot-stale metadata and genuine port conflicts fail fast instead
  // of waiting for an earlier service to become ready first.
  for (const definition of definitions) {
    const previous = records.find((record) => record.service === definition.service);
    const ownership = reconcileRecord(previous);
    if (ownership.state === 'STALE') {
      const staleIndex = records.findIndex((item) => item.service === definition.service);
      if (staleIndex >= 0) records.splice(staleIndex, 1);
      process.stdout.write(`STALE STATE ${product}/${definition.service}: expected ports are free; reconciled persisted ownership\n`);
      continue;
    }
    if (ownership.state === 'CONFLICT') {
      const owner = ownership.portOwners.find((item) => item.pid && (!ownership.mismatch || Number(item.pid) === Number(ownership.mismatch?.pid)));
      throw new Error(`Cannot start ${product}/${definition.service}: port ${owner?.port || definition.ports[0]} is owned by PID ${owner?.pid || 'unknown'} with an identity mismatch; manual review required.`);
    }
    assertPortsAvailable(definition, ownership.owned ? previous : null);
  }
  saveState(state);
  const started = [];
  let fixturesReady = false;
  let metroPrewarmResult = null;
  let metroProcessReadyAt = null;
  const ensureMetroPrewarmed = async () => {
    // waitForServiceReady invokes probes only after the service ports are
    // reachable; record that boundary separately from bundle completion.
    if (!metroProcessReadyAt) metroProcessReadyAt = new Date().toISOString();
    if (metroPrewarmResult) return metroPrewarmResult.ok
      ? { ready: true, bundlePrewarm: metroPrewarmResult }
      : { ready: false, fatal: true, reason: metroPrewarmResult.reason, detail: metroPrewarmResult.error, bundlePrewarm: metroPrewarmResult };
    if (!metroServedRuntimeReady(env)) return { ready: false };
    metroPrewarmResult = await prewarmCanonicalMetro(env, 'android');
    return metroPrewarmResult.ok
      ? { ready: true, bundlePrewarm: metroPrewarmResult }
      : { ready: false, fatal: true, reason: metroPrewarmResult.reason, detail: metroPrewarmResult.error, bundlePrewarm: metroPrewarmResult };
  };
  const awaitMetroPrewarm = async () => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = await ensureMetroPrewarmed();
      if (result.ready || result.fatal) return result;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return { ready: false, fatal: true, reason: 'METRO_BUNDLE_PREWARM_TIMEOUT', detail: `Metro bundle prewarm exceeded ${READY_TIMEOUT_MS}ms.` };
  };
  for (const definition of definitions) {
    if (definition.service === 'metro' && !fixturesReady) {
      await bootstrapFixtures(product, env, state);
      fixturesReady = true;
    }
    let previous = records.find((record) => record.service === definition.service);
    const ownership = reconcileRecord(previous);
    if (ownership.state === 'STALE') {
      const staleIndex = records.findIndex((item) => item.service === definition.service);
      if (staleIndex >= 0) records.splice(staleIndex, 1);
      previous = null;
      saveState(state);
      process.stdout.write(`STALE STATE ${product}/${definition.service}: expected ports are free; reconciled persisted ownership\n`);
    }
    if (ownership.state === 'CONFLICT') {
      const owner = ownership.portOwners.find((item) => item.pid && (!ownership.mismatch || Number(item.pid) === Number(ownership.mismatch?.pid)));
      throw new Error(`Cannot start ${product}/${definition.service}: port ${owner?.port || definition.ports[0]} is owned by PID ${owner?.pid || 'unknown'} with an identity mismatch; manual review required.`);
    }
    if (previous && ownership.owned && (await waitForPorts(definition.ports, 1000))) {
      if (definition.service === 'metro') {
        const prewarm = await awaitMetroPrewarm();
        if (!prewarm.ready) throw new Error(`Cannot use ${product}/metro: ${prewarm.reason || 'Metro bundle prewarm failed'}. ${prewarm.detail || ''}`.trim());
        previous.bundlePrewarm = prewarm.bundlePrewarm;
        previous.metroProcessReadyAt = previous.metroProcessReadyAt || metroProcessReadyAt || new Date().toISOString();
        saveState(state);
        process.stdout.write(`PREWARMED ${product}/metro bundle (${prewarm.bundlePrewarm.bundlePrewarmElapsedMs}ms)\n`);
      }
      if (ownership.recovered) saveState(state);
      process.stdout.write(`READY ${product}/${definition.service} PID=${previous.pid} (already owned)\n`);
      continue;
    }
    if (previous && (pidAlive(previous.rootPid || previous.pid) || ownership.owned)) {
      const previousStop = await terminateRecord(previous, { ownership });
      if (!previousStop.stopped) {
        const remaining = previousStop.remainingPids?.length ? ` remaining PIDs=${previousStop.remainingPids.join(',')}` : '';
        const ports = previousStop.remainingPorts?.length ? ` remaining ports=${previousStop.remainingPorts.map((item) => item.port).join(',')}` : '';
        throw new Error(`Cannot replace ${product}/${definition.service}: verified cleanup incomplete (${previousStop.reason || 'unknown'}).${remaining}${ports}`);
      }
    }
    assertPortsAvailable(definition, ownership.owned ? previous : null);
    const service = spawnService(definition, product);
    const record = service.record;
    const existingIndex = records.findIndex((item) => item.service === definition.service);
    if (existingIndex >= 0) records[existingIndex] = record;
    else records.push(record);
    saveState(state);
    process.stdout.write(`Starting ${product}/${definition.service} (PID ${record.pid})\n`);
    const readiness = await waitForServiceReady(
      service,
      READY_TIMEOUT_MS,
      definition.service === 'metro' ? ensureMetroPrewarmed : null,
    );
    if (!readiness.ready) {
      reportServiceFailure(record, readiness);
      const cleanup = await terminateRecord(record);
      if (cleanup.stopped) state.products[product].services = records.filter((item) => item.pid !== record.pid);
      else process.stderr.write(`Cleanup incomplete for ${product}/${definition.service}; ownership record retained.\n`);
      saveState(state);
      throw new Error(`${product}/${definition.service} failed before readiness.`);
    }
    record.processTree = processTreeMetadata(record.pid);
    record.processTreePids = record.processTree.map((item) => item.pid);
    record.processStartTimes = Object.fromEntries(record.processTree.map((item) => [String(item.pid), item.startedAt]));
    if (definition.service === 'metro') record.metroProcessReadyAt = metroProcessReadyAt || new Date().toISOString();
    if (definition.service === 'metro' && metroPrewarmResult?.ok) {
      record.bundlePrewarm = metroPrewarmResult;
      process.stdout.write(`PREWARMED ${product}/metro bundle (${metroPrewarmResult.bundlePrewarmElapsedMs}ms)\n`);
    }
    saveState(state);
    started.push(record);
    process.stdout.write(`Ready ${product}/${definition.service} (PID ${record.pid})\n`);
  }

  if (!fixturesReady) {
    await bootstrapFixtures(product, env, state);
    fixturesReady = true;
  }

  // Android is a dependency of the Windows launcher, not a manually managed
  // prerequisite. The helper reuses a healthy configured device or starts
  // exactly the configured AVD, then waits for both ADB and boot completion.
  // It is a no-op on macOS/Linux so iOS and other platform flows retain their
  // existing startup behavior.
  const android = await ensureAndroidEmulator({ product, env, adbPath: tools.adb.path });
  if (product === 'merxus' && !android.skipped) {
    const device = String(env.MERXUS_ANDROID_EMULATOR_ID || '').trim();
    const adb = tools.adb.path;
    const reverse = spawnCommandSync(adb, ['-s', device, 'reverse', 'tcp:8081', 'tcp:8081'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    if (reverse.error || reverse.status !== 0) throw new Error(`ADB reverse setup failed for ${device}.`);
    process.stdout.write(`Ready merxus/android-reverse tcp:8081 -> tcp:8081 (${device})\n`);
  }
  const finalCheck = await runDoctor({ product, strict: true, environment: env, localConfig: local });
  if (finalCheck.status === 'FAIL') {
    const failedCleanup = [];
    for (const record of started) {
      const cleanup = await terminateRecord(record);
      if (!cleanup.stopped) failedCleanup.push({ record, cleanup });
    }
    state.products[product].services = records.filter((record) => !started.some((item) => item.pid === record.pid) || failedCleanup.some((item) => item.record.pid === record.pid));
    for (const item of failedCleanup) process.stderr.write(`Cleanup incomplete for ${product}/${item.record.service}; ownership record retained.\n`);
    saveState(state);
    printReport(finalCheck);
    throw new Error(`${product} doctor failed after startup; newly started services were stopped.`);
  }
  state.products[product].services = records;
  state.products[product].lastReadyAt = new Date().toISOString();
  saveState(state);
  process.stdout.write(`READY ${product}\n`);
  return finalCheck;
}

function statusRows(product, env) {
  const state = loadState();
  const maestroState = maestroActivity();
  const products = product ? [product] : ['merxus', 'sageset'];
  const rows = [];
  for (const key of products) {
    for (const definition of serviceDefinitions(key, env)) {
      const record = state.products[key]?.services?.find((item) => item.service === definition.service) || null;
      const ownership = reconcileRecord(record);
      if (record && ownership.state === 'STALE') {
        state.products[key].services = state.products[key].services.filter((item) => item !== record);
        saveState(state);
      }
      const owners = ownership.portOwners.length ? ownership.portOwners : definition.ports.map((port) => ({ port, pid: portOwner(port) }));
      const running = ownership.owned && owners.every((item) => !item.pid || processBelongsTo(record, item.pid) || (record?.processTreePids || []).map(Number).includes(Number(item.pid)));
      if (record && ownership.recovered) saveState(state);
      rows.push({ product: key, service: definition.service, role: definition.role, running, state: ownership.state, reason: ownership.reason || null, pid: record?.pid || null, startTime: record?.startedAt || null, expectedPorts: definition.ports, actualPortOwners: owners, runtimeMode: key === 'merxus' ? 'maestro' : 'emulator', maestroState, owner: ownership.state === 'CONFLICT' ? 'conflict' : ownership.state === 'STALE' ? 'stale' : ownership.owned ? 'WorksideQA' : record ? 'unknown' : 'none' });
    }
  }
  for (const deviceProduct of (product ? [product] : ['merxus', 'sageset'])) {
    const device = deviceProduct === 'sageset' ? env.SAGESET_ANDROID_EMULATOR_ID : env.MERXUS_ANDROID_EMULATOR_ID;
    if (!device) continue;
    const adb = resolveCommand('adb', env) || (process.platform === 'win32' ? 'adb.exe' : 'adb');
    const deviceState = device ? spawnCommandSync(adb, ['-s', device, 'get-state'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) : null;
    const appId = deviceProduct === 'sageset' ? (env.SAGESET_MAESTRO_ANDROID_APP_ID || 'com.workside.sageset') : (env.MERXUS_MAESTRO_ANDROID_APP_ID || 'com.merxus.mobile.qa');
    const installed = device && deviceState?.status === 0 ? spawnCommandSync(adb, ['-s', device, 'shell', 'pm', 'path', appId], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) : null;
    rows.push({ product: deviceProduct, service: 'android-device', role: 'qa-device', running: deviceState?.status === 0 && String(deviceState.stdout).trim() === 'device', pid: null, startTime: null, expectedPorts: [], actualPortOwners: [], runtimeMode: deviceProduct === 'merxus' ? 'maestro' : 'emulator', maestroState, emulatorState: String(deviceState?.stdout || '').trim() || 'offline', appId, appInstalled: installed?.status === 0 && String(installed.stdout).includes('package:'), owner: 'WorksideQA' });
  }
  return rows;
}

function printStatus(rows) {
  for (const row of rows) {
    const state = row.state === 'CONFLICT' ? 'CONFLICT' : row.state === 'STALE' ? 'STALE STATE' : row.state === 'RECOVERED' ? 'RECOVERED' : row.running ? 'RUNNING' : 'NOT RUNNING';
    const ports = row.expectedPorts.length ? row.expectedPorts.join(',') : '-';
    const owners = row.actualPortOwners.length ? row.actualPortOwners.map((item) => `${item.port}:${item.pid || '-'}`).join(',') : '-';
    process.stdout.write(`${state.padEnd(12)} ${row.product.padEnd(8)} ${row.service.padEnd(16)} PID=${row.pid || '-'} start=${row.startTime || '-'} expected=${ports} owner=${owners} mode=${row.runtimeMode} maestro=${row.maestroState || '-'}${row.reason ? ` reason=${row.reason}` : ''}${row.emulatorState ? ` emulator=${row.emulatorState}` : ''}${row.appId ? ` appId=${row.appId}` : ''}${row.appInstalled != null ? ` app=${row.appInstalled ? 'installed' : 'missing'}` : ''}\n`);
  }
  const ready = rows.filter((row) => row.service !== 'android-device').every((row) => row.running) && rows.filter((row) => row.service === 'android-device').every((row) => row.running && row.appInstalled !== false);
  process.stdout.write(`\n${ready ? 'READY' : 'NOT READY'}\n`);
}

async function stopProduct(product, options = {}) {
  const state = options.state || loadState();
  const reconcile = options.reconcile || reconcileRecord;
  const terminate = options.terminate || terminateRecord;
  const persist = options.save || saveState;
  const products = product ? [product] : Object.keys(state.products || {});
  const failures = [];
  for (const key of products) {
    const services = state.products[key]?.services || [];
    const remainingRecords = [];
    for (const record of services) {
      const ownership = reconcile(record);
      if (ownership.state === 'STALE') {
        process.stdout.write(`STALE STATE ${key}/${record.service}: expected ports are free; reconciled persisted ownership\n`);
        continue;
      }
      if (ownership.state === 'CONFLICT') {
        failures.push({ key, record, outcome: { stopped: false, reason: ownership.reason, remainingPorts: ownership.portOwners.filter((item) => item.pid) } });
        remainingRecords.push(record);
        process.stderr.write(`CONFLICT ${key}/${record.service} PID=${record.pid} (${ownership.reason})\n`);
        continue;
      }
      const outcome = await terminate(record, { ownership });
      if (outcome.stopped) {
        process.stdout.write(`Stopped ${key}/${record.service} PID=${record.pid} state=${ownership.state}\n`);
      } else {
        failures.push({ key, record, outcome });
        remainingRecords.push(record);
        const pids = outcome.remainingPids?.length ? ` remaining PIDs=${outcome.remainingPids.join(',')}` : '';
        const ports = outcome.remainingPorts?.length ? ` remaining ports=${outcome.remainingPorts.map((item) => `${item.port}${item.pid ? ` (PID ${item.pid})` : ''}`).join(',')}` : '';
        process.stderr.write(`FAILED ${key}/${record.service} PID=${record.pid}: ${outcome.reason || 'cleanup incomplete'}${pids}${ports}\n`);
      }
    }
    if (state.products[key]) state.products[key].services = remainingRecords;
  }
  persist(state);
  if (failures.length) {
    throw new Error(`qa:stop incomplete; ${failures.length} WorksideQA-owned service tree(s) remain recorded.`);
  }
  return { stopped: true };
}

async function restartProductService(product, service) {
  if (!service) throw new Error('--service is required for restart.');
  const state = loadState();
  const record = state.products[product]?.services?.find((item) => item.service === service);
  if (record) {
    const ownership = reconcileRecord(record);
    if (ownership.state === 'STALE' || ownership.state === 'NOT RUNNING') {
      state.products[product].services = state.products[product].services.filter((item) => item !== record);
      saveState(state);
      process.stdout.write(`Reconciled stale ${product}/${service} ownership before restart.\n`);
    } else if (ownership.state === 'CONFLICT') {
      const owner = ownership.portOwners.find((item) => item.pid);
      throw new Error(`Refusing to restart ${product}/${service}: port ${owner?.port || service} is CONFLICT (PID ${owner?.pid || 'unknown'} identity mismatch).`);
    } else {
      const outcome = await terminateRecord(record, { ownership });
      if (!outcome.stopped) throw new Error(`Refusing to restart ${product}/${service}: verified process tree could not be stopped (${outcome.reason || 'unknown termination failure'}). No unverified process was touched.`);
      state.products[product].services = state.products[product].services.filter((item) => item !== record);
      saveState(state);
    }
  }
  const final = await startProduct(product);
  return final;
}

function printReport(report) {
  process.stdout.write(`Doctor: ${report.status} (${report.counts.passed} passed, ${report.counts.failed} failed, ${report.counts.warnings} warning(s))\n`);
  for (const check of report.checks.filter((check) => check.status !== 'passed')) process.stdout.write(`${check.status.toUpperCase()} ${check.id}: ${check.message}\n`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(helpText()); return; }
  if (options.action === 'start') {
    if (!options.product) throw new Error('qa:start requires --product merxus or --product sageset.');
    await startProduct(options.product);
    return;
  }
  if (options.action === 'stop') { await stopProduct(options.product); return; }
  if (options.action === 'restart') {
    if (!options.product) throw new Error('qa:restart requires --product.');
    await restartProductService(options.product, options.service);
    return;
  }
  const env = mergedEnvironment(parsePowerShellConfig(DEFAULTS.localConfig));
  const rows = statusRows(options.product, env);
  if (options.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  else printStatus(rows);
  if (rows.some((row) => row.service === 'android-device' ? !row.running : !row.running)) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

module.exports = {
  STATE_PATH,
  parseArgs,
  canonicalMerxusMetroEnvironment,
  loadState,
  saveState,
  serviceDefinitions,
  processInfo,
  processTreePids,
  processTreeMetadata,
  processIdentityMatches,
  reconcileRecord,
  commandMatches,
  processBelongsTo,
  maestroActivity,
  waitForServiceReady,
  prewarmCanonicalMetro,
  assertPortsAvailable,
  fixtureCommands,
  spawnService,
  portOwner,
  statusRows,
  startProduct,
  stopProduct,
  terminateRecord,
  verifiedProcessTreePids,
  ensureAndroidEmulator,
};
