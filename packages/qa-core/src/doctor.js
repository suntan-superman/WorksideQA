#!/usr/bin/env node

/**
 * Reboot-safe, read-only readiness check for the local Maestro lab.
 *
 * The doctor deliberately does not start, stop, reset, or repair anything. It
 * loads the ignored local configuration, validates the checked-in manifests,
 * and proves that the services/devices a flow would use are reachable before
 * a test is launched.
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnCommandSync } = require('../../qa-utils/src');
const { fromRoot, fileExists } = require('../../qa-utils/src');
const { loadProductManifest, validateManifest } = require('../../qa-config/src');
const { resolveTool, resolveTools, toolVersion, canonicalizeToolEnvironment } = require('./tool-resolver');
const { DEFAULT_LOCAL_CONFIG_PATH, parsePowerShellConfig } = require('./local-config');
const { waitForRenderedRuntime, DEFAULT_TIMEOUT_MS } = require('./rendered-runtime');
const { configuredDevice } = require('./android-emulator');
const { validateSageSetMetroManifest } = require('./product-runtime');

const WORKSIDEQA_ROOT = fromRoot();
const DEFAULTS = {
  merxusRoot: path.resolve(WORKSIDEQA_ROOT, '..', 'Merxus'),
  sagesetRoot: path.resolve(WORKSIDEQA_ROOT, '..', 'SageSet'),
  localConfig: DEFAULT_LOCAL_CONFIG_PATH,
};

function parseArgs(argv) {
  const options = { json: false, offline: false, skipAuth: false, strict: false, product: 'all' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--offline' || arg === '--skip-network') options.offline = true;
    else if (arg === '--skip-auth') options.skipAuth = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--product') {
      const value = argv[++i];
      if (!['all', 'merxus', 'sageset'].includes(value)) throw new Error('--product must be merxus, sageset, or all.');
      options.product = value;
    }
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function helpText() {
  return `WorksideQA Maestro automation doctor

Usage:
  npm run qa:doctor
  npm run qa:doctor -- --offline
  npm run qa:doctor -- --json

Options:
  --offline       Skip network, service, and device probes; validate local contracts only.
  --skip-auth     Skip the Auth-emulator command (identity probes still run when online).
  --strict        Treat optional SageSet/iOS checks as failures when configured.
  --product       Check one product (merxus, sageset) or all products (default).
  --json          Emit a machine-readable report instead of the human summary.
`;
}

function result(status, id, message, detail = {}) {
  return { status, id, message, ...detail };
}

function mergedEnvironment(localConfig) {
  const env = { ...process.env, ...localConfig };
  // Repository locations are machine-local.  The checked-in Windows layout is
  // only a fallback; macOS runners may keep Mobile, backend, and Firebase in
  // separate checkouts (for example a standalone merxusmobile repository).
  env.MERXUS_ROOT_REPO = env.MERXUS_ROOT_REPO || DEFAULTS.merxusRoot;
  env.MERXUS_MOBILE_REPO = env.MERXUS_MOBILE_REPO || path.join(DEFAULTS.merxusRoot, 'mobile');
  env.MERXUS_BACKEND_REPO = env.MERXUS_BACKEND_REPO || path.join(DEFAULTS.merxusRoot, 'merxus-ai-backend');
  env.MERXUS_WEB_REPO = env.MERXUS_WEB_REPO || path.join(DEFAULTS.merxusRoot, 'web');
  env.SAGESET_MOBILE_REPO = env.SAGESET_MOBILE_REPO || path.join(DEFAULTS.sagesetRoot, 'mobile');
  env.MERXUS_MOBILE_ENVIRONMENT = env.MERXUS_MOBILE_ENVIRONMENT || 'maestro';
  env.MERXUS_QA_ENVIRONMENT = env.MERXUS_QA_ENVIRONMENT || 'maestro';
  env.EXPO_PUBLIC_ENVIRONMENT = env.EXPO_PUBLIC_ENVIRONMENT || 'maestro';
  env.MERXUS_MAESTRO_FIREBASE_PROJECT_ID = env.MERXUS_MAESTRO_FIREBASE_PROJECT_ID || 'merxus-maestro-local';
  env.MERXUS_QA_BACKEND_URL = env.MERXUS_QA_BACKEND_URL || 'http://127.0.0.1:8787';
  env.FIREBASE_AUTH_EMULATOR_HOST = env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
  env.FIRESTORE_EMULATOR_HOST = env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  env.FIREBASE_STORAGE_EMULATOR_HOST = env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';
  env.MERXUS_ALLOW_EXTERNAL_PROVIDERS = env.MERXUS_ALLOW_EXTERNAL_PROVIDERS || 'false';
  env.SAGESET_MAESTRO_ENVIRONMENT = env.SAGESET_MAESTRO_ENVIRONMENT || 'emulator';
  env.SAGESET_MAESTRO_FIREBASE_PROJECT_ID = env.SAGESET_MAESTRO_FIREBASE_PROJECT_ID || 'sageset-maestro-local';
  env.SAGESET_MAESTRO_ALLOW_EXTERNAL_NOTIFICATIONS = env.SAGESET_MAESTRO_ALLOW_EXTERNAL_NOTIFICATIONS || 'false';
  // Resolve machine-local tool templates once, before this environment is
  // passed to qa:start or any nested Doctor process. This prevents a CMD /
  // PowerShell placeholder from becoming a root-relative path such as
  // `\\nodejs\\firebase.cmd` in a child process.
  return canonicalizeToolEnvironment(env);
}

function commandVersion(command, env) {
  const outcome = spawnCommandSync(command, ['--version'], {
    env, encoding: 'utf8', timeout: 10000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = String(outcome.stdout || outcome.stderr || '').trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return [...lines].reverse().find((line) => /\d+\.\d+\.\d+/.test(line)) || lines[0] || null;
}

function resolveCommand(command, env) {
  const normalized = String(command || '').replace(/\.(cmd|bat|exe)$/i, '').toLowerCase();
  return resolveTool(normalized, env).path;
}

async function probeUrl(url, options = {}) {
  const timeoutMs = options.timeoutMs || 3000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: options.method || 'GET', headers: options.headers, body: options.body, signal: controller.signal });
    return { status: response.status, body: await response.text().catch(() => '') };
  } catch (error) {
    return { error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

function probePort(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function safeCredentialStatus(env, key) {
  return !String(env[key] || '').trim() ? 'missing' : 'set';
}

function checkLocalContract(env, localConfig, product = 'all', options = {}) {
  const platform = options.platform || process.platform;
  const checks = [];
  if (product === 'sageset') {
    const required = [
      ['SAGESET_MOBILE_REPO', 'SageSet Mobile path'],
      ['SAGESET_MAESTRO_USER_A_EMAIL', 'SageSet User A email'],
      ['SAGESET_MAESTRO_USER_A_PASSWORD', 'SageSet User A password'],
      ['SAGESET_MAESTRO_USER_B_EMAIL', 'SageSet User B email'],
      ['SAGESET_MAESTRO_USER_B_PASSWORD', 'SageSet User B password'],
      ['SAGESET_MAESTRO_QA_EMAIL_ALLOWLIST', 'SageSet QA email allowlist'],
      ['SAGESET_ANDROID_EMULATOR_ID', 'SageSet Android emulator ID'],
      ['SAGESET_MAESTRO_ANDROID_APP_ID', 'SageSet Maestro Android application ID'],
    ];
    for (const [key, label] of required) {
      checks.push(String(env[key] || '').trim()
        ? result('passed', `config.${key}`, `${label} is configured.`, { value: key.includes('PASSWORD') ? 'set' : env[key] })
        : result('failed', `config.${key}`, `${label} is missing from .maestro.local.ps1.`));
    }
    checks.push(env.SAGESET_MAESTRO_ENVIRONMENT === 'emulator'
      ? result('passed', 'config.sageset-environment', 'SageSet emulator environment is canonical.')
      : result('failed', 'config.sageset-environment', 'SAGESET_MAESTRO_ENVIRONMENT must be emulator.'));
    checks.push(env.SAGESET_MAESTRO_FIREBASE_PROJECT_ID === 'sageset-maestro-local'
      ? result('passed', 'config.sageset-firebase-project', 'SageSet Maestro Firebase project is canonical.')
      : result('failed', 'config.sageset-firebase-project', 'SAGESET_MAESTRO_FIREBASE_PROJECT_ID must be sageset-maestro-local.'));
    checks.push(String(env.SAGESET_MAESTRO_ALLOW_EXTERNAL_NOTIFICATIONS || 'false').toLowerCase() !== 'true'
      ? result('passed', 'config.sageset-external-notifications', 'SageSet external notifications are disabled.')
      : result('failed', 'config.sageset-external-notifications', 'SageSet external notifications must be disabled.'));
    return checks;
  }
  checks.push(fs.existsSync(DEFAULTS.localConfig)
    ? result('passed', 'config.local', 'Loaded ignored .maestro.local.ps1.')
    : result('failed', 'config.local', `Missing ${DEFAULTS.localConfig}. Copy maestro.local.ps1.example and fill canonical QA values.`));

  const required = [
    ['MERXUS_MAESTRO_OWNER_A_EMAIL', 'Merxus Owner A email'],
    ['MERXUS_MAESTRO_OWNER_A_PASSWORD', 'Merxus Owner A password'],
    ['MERXUS_MAESTRO_OWNER_B_EMAIL', 'Merxus Owner B email'],
    ['MERXUS_MAESTRO_OWNER_B_PASSWORD', 'Merxus Owner B password'],
    ...(platform === 'darwin'
      ? [['MERXUS_IOS_SIMULATOR_ID', 'iOS simulator ID']]
      : [['MERXUS_ANDROID_EMULATOR_ID', 'Android emulator ID']]),
  ];
  for (const [key, label] of required) {
    checks.push(String(env[key] || '').trim()
      ? result('passed', `config.${key}`, `${label} is configured.`, { value: key.includes('PASSWORD') ? 'set' : env[key] })
      : result('failed', `config.${key}`, `${label} is missing from .maestro.local.ps1.`));
  }
  const distinct = String(env.MERXUS_MAESTRO_OWNER_A_EMAIL || '').trim().toLowerCase() !== String(env.MERXUS_MAESTRO_OWNER_B_EMAIL || '').trim().toLowerCase();
  checks.push(distinct
    ? result('passed', 'config.distinct-identities', 'Merxus Owner A/B identities are distinct.')
    : result('failed', 'config.distinct-identities', 'Merxus Owner A/B emails must be distinct.'));
  checks.push(env.MERXUS_MAESTRO_FIREBASE_PROJECT_ID === 'merxus-maestro-local'
    ? result('passed', 'config.firebase-project', 'Merxus Maestro Firebase project is canonical.')
    : result('failed', 'config.firebase-project', 'MERXUS_MAESTRO_FIREBASE_PROJECT_ID must be merxus-maestro-local.'));
  checks.push(env.MERXUS_ALLOW_EXTERNAL_PROVIDERS === 'false'
    ? result('passed', 'config.external-providers', 'Merxus external providers are disabled.')
    : result('failed', 'config.external-providers', 'MERXUS_ALLOW_EXTERNAL_PROVIDERS must be false for Maestro.'));
  if (product === 'all') {
    checks.push(safeCredentialStatus(env, 'SAGESET_MAESTRO_USER_A_EMAIL') === 'set'
      ? result('passed', 'config.sageset-identity', 'SageSet User A credentials are configured.')
      : result(optionsStrict(localConfig) ? 'failed' : 'warning', 'config.sageset-identity', 'SageSet credentials are not configured; SageSet flows will be blocked.'));
  }
  return checks;
}

function optionsStrict(localConfig) {
  return Boolean(localConfig.__doctorStrict);
}

function checkPaths(env, product = 'all', options = {}) {
  const platform = options.platform || process.platform;
  const root = env.MERXUS_ROOT_REPO || DEFAULTS.merxusRoot;
  const mobile = env.MERXUS_MOBILE_REPO || path.join(root, 'mobile');
  const backend = env.MERXUS_BACKEND_REPO || path.join(root, 'merxus-ai-backend');
  const web = env.MERXUS_WEB_REPO || path.join(root, 'web');
  const mobileHasFirebase = fs.existsSync(path.join(mobile, 'firebase.json'));
  const paths = [
    ['path.worksideqa', WORKSIDEQA_ROOT],
    ['path.merxus', root],
    ['path.merxus.mobile', mobile],
    ['path.merxus.backend', backend],
    ['path.merxus.web', web],
    ['path.sageset', DEFAULTS.sagesetRoot],
    ['path.sageset.mobile', env.SAGESET_MOBILE_REPO],
  ].filter(([id]) => product === 'all' || (product === 'merxus' ? !id.includes('sageset') : id.includes('sageset')));
  return paths.map(([id, value]) => {
    if (fs.existsSync(value)) return result('passed', id, 'Path exists.', { path: value });
    // A standalone macOS Mobile checkout can carry the Firebase project
    // itself.  In that layout the historical shared Merxus root/web path is
    // not a required checkout; serviceDefinitions will use Mobile's config.
    if (platform === 'darwin' && id === 'path.merxus' && fs.existsSync(mobile)) {
      return result('skipped', id, 'Shared Merxus parent checkout is not required on macOS; Mobile path is authoritative.', { path: value });
    }
    if (platform === 'darwin' && id === 'path.merxus.web' && mobileHasFirebase) {
      return result('skipped', id, 'Merxus web checkout is not required; Mobile contains the local Firebase project.', { path: value });
    }
    return result('failed', id, `Path does not exist: ${value}`, { path: value });
  });
}

function checkManifests(product = 'all') {
  const checks = [];
  for (const key of ['merxus', 'sageset'].filter((key) => product === 'all' || key === product)) {
    try {
      const manifest = validateManifest(loadProductManifest(key));
      checks.push(result('passed', `manifest.${key}`, `${manifest.name} manifest is valid.`));
      if (!manifest.mobile?.enabled) checks.push(result('failed', `manifest.${key}.mobile`, `${key} mobile orchestration must be enabled.`));
      if (manifest.mobile?.orchestrationAuthority !== 'worksideqa') checks.push(result('failed', `manifest.${key}.authority`, `${key} mobile orchestration must be owned by WorksideQA.`));
      const mobileEnvironment = manifest.mobile?.environment;
      if (mobileEnvironment) {
        checks.push(mobileEnvironment.name === 'maestro'
          ? result('passed', `manifest.${key}.environment`, 'Mobile Maestro environment is declared.')
          : result('failed', `manifest.${key}.environment`, 'Mobile manifest must declare environment.name=maestro.'));
        if (mobileEnvironment.externalProvidersAllowed === true || mobileEnvironment.externalNotificationsAllowed === true) {
          checks.push(result('failed', `manifest.${key}.external-providers`, 'External providers/notifications must be disabled for Maestro.'));
        }
        if (!String(mobileEnvironment.firebaseProjectId || '').endsWith('-maestro-local')) {
          checks.push(result('failed', `manifest.${key}.firebase-project`, 'Mobile Maestro Firebase project must be a local emulator project.'));
        }
      }
      if (key === 'sageset') {
        const androidDevice = manifest.mobile?.devices?.androidEmulator;
        checks.push(androidDevice?.required === true
          ? result('passed', 'manifest.sageset.android-device', 'SageSet requires its configured Android QA emulator.')
          : result('failed', 'manifest.sageset.android-device', 'SageSet manifest must require an Android QA emulator.'));
        checks.push(androidDevice?.appId === manifest.mobile?.appId
          ? result('passed', 'manifest.sageset.android-app', 'SageSet Android QA app ID matches the Maestro mobile contract.')
          : result('failed', 'manifest.sageset.android-app', 'SageSet Android QA app ID must match mobile.appId.'));
      }
    } catch (error) {
      checks.push(result('failed', `manifest.${key}`, error.message));
    }
  }
  return checks;
}

function checkTools(env, options = {}) {
  const checks = [];
  // qa:start passes the exact resolver result used to launch services. Reuse
  // it for the final Doctor in that same run so a transient Windows process
  // lookup cannot select a different executable (or reject the already-used
  // Firebase shim) during post-start validation.
  const tools = options.tools || resolveTools(env);
  const versions = {};
  const platform = options.platform || process.platform;
  const names = platform === 'darwin' ? ['node', 'npm', 'firebase', 'maestro', 'java'] : ['node', 'npm', 'firebase', 'adb', 'maestro', 'java'];
  for (const name of names) {
    const resolved = tools[name];
    versions[name] = resolved.path ? toolVersion(resolved.path, env) : null;
    checks.push(resolved.path
      ? result('passed', `tool.${name}`, `${resolved.path} (${versions[name] || name})`, { command: resolved.path, source: resolved.source, version: versions[name] })
      : result('failed', `tool.${name}`, resolved.error || `${name} is unavailable.`));
  }
  if (platform === 'darwin') {
    const xcrun = resolveTool('xcrun', env);
    checks.push(xcrun.path
      ? result('passed', 'tool.xcrun', `${xcrun.path} (Xcode command-line tools)`, { command: xcrun.path, source: xcrun.source })
      : result('failed', 'tool.xcrun', 'xcrun is unavailable; install Xcode command-line tools for iOS simulator QA.'));
  }
  const validateToolchain = options.validateToolchain === true;
  if (platform === 'win32' && (!options.offline || validateToolchain)) {
    const firebaseOverride = String(env.WORKSIDEQA_FIREBASE_BIN || '').trim();
    checks.push(firebaseOverride && tools.firebase?.source === 'local-config'
      ? result('passed', 'tool.firebase-contract', `Firebase resolution is pinned to ${tools.firebase.path}.`, { command: tools.firebase.path, version: versions.firebase })
      : result('failed', 'tool.firebase-contract', 'WORKSIDEQA_FIREBASE_BIN must pin the canonical Windows Firebase executable in .maestro.local.ps1; ambiguous PATH resolution is not allowed.'));
  }
  const firebaseMajor = Number((String(versions.firebase || '').match(/(\d+)\./) || [])[1] || 0);
  const javaMajor = Number((String(versions.java || '').match(/(?:version\s*["']?)?(\d+)(?:\.|["'])/) || [])[1] || 0);
  if ((!options.offline || validateToolchain) && firebaseMajor >= 15) {
    checks.push(javaMajor >= 21
      ? result('passed', 'tool.firebase-java-compat', `Firebase CLI ${versions.firebase || 'unknown'} is paired with Java ${versions.java || 'unknown'}.`, { firebaseVersion: versions.firebase, javaVersion: versions.java })
      : result('failed', 'tool.firebase-java-compat', `Firebase CLI ${versions.firebase || 'unknown'} requires Java 21+; resolved Java is ${versions.java || 'unavailable'}. Set WORKSIDEQA_JAVA_BIN/JAVA_HOME to a JDK 21 installation.`));
  }
  return checks;
}

async function checkServices(env, options) {
  if (options.offline) return [result('skipped', 'services', 'Network/service probes skipped (--offline).')];
  const checks = [];
  if (options.product === 'sageset') {
    for (const [id, label, port] of [['service.sageset-auth', 'SageSet Auth emulator', 9099], ['service.sageset-firestore', 'SageSet Firestore emulator', 8080], ['service.sageset-storage', 'SageSet Storage emulator', 9199], ['service.sageset-functions', 'SageSet Functions emulator', 5001], ['service.sageset-metro', 'SageSet Maestro Metro', 8081]]) {
      checks.push((await probePort('127.0.0.1', port))
        ? result('passed', id, `${label} is listening on 127.0.0.1:${port}.`)
        : result('failed', id, `${label} is not reachable on 127.0.0.1:${port}.`));
    }
    return checks;
  }
  for (const [id, label, host, port] of [
    ['service.firebase-auth', 'Firebase Auth emulator', '127.0.0.1', 9099],
    ['service.firebase-firestore', 'Firestore emulator', '127.0.0.1', 8080],
    ['service.firebase-storage', 'Storage emulator', '127.0.0.1', 9199],
    ['service.backend', 'Merxus QA backend', '127.0.0.1', 8787],
    ['service.metro', 'Merxus Maestro Metro', '127.0.0.1', 8081],
  ]) {
    checks.push((await probePort(host, port))
      ? result('passed', id, `${label} is listening on ${host}:${port}.`)
      : result('failed', id, `${label} is not reachable on ${host}:${port}.`));
  }
  const backendUrl = String(env.MERXUS_QA_BACKEND_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
  for (const [owner, emailKey] of [['Owner A', 'MERXUS_MAESTRO_OWNER_A_EMAIL'], ['Owner B', 'MERXUS_MAESTRO_OWNER_B_EMAIL']]) {
    const email = String(env[emailKey] || '').trim().toLowerCase();
    if (!email) {
      checks.push(result('failed', `backend.identity.${owner.toLowerCase().replace(' ', '-')}`, `${owner} email is missing; cannot verify Mobile check-email.`));
      continue;
    }
    const response = await probeUrl(`${backendUrl}/api/auth/check-email`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }), timeoutMs: 5000,
    });
    let body = {};
    try { body = JSON.parse(response.body || '{}'); } catch { /* safe diagnostic only */ }
    const passed = response.status === 200 && body.exists === true && body.provider === 'email' && body.hasWorkspace === true;
    checks.push(passed
      ? result('passed', `backend.identity.${owner.toLowerCase().replace(' ', '-')}`, `${owner} is visible to the exact Mobile check-email endpoint.`, { httpStatus: response.status, exists: true, provider: body.provider, hasWorkspace: true })
      : result('failed', `backend.identity.${owner.toLowerCase().replace(' ', '-')}`, `${owner} check-email contract failed.`, { httpStatus: response.status || null, exists: body.exists === true, provider: body.provider || null, hasWorkspace: body.hasWorkspace === true }));
  }
  return checks;
}

