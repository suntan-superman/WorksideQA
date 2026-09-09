#!/usr/bin/env node
const { environmentHealth } = require("./dependency-health");
const { maskSecrets } = require("../../qa-utils/src");

function parseArgs(argv) {
  const options = {
    all: true,
    checkNetwork: true,
    timeoutMs: 2500,
    environment: process.env.WORKSIDEQA_ENVIRONMENT || "local",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--product") {
      options.product = argv[++index];
      options.all = false;
    } else if (arg === "--all") {
      options.all = true;
      options.product = null;
    } else if (arg === "--no-network" || arg === "--skip-network") {
      options.checkNetwork = false;
    } else if (arg === "--timeout") {
      options.timeoutMs = Number(argv[++index]);
    } else if (arg === "--environment" || arg === "--env") {
      options.environment = argv[++index];
    } else if (arg === "--require-ai") {
      options.requireAi = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function helpText() {
  return `WorksideQA environment health

Usage:
  npm run qa:env:health
  npm run qa:env:health -- --product radiusiq
  npm run qa:env:health -- --skip-network

Options:
  --product <key>       Validate one product instead of all products
  --all                 Validate all products
  --skip-network        Skip URL probes and only validate local/env prerequisites
  --no-network          Alias for --skip-network when invoking the script directly
  --timeout <ms>        Per-URL probe timeout, defaults to 2500
  --environment <name>  local, staging, or production; defaults to local
  --require-ai          Treat missing OpenAI credentials as release-blocking
`;
}

function printHealth(result) {
  process.stdout.write(`WorksideQA environment health: ${result.status}\n`);
  process.stdout.write(`Environment: ${result.environment}\n`);
  process.stdout.write(`${result.counts.passed} passed, ${result.counts.failed} failed, ${result.counts.warnings} warning(s), ${result.counts.skipped} skipped.\n\n`);

  for (const product of result.products) {
    process.stdout.write(`${product.productName} (${product.productKey}): ${product.status}\n`);
    for (const dependency of product.graph.dependencies) {
      const label = `${dependency.key} [${dependency.type}] ${dependency.severity || (dependency.required ? "required" : "optional")}`;
      process.stdout.write(`  dependency: ${label}\n`);
    }
    for (const check of product.checks) {
      process.stdout.write(`  ${check.status.toUpperCase()}: ${check.name} - ${check.message}\n`);
    }
    process.stdout.write("\n");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  const result = maskSecrets(await environmentHealth(options));
  printHealth(result);
  if (result.status === "FAIL") process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${maskSecrets(error.stack || error.message)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  printHealth,
};
