const DEFAULT_METRO_BASE_URL = 'http://127.0.0.1:8081';
const DEFAULT_PREWARM_TIMEOUT_MS = 120_000;

function withTimeout(fetchImpl, timeoutMs) {
  return async (url, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

async function responseSize(response) {
  if (typeof response.arrayBuffer === 'function') {
    const bytes = await response.arrayBuffer();
    return bytes.byteLength;
  }
  if (typeof response.text === 'function') return (await response.text()).length;
  return 0;
}

/**
 * Fetch the Expo manifest and then consume its launchAsset bundle. The
 * manifest validator is supplied by the product runtime verifier so this
 * helper remains reusable across products and platforms.
 */
async function prewarmMetroBundle(options = {}) {
  const {
    baseUrl = DEFAULT_METRO_BASE_URL,
    platform = 'android',
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_PREWARM_TIMEOUT_MS,
    validateManifest = null,
  } = options;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'METRO_BUNDLE_PREWARM_FAILED', error: 'A fetch implementation is required.' };
  }
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const request = (url, options = {}) => withTimeout(fetchImpl, Math.max(1, deadline - Date.now()))(url, options);
  let manifestResponse;
  try {
    manifestResponse = await request(new URL('/', baseUrl).toString(), {
      headers: { accept: 'application/expo+json', 'expo-platform': platform },
    });
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'METRO_BUNDLE_PREWARM_TIMEOUT' : 'METRO_BUNDLE_PREWARM_FAILED', error: error?.message || String(error), bundlePrewarmStart: new Date(startedAt).toISOString(), bundlePrewarmElapsedMs: Date.now() - startedAt };
  }
  if (!manifestResponse || manifestResponse.status !== 200) {
    return { ok: false, reason: 'METRO_BUNDLE_RESPONSE_INVALID', error: `Metro manifest HTTP ${manifestResponse?.status ?? 'unknown'}.`, bundlePrewarmStart: new Date(startedAt).toISOString(), bundlePrewarmElapsedMs: Date.now() - startedAt };
  }
  let manifest;
  try {
    manifest = await manifestResponse.json();
  } catch (error) {
    return { ok: false, reason: 'METRO_BUNDLE_RESPONSE_INVALID', error: `Metro manifest JSON invalid: ${error?.message || String(error)}.`, bundlePrewarmStart: new Date(startedAt).toISOString(), bundlePrewarmElapsedMs: Date.now() - startedAt };
  }
  let runtime;
  try {
    runtime = validateManifest ? await validateManifest(manifest) : null;
  } catch (error) {
    return { ok: false, reason: 'METRO_BUNDLE_RESPONSE_INVALID', error: error?.message || String(error), bundlePrewarmStart: new Date(startedAt).toISOString(), bundlePrewarmElapsedMs: Date.now() - startedAt };
  }
  const assetUrl = manifest?.launchAsset?.url;
  if (!assetUrl || !/^https?:\/\//i.test(String(assetUrl))) {
    return { ok: false, reason: 'METRO_BUNDLE_RESPONSE_INVALID', error: 'Expo manifest has no absolute launchAsset URL.', runtime, bundlePrewarmStart: new Date(startedAt).toISOString(), bundlePrewarmElapsedMs: Date.now() - startedAt };
  }
  let bundleResponse;
  try {
    bundleResponse = await request(String(assetUrl), {
      headers: { accept: 'application/javascript', 'expo-platform': platform },
    });
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'METRO_BUNDLE_PREWARM_TIMEOUT' : 'METRO_BUNDLE_PREWARM_FAILED', error: error?.message || String(error), runtime, bundleUrl: assetUrl, bundlePrewarmStart: new Date(startedAt).toISOString(), bundlePrewarmElapsedMs: Date.now() - startedAt };
  }
  if (!bundleResponse || bundleResponse.status !== 200) {
    return { ok: false, reason: 'METRO_BUNDLE_RESPONSE_INVALID', error: `Metro bundle HTTP ${bundleResponse?.status ?? 'unknown'}.`, runtime, bundleUrl: assetUrl, bundlePrewarmStart: new Date(startedAt).toISOString(), bundlePrewarmElapsedMs: Date.now() - startedAt };
  }
  let bundleBytes;
  try {
    bundleBytes = await responseSize(bundleResponse);
  } catch (error) {
    return { ok: false, reason: 'METRO_BUNDLE_PREWARM_FAILED', error: error?.message || String(error), runtime, bundleUrl: assetUrl, bundlePrewarmStart: new Date(startedAt).toISOString(), bundlePrewarmElapsedMs: Date.now() - startedAt };
  }
  if (!bundleBytes) {
    return { ok: false, reason: 'METRO_BUNDLE_RESPONSE_INVALID', error: 'Metro bundle response was empty.', runtime, bundleUrl: assetUrl, bundlePrewarmStart: new Date(startedAt).toISOString(), bundlePrewarmElapsedMs: Date.now() - startedAt };
  }
  const completedAt = Date.now();
  return {
    ok: true,
    platform,
    runtime,
    manifestUrl: new URL('/', baseUrl).toString(),
    bundleUrl: assetUrl,
    bundleBytes,
    bundleCacheWarm: null,
    bundlePrewarmStart: new Date(startedAt).toISOString(),
    bundlePrewarmComplete: new Date(completedAt).toISOString(),
    bundlePrewarmElapsedMs: completedAt - startedAt,
  };
}

module.exports = { DEFAULT_METRO_BASE_URL, DEFAULT_PREWARM_TIMEOUT_MS, prewarmMetroBundle };
