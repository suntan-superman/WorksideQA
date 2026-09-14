const assert = require('node:assert/strict');
const test = require('node:test');
const { prewarmMetroBundle } = require('../src/metro-bundle');

function response({ status = 200, manifest = null, bytes = 128, throwOnBody = false } = {}) {
  return {
    status,
    async json() {
      if (!manifest) throw new Error('invalid json');
      return manifest;
    },
    async arrayBuffer() {
      if (throwOnBody) throw new Error('body failed');
      return new ArrayBuffer(bytes);
    },
  };
}

function manifest(url = 'http://127.0.0.1:8081/node_modules/expo/AppEntry.bundle?platform=android') {
  return {
    launchAsset: { url },
    extra: { expoClient: { extra: { ENVIRONMENT: 'maestro' } } },
  };
}

test('prewarms the manifest launchAsset bundle and consumes the complete response', async () => {
  const calls = [];
  const result = await prewarmMetroBundle({
    baseUrl: 'http://127.0.0.1:8081',
    platform: 'android',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1 ? response({ manifest: manifest() }) : response({ bytes: 4096 });
    },
    validateManifest: (value) => {
      assert.equal(value.launchAsset.url.includes('AppEntry.bundle'), true);
      return { environment: 'maestro' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.bundleBytes, 4096);
  assert.equal(result.runtime.environment, 'maestro');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers['expo-platform'], 'android');
  assert.equal(calls[1].options.headers.accept, 'application/javascript');
  assert.ok(result.bundlePrewarmStart);
  assert.ok(result.bundlePrewarmComplete);
});

test('Metro port/manifest can be available while an invalid bundle response fails prewarm', async () => {
  const result = await prewarmMetroBundle({
    fetchImpl: async (url) => url.endsWith('/') ? response({ manifest: manifest() }) : response({ status: 503 }),
    validateManifest: () => ({ environment: 'maestro' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'METRO_BUNDLE_RESPONSE_INVALID');
});

test('wrong runtime is rejected before the bundle can satisfy readiness', async () => {
  let bundleRequested = false;
  const result = await prewarmMetroBundle({
    fetchImpl: async (url) => {
      if (url.endsWith('/')) return response({ manifest: manifest() });
      bundleRequested = true;
      return response({ bytes: 10 });
    },
    validateManifest: () => { throw new Error('environment=production'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'METRO_BUNDLE_RESPONSE_INVALID');
  assert.equal(bundleRequested, false);
});

test('bundle prewarm timeout is bounded', async () => {
  const result = await prewarmMetroBundle({
    timeoutMs: 15,
    fetchImpl: (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'METRO_BUNDLE_PREWARM_TIMEOUT');
});
