const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { canonicalMobileEnvironment, resolvedExpoConfig, verifyExpoConfig, verifyServedRuntime } = require('../src/merxus-mobile-runtime');

const mobileRoot = process.env.MERXUS_MOBILE_REPO || path.resolve(__dirname, '../../../../Merxus/mobile');
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(EXPO_|MERXUS_)/i.test(key)));
const canonical = canonicalMobileEnvironment(mobileRoot);
const qaConfig = resolvedExpoConfig(mobileRoot, { ...cleanEnv, ...canonical });

test('clean shell loads the existing EAS contract and real Android runtime mapping', async () => {
  const result = await verifyExpoConfig(qaConfig, mobileRoot, 'test');
  assert.equal(result.environment, 'maestro');
  assert.equal(result.backendUrl, 'http://10.0.2.2:8787');
  assert.equal(result.authEmulatorHost, '10.0.2.2:9099');
  assert.equal(result.firestoreEmulatorHost, '10.0.2.2:8080');
  assert.equal(result.storageEmulatorHost, '10.0.2.2:9199');
  assert.equal(result.appId, 'com.merxus.mobile.qa');
});

test('plain Metro production defaults fail; QA native app identity alone is insufficient', async () => {
  const production = resolvedExpoConfig(mobileRoot, { ...cleanEnv, EXPO_NO_DOTENV: '1' });
  assert.equal(production.extra.ENVIRONMENT, 'production');
  assert.equal(production.extra.API_BASE_URL, 'https://api.merxus.ai');
  await assert.rejects(verifyExpoConfig(production, mobileRoot, 'plain Metro'), /preflight FAILED.*environment/);
  production.android.package = 'com.merxus.mobile.qa';
  await assert.rejects(verifyExpoConfig(production, mobileRoot, 'wrong runtime'), /preflight FAILED/);
});

test('canonical import overrides inherited production inputs and prevents dotenv overrides', async () => {
  const poisoned = { ...cleanEnv, MERXUS_MOBILE_ENVIRONMENT: 'production', EXPO_PUBLIC_API_BASE_URL: 'https://api.merxus.ai', EXPO_PUBLIC_FIREBASE_API_KEY: 'unrelated-key', ...canonical };
  const config = resolvedExpoConfig(mobileRoot, poisoned);
  await verifyExpoConfig(config, mobileRoot, 'inherited config');
  assert.equal(config.extra.FIREBASE_API_KEY, 'maestro-local-not-a-secret');
  assert.equal(config.extra.FIREBASE_APP_ID, '1:000000000000:web:maestrolocal');
  assert.equal(config.extra.FIREBASE_STORAGE_BUCKET, 'merxus-maestro-local.appspot.com');
  assert.equal(canonical.EXPO_NO_DOTENV, '1');
});

test('live manifest verification catches wrong T3 despite correct T5 environment', async () => {
  const fakeFetch = config => async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8081/');
    assert.equal(options.headers['expo-platform'], 'android');
    assert.equal(options.redirect, 'error');
    return { status: 200, json: async () => ({ extra: { expoClient: config } }) };
  };
  assert.equal((await verifyServedRuntime(mobileRoot, fakeFetch(qaConfig))).isMaestro, true);
  const wrong = structuredClone(qaConfig);
  wrong.extra.ENVIRONMENT = 'production';
  await assert.rejects(verifyServedRuntime(mobileRoot, fakeFetch(wrong)), /served Metro Android manifest/);
  for (const [key, value] of Object.entries({ API_BASE_URL: 'https://api.merxus.ai', FIREBASE_PROJECT_ID: 'production', AUTH_EMULATOR_HOST: '127.0.0.1:9999', FIRESTORE_EMULATOR_HOST: '', STORAGE_EMULATOR_HOST: '', ALLOW_EXTERNAL_PROVIDERS: 'true' })) {
    const bad = structuredClone(qaConfig);
    bad.extra[key] = value;
    await assert.rejects(verifyServedRuntime(mobileRoot, fakeFetch(bad)), /preflight FAILED/);
  }
  await assert.rejects(verifyServedRuntime(mobileRoot, async () => { throw Error('offline'); }), /unreachable/);
  await assert.rejects(verifyServedRuntime(mobileRoot, async () => ({ status: 200, json: async () => ({}) })), /no expoClient/);
});