function runAuthVerify(env, options) {
  if (options.offline || options.skipAuth) return result('skipped', 'auth.verify', 'Auth identity command skipped.');
  if (options.product === 'sageset') {
    const root = path.resolve(env.SAGESET_MOBILE_REPO || path.join(DEFAULTS.sagesetRoot, 'mobile'));
    const npm = resolveCommand('npm', env);
    if (!npm) return result('failed', 'auth.verify.sageset', 'npm is unavailable; cannot verify SageSet fixtures.');
    const outcome = spawnCommandSync(npm, ['--prefix', 'functions', 'run', 'verify:maestro-fixtures'], {
      cwd: root, env, encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return !outcome.error && outcome.status === 0
      ? result('passed', 'auth.verify.sageset', 'SageSet canonical fixture users and documents verified.')
      : result('failed', 'auth.verify.sageset', 'SageSet verify:maestro-fixtures failed.');
  }
  const backendRoot = env.MERXUS_BACKEND_REPO || path.join(DEFAULTS.merxusRoot, 'merxus-ai-backend');
  const npm = resolveCommand('npm', env);
  if (!npm) return result('failed', 'auth.verify', 'npm is unavailable; cannot verify Merxus fixtures.');
  const outcome = spawnCommandSync(npm, ['run', 'qa:maestro:auth:verify'], {
    cwd: backendRoot, env, encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return !outcome.error && outcome.status === 0
    ? result('passed', 'auth.verify', 'Canonical Owner A/B Auth users and tenant documents verified.')
    : result('failed', 'auth.verify', 'qa:maestro:auth:verify failed; run the canonical fixture reset after fixing emulator readiness.');
}

async function checkMobileRuntime(env, options) {
  if (options.product === 'sageset') {
    const checks = [];
    const manifest = validateManifest(loadProductManifest('sageset'));
    const metro = manifest.mobile?.metro;
    const metroUrl = String(metro?.url || 'http://127.0.0.1:8081').replace(/\/$/, '');
    const served = options.offline
      ? { skipped: true }
      : await probeUrl(`${metroUrl}/`, { timeoutMs: 5000, headers: { accept: 'application/expo+json', 'expo-platform': 'android' } });
    let servedManifest = null;
    try { servedManifest = JSON.parse(served.body || '{}'); } catch { /* reported below */ }
    const expoClient = servedManifest?.extra?.expoClient || {};
    let runtimeContract = null;
    let runtimeContractError = null;
    try { runtimeContract = validateSageSetMetroManifest(servedManifest, manifest.mobile.appId); } catch (error) { runtimeContractError = error.message; }
    const appId = runtimeContract?.appId || String(expoClient?.android?.package || '').trim();
    const runtimeProject = runtimeContract?.firebaseProjectId || '';
    const servedOk = options.offline || (served.status === 200 && Boolean(servedManifest?.launchAsset?.url) && !runtimeContractError);
    checks.push(options.offline
      ? result('skipped', 'mobile.runtime-served', 'SageSet Metro served check skipped (--offline).')
      : servedOk
        ? result('passed', 'mobile.runtime-served', `SageSet Maestro Metro is serving on ${metroUrl}.`, { metroUrl, appId: appId || manifest.mobile.appId, firebaseProjectId: runtimeProject || manifest.mobile.environment.firebaseProjectId })
        : result('failed', 'mobile.runtime-served', `SageSet Maestro Metro is absent, stale, or serving an invalid runtime on ${metroUrl}.`, { metroUrl, httpStatus: served.status || null, mismatch: runtimeContractError || null }));
    if (options.offline) {
      checks.push(result('skipped', 'mobile.runtime-rendered', 'SageSet rendered app check skipped (--offline).'));
      return checks;
    }
    if (!servedOk) {
      checks.push(result('failed', 'mobile.runtime-rendered', 'SageSet rendered app check was not attempted because Metro runtime is not ready.'));
      return checks;
    }
    const device = manifest.mobile?.devices?.androidEmulator;
    const deviceId = String(env.SAGESET_ANDROID_EMULATOR_ID || '').trim();
    const adb = resolveCommand('adb', env);
    const maestro = resolveCommand('maestro', env);
    const launchUri = device?.launchUri;
    let rendered;
    try {
      rendered = device && adb && maestro && deviceId && launchUri
        ? await waitForRenderedRuntime({
          adb, maestro, deviceId, appId: device.appId || manifest.mobile.appId,
          launchUri, expectedActivity: 'com.sageset.fitness.MainActivity', metroPort: Number(metro?.port || 8081),
          flowPath: path.join(WORKSIDEQA_ROOT, 'packages', 'qa-core', 'src', 'rendered-runtime-flows', 'sageset-root.yaml'),
          readySelectors: ['screen.auth.login', 'screen.today.ready'], product: 'sageset', env,
          observerRunId: options.observerRunId,
          timeoutMs: Number(env.WORKSIDEQA_RENDERED_RUNTIME_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
          artifactDirectory: path.join(WORKSIDEQA_ROOT, '.worksideqa', 'rendered-runtime', `sageset-${new Date().toISOString().replace(/[:.]/g, '-')}`),
        })
        : { ok: false, reason: 'CONFIGURATION_MISSING', elapsedMs: 0 };
    } catch (error) { rendered = { ok: false, reason: 'PROBE_ERROR', error: error.message, elapsedMs: 0 }; }
    const observerOwner = rendered.observerLock?.owner?.pid ? `; observerOwnerPid=${rendered.observerLock.owner.pid}` : '';
    checks.push(rendered.ok
      ? result('passed', 'mobile.runtime-rendered', `SageSet application rendered ${rendered.readySelector} (PID ${rendered.appPid || 'unknown'}) in ${rendered.elapsedMs}ms.`, rendered)
      : result('failed', 'mobile.runtime-rendered', `SageSet QA APK is not rendered (${rendered.reason || 'unknown'}); launcher screen alone is insufficient.${observerOwner}`, rendered));
    return checks;
  }
  const tool = path.join(WORKSIDEQA_ROOT, 'packages', 'qa-mobile', 'src', 'merxus-mobile-runtime.js');
  const checks = [];
  if (!fs.existsSync(tool)) return [result('failed', 'mobile.runtime-tool', 'Canonical Mobile runtime verifier is missing.')];
  const platform = options.platform || process.platform;
  // On macOS the same Mobile runtime verifier is used with the simulator
  // contract.  This keeps the served check truthful without requiring ADB.
  const config = spawnCommandSync(process.execPath, [tool, '--mobile-root', env.MERXUS_MOBILE_REPO, '--platform', platform === 'darwin' ? 'ios' : 'android', '--config-only'], {
    cwd: WORKSIDEQA_ROOT, env, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let configSummary = null;
  try { configSummary = JSON.parse(String(config.stdout || '').trim().split(/\r?\n/).pop()); } catch { /* failure is reported below */ }
  checks.push(!config.error && config.status === 0
    ? result('passed', 'mobile.runtime-config', 'Merxus Mobile resolves the Maestro runtime contract.', {
      environment: configSummary?.environment || 'maestro',
      isMaestro: configSummary?.isMaestro === true,
      backendUrl: configSummary?.backendUrl || null,
      firebaseProjectId: configSummary?.firebaseProjectId || null,
    })
    : result('failed', 'mobile.runtime-config', 'Merxus Mobile does not resolve a valid Maestro runtime contract.'));
  if (options.offline) checks.push(result('skipped', 'mobile.runtime-served', 'Served Metro check skipped (--offline).'));
  else {
    const served = spawnCommandSync(process.execPath, [tool, '--mobile-root', env.MERXUS_MOBILE_REPO, '--platform', platform === 'darwin' ? 'ios' : 'android', '--served-only'], {
      cwd: WORKSIDEQA_ROOT, env, encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    checks.push(!served.error && served.status === 0
      ? result('passed', 'mobile.runtime-served', `Running Metro serves the validated Maestro ${platform === 'darwin' ? 'iOS' : 'Android'} manifest.`)
      : result('failed', 'mobile.runtime-served', 'Running Metro is absent, stale, or serving a non-Maestro runtime.'));
  }
  if (platform === 'darwin') {
    checks.push(result('skipped', 'mobile.runtime-rendered', 'iOS rendered app check is owned by the Mac Maestro certification path; Android observer is not used.'));
  } else if (options.offline) {
    checks.push(result('skipped', 'mobile.runtime-rendered', 'Rendered app check skipped (--offline).'));
  } else if (checks.some((check) => check.id === 'mobile.runtime-served' && check.status === 'failed')) {
    checks.push(result('failed', 'mobile.runtime-rendered', 'Rendered app check was not attempted because served Metro is not ready.'));
  } else {
    let rendered;
    try {
      const manifest = validateManifest(loadProductManifest('merxus'));
      const device = manifest.mobile?.devices?.androidEmulator;
      const deviceId = String(env.MERXUS_ANDROID_EMULATOR_ID || '').trim();
      const adb = resolveCommand('adb', env);
      const maestro = resolveCommand('maestro', env);
      rendered = device && adb && maestro && deviceId
        ? await waitForRenderedRuntime({
          adb, maestro, deviceId, appId: device.appId || manifest.mobile.appId,
          launchUri: device.launchUri,
          observerRunId: options.observerRunId,
          env,
          timeoutMs: Number(env.WORKSIDEQA_RENDERED_RUNTIME_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
          artifactDirectory: path.join(WORKSIDEQA_ROOT, '.worksideqa', 'rendered-runtime', new Date().toISOString().replace(/[:.]/g, '-')),
        })
        : { ok: false, reason: 'CONFIGURATION_MISSING', elapsedMs: 0 };
    } catch (error) {
      rendered = { ok: false, reason: 'PROBE_ERROR', error: error.message, elapsedMs: 0 };
    }
    const launchDetail = rendered.launchDiagnostics?.launch?.launch || rendered.launchDiagnostics?.launch || rendered.launchDiagnostics;
    const launchSummary = launchDetail && (launchDetail.command || launchDetail.exitCode !== undefined)
      ? `; launchCommand=${launchDetail.displayCommand || launchDetail.command || 'unknown'}; launchExit=${launchDetail.exitCode ?? 'unknown'}${launchDetail.stdout ? `; launchStdout=${String(launchDetail.stdout).slice(-240)}` : ''}${launchDetail.stderr ? `; launchStderr=${String(launchDetail.stderr).slice(-240)}` : ''}`
      : '';
    const foregroundSummary = String(rendered.foregroundActivity || '')
      .split(/\r?\n/)
      .find((line) => /(?:m?ResumedActivity|topResumedActivity|mFocusedApp|topDisplayFocusedRootTask)/i.test(line))
      || 'unknown';
    const observerOwner = rendered.observerLock?.owner?.pid ? `; observerOwnerPid=${rendered.observerLock.owner.pid}` : '';
    checks.push(rendered.ok
      ? result('passed', 'mobile.runtime-rendered', `QA app rendered ${rendered.readySelector} (PID ${rendered.appPid || 'unknown'}) in ${rendered.elapsedMs}ms; launch=${rendered.launchStartedAt}, qaRoot=${rendered.qaRootReadyAt}, appReady=${rendered.appReadyAt}.`, rendered)
      : result('failed', 'mobile.runtime-rendered', `QA app did not reach rendered readiness (${rendered.reason || 'unknown'}); qaRootSeen=${rendered.qaRootSeen ?? 'unknown'}; lastKnownSelector=${rendered.lastKnownSelector || 'unknown'}; foregroundActivity=${foregroundSummary}; appPid=${rendered.appPid || 'unknown'}; intermediate=${rendered.intermediateStateKind || 'unknown'}; elapsed=${rendered.elapsedMs}ms${launchSummary}${rendered.diagnosticArtifacts?.hierarchyPath ? `; hierarchy=${rendered.diagnosticArtifacts.hierarchyPath}` : ''}${observerOwner}.`, rendered));
  }
  return checks;
}

async function checkDevices(env, options) {
  if (options.offline) return [result('skipped', 'device.android', 'Device probes skipped (--offline).')];
  const platform = options.platform || process.platform;
  if (platform === 'darwin') {
    const simulatorId = String(env.MERXUS_IOS_SIMULATOR_ID || '').trim();
    if (!simulatorId) return [result('failed', 'device.ios', 'Configured iOS simulator identity is missing.')];
    const xcrun = resolveTool('xcrun', env).path;
    if (!xcrun) return [result('failed', 'device.ios', 'xcrun is unavailable; cannot validate the configured iOS simulator.')];
    const execute = options.execute || spawnCommandSync;
    const outcome = execute(xcrun, ['simctl', 'list', 'devices', 'available'], { env, encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const listed = !outcome.error && outcome.status === 0 && String(outcome.stdout || '').includes(simulatorId);
    return [listed
      ? result('passed', 'device.ios', `Configured iOS simulator ${simulatorId} is available.`)
      : result('failed', 'device.ios', `Configured iOS simulator ${simulatorId} is not available.`)];
  }
  const checks = [];
  const execute = options.execute || spawnCommandSync;
  const adb = options.adb || resolveCommand('adb', env);
  if (!adb) return [result('failed', 'device.android', 'ADB is unavailable; cannot validate the configured emulator.')];
  const contract = configuredDevice(options.product, env);
  const id = String(contract?.serial || '').trim();
  if (!id) {
    const label = options.product === 'sageset' ? 'SageSet' : 'Merxus';
    const status = options.product === 'sageset' ? 'failed' : 'skipped';
    return [result(status, 'device.android', `${label} Android emulator identity is not configured; mobile readiness cannot be certified.`)];
  }
  const state = execute(adb, ['-s', id, 'get-state'], { env, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const label = options.product === 'sageset' ? 'SageSet' : 'Merxus';
  checks.push(!state.error && state.status === 0 && String(state.stdout).trim() === 'device'
    ? result('passed', 'device.android', `Configured ${label} Android emulator ${id} is online.`)
    : result('failed', 'device.android', `Configured ${label} Android emulator ${id} is not online.`));
  if (!id) return checks;
  const appId = options.product === 'sageset' ? (env.SAGESET_MAESTRO_ANDROID_APP_ID || 'com.workside.sageset') : (env.MERXUS_MAESTRO_ANDROID_APP_ID || 'com.merxus.mobile.qa');
  const app = execute(adb, ['-s', id, 'shell', 'pm', 'path', appId], { env, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  checks.push(!app.error && app.status === 0 && String(app.stdout).includes('package:')
    ? result('passed', 'device.android.app', `${label} QA application is installed.`)
    : result('failed', 'device.android.app', `${label} QA application is not installed on the configured emulator.`));
  return checks;
}

async function runDoctor(options = {}) {
  const localConfig = options.localConfig || parsePowerShellConfig(DEFAULTS.localConfig);
  if (options.strict) localConfig.__doctorStrict = true;
  const env = options.environment || mergedEnvironment(localConfig);
  const checks = [
    ...checkLocalContract(env, localConfig, options.product, options),
    ...checkPaths(env, options.product, options),
    ...checkManifests(options.product),
    ...checkTools(env, options),
  ];
  checks.push(...await checkMobileRuntime(env, options));
  checks.push(...await checkServices(env, options));
  checks.push(runAuthVerify(env, options));
  checks.push(...await checkDevices(env, options));
  const failed = checks.filter((check) => check.status === 'failed');
  const warnings = checks.filter((check) => check.status === 'warning');
  return {
    generatedAt: new Date().toISOString(),
    status: failed.length ? 'FAIL' : warnings.length ? 'WARN' : 'PASS',
    checks,
    counts: {
      passed: checks.filter((check) => check.status === 'passed').length,
      failed: failed.length,
      warnings: warnings.length,
      skipped: checks.filter((check) => check.status === 'skipped').length,
    },
  };
}

function printReport(report) {
  process.stdout.write(`WorksideQA Maestro doctor: ${report.status}\n`);
  process.stdout.write(`${report.counts.passed} passed, ${report.counts.failed} failed, ${report.counts.warnings} warning(s), ${report.counts.skipped} skipped.\n\n`);
  for (const check of report.checks) {
    const prefix = { passed: 'PASS', failed: 'FAIL', warning: 'WARN', skipped: 'SKIP' }[check.status] || check.status.toUpperCase();
    process.stdout.write(`${prefix.padEnd(4)} ${check.id}: ${check.message}\n`);
  }
  if (report.status === 'FAIL') {
    process.stdout.write('\nNo Maestro flow was launched. Fix the failed checks, then rerun npm run qa:doctor.\n');
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(helpText()); return; }
  const report = await runDoctor(options);
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
  if (report.status === 'FAIL') process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });

module.exports = {
  DEFAULTS,
  parseArgs,
  parsePowerShellConfig,
  mergedEnvironment,
  resolveCommand,
  checkPaths,
  checkLocalContract,
  probePort,
  checkDevices,
  checkTools,
  runDoctor,
};
