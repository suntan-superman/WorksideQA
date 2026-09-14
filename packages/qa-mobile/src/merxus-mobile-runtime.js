const fs = require('node:fs');
const path = require('node:path');
const { spawnCommandSync } = require('../../qa-utils/src');
const { loadLocalQaConfig } = require('../../qa-core/src/local-config');

const PROFILE = 'maestro-simulator';
const PROFILE_KEYS = [
  'MERXUS_MOBILE_ENVIRONMENT', 'EXPO_PUBLIC_ENVIRONMENT',
  'EXPO_PUBLIC_FIREBASE_PROJECT_ID', 'EXPO_PUBLIC_API_BASE_URL',
  'EXPO_PUBLIC_AUTH_EMULATOR_HOST', 'EXPO_PUBLIC_FIRESTORE_EMULATOR_HOST',
  'EXPO_PUBLIC_STORAGE_EMULATOR_HOST', 'EXPO_PUBLIC_ALLOW_EXTERNAL_PROVIDERS',
];

function canonicalMobileEnvironment(mobileRoot) {
  const profile = JSON.parse(fs.readFileSync(path.join(mobileRoot, 'eas.json'), 'utf8')).build?.[PROFILE];
  if (!profile?.developmentClient) throw new Error(`Missing Mobile ${PROFILE} development profile.`);
  const env = {};
  for (const key of PROFILE_KEYS) {
    if (typeof profile.env?.[key] !== 'string' || !profile.env[key]) throw new Error(`Missing ${key} in Mobile ${PROFILE}.`);
    env[key] = profile.env[key];
  }
  // Use app.config.js's local Firebase defaults, not inherited production values or .env.
  return { ...env, EXPO_NO_DOTENV: '1', EXPO_PUBLIC_FIREBASE_API_KEY: '',
    EXPO_PUBLIC_FIREBASE_APP_ID: '', EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET: '', EXPO_PUBLIC_FIXTURE_GENERATION: '' };
}

async function runtimeFunctions(mobileRoot) {
  // Execute Mobile's actual pure runtime mapper and validator; do not reimplement Android mapping.
  const source = fs.readFileSync(path.join(mobileRoot, 'src/config/runtimeEnvironment.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

async function verifyExpoConfig(config, mobileRoot, source, platform = 'android') {
  const { buildRuntimeConfiguration, validateRuntimeConfiguration } = await runtimeFunctions(mobileRoot);
  const runtime = buildRuntimeConfiguration(config?.extra, platform);
  const summary = {
    source, environment: runtime.environment, isMaestro: runtime.isMaestro,
    appId: runtime.appId, androidPackage: config?.android?.package ?? null,
    iosBundleIdentifier: config?.ios?.bundleIdentifier ?? null,
    backendUrl: runtime.apiBaseUrl, firebaseProjectId: runtime.firebaseProjectId,
    authEmulatorHost: runtime.authEmulatorHost, firestoreEmulatorHost: runtime.firestoreEmulatorHost,
    storageEmulatorHost: runtime.storageEmulatorHost, allowExternalProviders: runtime.allowExternalProviders,
  };
  const expected = {
    environment: 'maestro', isMaestro: true, appId: 'com.merxus.mobile.qa',
    androidPackage: 'com.merxus.mobile.qa', iosBundleIdentifier: 'com.merxus.mobile.qa',
    backendUrl: platform === 'android' ? 'http://10.0.2.2:8787' : 'http://127.0.0.1:8787', firebaseProjectId: 'merxus-maestro-local',
    authEmulatorHost: platform === 'android' ? '10.0.2.2:9099' : '127.0.0.1:9099', firestoreEmulatorHost: platform === 'android' ? '10.0.2.2:8080' : '127.0.0.1:8080',
    storageEmulatorHost: platform === 'android' ? '10.0.2.2:9199' : '127.0.0.1:9199', allowExternalProviders: false,
  };
  const errors = Object.keys(expected).filter(key => summary[key] !== expected[key]);
  if (!runtime.firebaseApiKey || !runtime.firebaseAppId || !runtime.firebaseStorageBucket) errors.push('Firebase client configuration');
  if (errors.length || !validateRuntimeConfiguration(runtime).ok) {
    throw new Error(`Mobile runtime preflight FAILED (${source}): ${errors.join(', ') || 'Mobile validation'}. ${JSON.stringify(summary)}`);
  }
  return summary;
}

function resolvedExpoConfig(mobileRoot, env = process.env) {
  const outcome = spawnCommandSync(process.execPath, [path.join(mobileRoot, 'node_modules/expo/bin/cli'), 'config', '--type', 'public', '--json'], {
    cwd: mobileRoot, env, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  // Never echo the full config or CLI stderr (may contain unrelated environment values).
  if (outcome.error || outcome.status !== 0) throw new Error('Mobile Expo config resolution failed. Check the Mobile path and installed dependencies.');
  try { return JSON.parse(outcome.stdout); } catch { throw new Error('Mobile Expo config did not return valid JSON.'); }
}

async function verifyServedRuntime(mobileRoot, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl('http://127.0.0.1:8081/', {
      headers: { accept: 'application/expo+json', 'expo-platform': 'android' },
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
  } catch { throw new Error('Mobile runtime preflight FAILED: T3 Metro is unreachable on 127.0.0.1:8081.'); }
  if (response.status !== 200) throw new Error(`Mobile runtime preflight FAILED: Metro HTTP ${response.status}.`);
  let manifest;
  try { manifest = await response.json(); } catch { throw new Error('Mobile runtime preflight FAILED: Metro did not return an Expo manifest.'); }
  if (!manifest?.extra?.expoClient) throw new Error('Mobile runtime preflight FAILED: Metro manifest has no expoClient configuration.');
  return verifyExpoConfig(manifest.extra.expoClient, mobileRoot, 'served Metro Android manifest', 'android');
}

async function main(argv = process.argv.slice(2)) {
  loadLocalQaConfig({ required: true });
  const allowed = new Set(['--print-env', '--config-only', '--served-only', '--mobile-root']);
  let mobileRoot = process.env.MERXUS_MOBILE_REPO || path.resolve(__dirname, '../../../../Merxus/mobile');
  for (let i = 0; i < argv.length; i++) {
    if (!allowed.has(argv[i])) throw new Error('Unknown Mobile runtime preflight option.');
    if (argv[i] === '--mobile-root') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--mobile-root requires a directory.');
      mobileRoot = path.resolve(argv[++i]);
    }
  }
  if (argv.includes('--print-env')) {
    console.log(JSON.stringify(canonicalMobileEnvironment(mobileRoot)));
    return;
  }
  if (!argv.includes('--served-only')) {
    console.log(JSON.stringify(await verifyExpoConfig(resolvedExpoConfig(mobileRoot), mobileRoot, 'current shell Expo config')));
  }
  if (!argv.includes('--config-only')) console.log(JSON.stringify(await verifyServedRuntime(mobileRoot)));
}

module.exports = { canonicalMobileEnvironment, resolvedExpoConfig, verifyExpoConfig, verifyServedRuntime };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
