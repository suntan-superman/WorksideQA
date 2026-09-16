#!/usr/bin/env node

/**
 * Small cross-platform front door for the local mobile QA lab.  The service
 * lifecycle remains owned by qa:start/qa:stop; this module only selects a
 * product, invokes those existing commands, and prints a useful summary.
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const { fromRoot } = require('../../qa-utils/src');
const { loadLocalQaConfig } = require('./local-config');

const CONFIG_PATH = fromRoot('configs', 'mobile-qa-environments.json');
const LAUNCH_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

function loadEnvironmentConfig(filePath = CONFIG_PATH) {
  const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!config || config.version !== 1 || !config.products) throw new Error(`Invalid mobile QA environment config: ${filePath}`);
  return config;
}

function parseArgs(argv) {
  const options = { product: null, healthOnly: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--product') options.product = String(argv[++i] || '').toLowerCase();
    else if (arg === '--health-check' || arg === '--health-only') options.healthOnly = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.product && !['merxus', 'sageset', 'both'].includes(options.product)) throw new Error('--product must be merxus, sageset, or both.');
  return options;
}

function platformKey(platform = process.platform) {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
}

function resolveProductPaths(productConfig, root = fromRoot(), platform = process.platform) {
  const paths = productConfig.repositories[platformKey(platform)] || productConfig.repositories.windows;
  return Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, path.resolve(root, value)]));
}

function commandFor(command, platform = process.platform) {
  if (command !== 'npm') return command;
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runCommand(args, options = {}) {
  const [command, ...commandArgs] = args;
  const executable = commandFor(command, options.platform);
  return spawnSync(commandFor(command, options.platform), commandArgs, {
    cwd: options.cwd || fromRoot(),
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.stdio || 'inherit',
    timeout: Number(options.timeoutMs || LAUNCH_COMMAND_TIMEOUT_MS),
    killSignal: 'SIGTERM',
    windowsHide: true,
    // Windows cannot spawn a .cmd shim directly with the native process API
    // in every Node invocation (EINVAL). Let cmd.exe execute npm.cmd while
    // preserving each argument as a child-process argument.
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable),
  });
}

function sharedPorts(config, products) {
  const owners = new Map();
  for (const product of products) {
    for (const service of config.products[product].services) {
      for (const port of service.ports) {
        const existing = owners.get(port);
        if (existing && existing !== product) return { port, products: [existing, product] };
        owners.set(port, product);
      }
    }
  }
  return null;
}

function selectedProducts(config, product) {
  const products = product === 'both' ? ['merxus', 'sageset'] : [product];
  for (const name of products) if (!config.products[name]) throw new Error(`Unsupported product: ${name}`);
  const conflict = sharedPorts(config, products);
  if (conflict) throw new Error(`Both mode is unavailable: port ${conflict.port} is shared by ${conflict.products.join(' and ')}. Start products separately to avoid mixing QA environments.`);
  return products;
}

function printInventory(config, product, platform = process.platform) {
  const item = config.products[product];
  const paths = resolveProductPaths(item, fromRoot(), platform);
  process.stdout.write(`\n${item.displayName} QA (${platformKey(platform)})\n`);
  process.stdout.write(`  paths: ${JSON.stringify(paths)}\n`);
  process.stdout.write(`  runtime: ${item.runtime.environment}${item.runtime.firebaseProjectId ? ` / ${item.runtime.firebaseProjectId}` : ''}\n`);
  for (const service of item.services) process.stdout.write(`  service: ${service.name} (${service.ports.join(', ')}) — ${service.role}\n`);
}

function runDoctor(product) {
  return runCommand(['npm', 'run', 'qa:doctor', '--', '--product', product, '--strict'], { timeoutMs: LAUNCH_COMMAND_TIMEOUT_MS });
}

function startProduct(config, product, runner = runCommand) {
  const item = config.products[product];
  printInventory(config, product);
  process.stdout.write(`\nStarting ${item.displayName}; healthy WorksideQA-owned services are reused by qa:start.\n`);
  // qa:start owns the complete dependency/readiness contract and already
  // runs the product-scoped strict Doctor before returning READY. Running a
  // second Doctor here would create a second rendered-app/UiAutomation probe,
  // needlessly duplicate the cold-start wait, and can leave the launcher
  // appearing hung while the environment is already healthy.
  const started = runner(item.startCommand, { timeoutMs: LAUNCH_COMMAND_TIMEOUT_MS });
  if (started.error?.code === 'ETIMEDOUT' || started.signal) {
    process.stderr.write(`\n${item.displayName} startup command timed out before returning (timeout=${LAUNCH_COMMAND_TIMEOUT_MS}ms).\n`);
    return 1;
  }
  if (started.status !== 0) return started.status || 1;
  process.stdout.write(`\n==================================================\n${item.displayName.toUpperCase()} QA READY\n==================================================\n`);
  process.stdout.write(`${item.displayName.toUpperCase()} QA ENVIRONMENT READY\n`);
  process.stdout.write(`Certification: ${item.certificationCommand}\n`);
  process.stdout.write('Mobile regression: npm run test:mobile\n');
  return 0;
}

function healthProduct(config, product) {
  printInventory(config, product);
  process.stdout.write(`\nHealth check only — no services will be started.\n`);
  const result = runDoctor(product);
  process.stdout.write(`\nSTATUS: ${result.status === 0 ? 'READY' : 'NOT READY'}\n`);
  return result.status || 0;
}

function menu() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write('\n========================================\nWorksideQA Mobile Environment\n========================================\n\n1. Merxus\n2. SageSet\n3. Both\n4. Health Check Only\n5. Exit\n\n');
    rl.question('Select [1-5]: ', (answer) => { rl.close(); resolve(String(answer).trim()); });
  });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write('Usage: node packages/qa-core/src/mobile-qa-launcher.js [--product merxus|sageset|both] [--health-check]\n');
    return 0;
  }
  const config = loadEnvironmentConfig();
  // Fail before any service command when the canonical local contract is
  // absent. The loader is allowlisted and never prints secret values.
  loadLocalQaConfig({ required: true });
  let product = options.product;
  if (!product) {
    const choice = await menu();
    if (choice === '5') return 0;
    if (choice === '4') {
      const results = ['merxus', 'sageset'].map((name) => healthProduct(config, name));
      return results.some((code) => code !== 0) ? 1 : 0;
    }
    product = ({ '1': 'merxus', '2': 'sageset', '3': 'both' })[choice];
    if (!product) throw new Error('Choose a number from 1 to 5.');
  }
  const products = selectedProducts(config, product);
  const results = products.map((name) => options.healthOnly ? healthProduct(config, name) : startProduct(config, name));
  return results.some((code) => code !== 0) ? 1 : 0;
}

if (require.main === module) main().then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

module.exports = { CONFIG_PATH, LAUNCH_COMMAND_TIMEOUT_MS, loadEnvironmentConfig, parseArgs, platformKey, resolveProductPaths, sharedPorts, selectedProducts, runCommand, startProduct };
