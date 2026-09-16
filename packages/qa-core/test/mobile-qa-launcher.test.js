const assert = require('node:assert/strict');
const test = require('node:test');
const { loadEnvironmentConfig, parseArgs, platformKey, resolveProductPaths, sharedPorts, selectedProducts, startProduct } = require('../src/mobile-qa-launcher');

test('mobile QA launcher loads both product inventories without secrets', () => {
  const config = loadEnvironmentConfig();
  assert.deepEqual(Object.keys(config.products).sort(), ['merxus', 'sageset']);
  assert.equal(config.products.merxus.runtime.environment, 'maestro');
  assert.equal(config.products.merxus.runtime.firebaseProjectId, 'merxus-maestro-local');
  assert.equal(config.products.merxus.services.find((item) => item.name === 'backend').ports[0], 8787);
  assert.equal(config.products.sageset.runtime.firebaseProjectId, 'sageset-maestro-local');
  assert.equal(JSON.stringify(config).includes('PASSWORD'), false);
});

test('launcher parses health-check and product selection', () => {
  assert.deepEqual(parseArgs(['--product', 'merxus', '--health-check']), { product: 'merxus', healthOnly: true, help: false });
  assert.deepEqual(parseArgs([]), { product: null, healthOnly: false, help: false });
});

test('launcher resolves repository paths relative to WorksideQA on supported platforms', () => {
  const config = loadEnvironmentConfig();
  const paths = resolveProductPaths(config.products.merxus, 'C:\\Users\\qa\\WorksideQA', 'win32');
  assert.equal(paths.mobile, 'C:\\Users\\qa\\Merxus\\mobile');
  assert.equal(platformKey('darwin'), 'darwin');
});

test('Both mode refuses the shared emulator ports instead of colliding', () => {
  const config = loadEnvironmentConfig();
  const conflict = sharedPorts(config, ['merxus', 'sageset']);
  assert.equal(conflict.port, 9099);
  assert.throws(() => selectedProducts(config, 'both'), /port 9099 is shared/);
});

test('single product selection remains valid', () => {
  const config = loadEnvironmentConfig();
  assert.deepEqual(selectedProducts(config, 'merxus'), ['merxus']);
  assert.deepEqual(selectedProducts(config, 'sageset'), ['sageset']);
});

test('launcher returns after qa:start readiness without running a duplicate Doctor', () => {
  const config = loadEnvironmentConfig();
  const calls = [];
  const result = startProduct(config, 'merxus', (args, options) => {
    calls.push({ args, options });
    return { status: 0, signal: null, error: null };
  });
  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, config.products.merxus.startCommand);
  assert.equal(calls[0].options.timeoutMs > 0, true);
});

test('launcher reports a bounded startup timeout instead of waiting indefinitely', () => {
  const config = loadEnvironmentConfig();
  const result = startProduct(config, 'sageset', () => ({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }));
  assert.equal(result, 1);
});
