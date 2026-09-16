const fs = require('node:fs');
const path = require('node:path');
const { fromRoot } = require('../../qa-utils/src');

// This is the single contract for values that may be imported from the
// machine-local QA file.  Keeping the list explicit prevents an arbitrary
// PowerShell file from becoming an environment-variable injection mechanism.
const QA_CONFIG_KEYS = Object.freeze([
  // Merxus identities, devices, paths and runtime contract.
  'MERXUS_MAESTRO_OWNER_A_EMAIL', 'MERXUS_MAESTRO_OWNER_A_PASSWORD',
  'MERXUS_MAESTRO_OWNER_B_EMAIL', 'MERXUS_MAESTRO_OWNER_B_PASSWORD',
  'MERXUS_MAESTRO_MANAGER_A_EMAIL', 'MERXUS_MAESTRO_MANAGER_A_PASSWORD',
  'MERXUS_MAESTRO_STAFF_A_EMAIL', 'MERXUS_MAESTRO_STAFF_A_PASSWORD',
  'MERXUS_ROOT_REPO',
  'MERXUS_ANDROID_EMULATOR_ID', 'MERXUS_ANDROID_AVD_NAME', 'MERXUS_IOS_SIMULATOR_ID',
  'MERXUS_MAESTRO_FIREBASE_PROJECT_ID', 'MERXUS_MAESTRO_ANDROID_APP_ID',
  'MERXUS_BACKEND_REPO', 'MERXUS_MOBILE_REPO', 'MERXUS_WEB_REPO',
  'MERXUS_QA_ENVIRONMENT', 'MERXUS_MOBILE_ENVIRONMENT', 'MERXUS_QA_BACKEND_URL',
  'MERXUS_ALLOW_EXTERNAL_PROVIDERS',
  // Expo/mobile runtime values served by Metro.
  'EXPO_PUBLIC_ENVIRONMENT', 'EXPO_PUBLIC_API_BASE_URL',
  'EXPO_PUBLIC_FIREBASE_PROJECT_ID', 'EXPO_PUBLIC_AUTH_EMULATOR_HOST',
  'EXPO_PUBLIC_FIRESTORE_EMULATOR_HOST', 'EXPO_PUBLIC_STORAGE_EMULATOR_HOST',
  'EXPO_PUBLIC_ALLOW_EXTERNAL_PROVIDERS', 'EXPO_PUBLIC_FIREBASE_API_KEY',
  'EXPO_PUBLIC_FIREBASE_APP_ID', 'EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'EXPO_PUBLIC_FIXTURE_GENERATION', 'EXPO_NO_DOTENV',
  // Emulator/backend contracts.
  'FIREBASE_PROJECT_ID', 'GCLOUD_PROJECT', 'FIREBASE_AUTH_EMULATOR_HOST',
  'FIRESTORE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST',
  // SageSet's manifest-declared identity/device contract.
  'SAGESET_MOBILE_REPO', 'SAGESET_IOS_MOBILE_REPO', 'SAGESET_WEB_REPO',
  'SAGESET_MAESTRO_USER_A_EMAIL', 'SAGESET_MAESTRO_USER_A_PASSWORD',
  'SAGESET_MAESTRO_USER_B_EMAIL', 'SAGESET_MAESTRO_USER_B_PASSWORD',
  'SAGESET_MAESTRO_QA_EMAIL_ALLOWLIST', 'SAGESET_MAESTRO_ENVIRONMENT',
  'SAGESET_MAESTRO_FIREBASE_PROJECT_ID', 'SAGESET_MAESTRO_ALLOW_EXTERNAL_NOTIFICATIONS',
  'SAGESET_ANDROID_EMULATOR_ID', 'SAGESET_ANDROID_AVD_NAME', 'SAGESET_IOS_SIMULATOR_ID',
  'SAGESET_MAESTRO_ANDROID_APP_ID', 'SAGESET_MAESTRO_IOS_APP_ID',
  // Optional deterministic tool overrides and SDK roots.
  'WORKSIDEQA_NODE_BIN', 'WORKSIDEQA_NPM_BIN', 'WORKSIDEQA_FIREBASE_BIN',
  'WORKSIDEQA_ADB_BIN', 'WORKSIDEQA_MAESTRO_BIN', 'WORKSIDEQA_JAVA_BIN',
  'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'JAVA_HOME', 'WORKSIDEQA_ANDROID_EMULATOR_BIN',
]);

const QA_CONFIG_KEY_SET = new Set(QA_CONFIG_KEYS);
const DEFAULT_LOCAL_CONFIG_PATH = fromRoot('.maestro.local.ps1');

function parsePowerShellConfig(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const entries = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    // Deliberately parse only simple $env:NAME = "value" assignments.  We do
    // not execute the local PowerShell file, and therefore cannot run code or
    // import unapproved variables from it.
    const match = line.match(/^\s*\$env:([A-Z][A-Z0-9_]*)\s*=\s*(["'])(.*?)\2\s*$/);
    if (!match) continue;
    entries[match[1]] = match[3].replace(/``/g, '`').replace(/`(["'])/g, '$1');
  }
  return entries;
}

function compatibleConfiguredPath(value, platform = process.platform) {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  const windowsAbsolute = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(candidate);
  const posixAbsolute = /^\//.test(candidate);
  if (platform === 'win32' && posixAbsolute) return '';
  if (platform !== 'win32' && windowsAbsolute) return '';
  return candidate;
}

function loadLocalQaConfig(options = {}) {
  const filePath = path.resolve(options.filePath || DEFAULT_LOCAL_CONFIG_PATH);
  const sourceEnv = options.env || process.env;
  const required = options.required !== false;
  const mutate = options.mutate !== false;

  if (!fs.existsSync(filePath)) {
    if (!required) return { path: filePath, loadedKeys: [], values: {}, missing: true };
    throw new Error(`Missing local QA config: ${filePath}. Copy maestro.local.ps1.example to .maestro.local.ps1 and fill the local values.`);
  }

  // The parser is also retained as a small doctor utility for validating
  // arbitrary test fixtures.  Importing into process.env remains allowlisted.
  const parsedValues = parsePowerShellConfig(filePath);
  const localValues = Object.fromEntries(Object.entries(parsedValues).filter(([key]) => QA_CONFIG_KEY_SET.has(key)));
  const values = {};
  for (const key of QA_CONFIG_KEYS) {
    // Explicit process values take precedence; the file supplies values only
    // for keys that the caller has not already set.
    const explicit = sourceEnv[key];
    values[key] = explicit !== undefined && explicit !== '' ? explicit : localValues[key];
    if (values[key] !== undefined && values[key] !== '') {
      if (mutate && (process.env[key] === undefined || process.env[key] === '')) process.env[key] = String(values[key]);
    }
  }

  return {
    path: filePath,
    loadedKeys: Object.keys(values).filter((key) => values[key] !== undefined && values[key] !== ''),
    values,
    missing: false,
  };
}

module.exports = {
  QA_CONFIG_KEYS,
  DEFAULT_LOCAL_CONFIG_PATH,
  parsePowerShellConfig,
  compatibleConfiguredPath,
  loadLocalQaConfig,
};
