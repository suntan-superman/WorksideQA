#!/usr/bin/env node

const { loadProductManifest } = require("../../qa-config/src");
const {
  runReleaseCertification,
  validateReleaseCertification,
} = require("./release-certification");

function usage() {
  console.log(`Usage:
  node packages/qa-mobile/src/release-certification-cli.js --product sageset [--validate-only]

Options:
  --product <key>  Product manifest key (required; currently sageset)
  --validate-only  Run non-mutating configuration and contract validation only
  --help           Show this help`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--validate-only") options.validateOnly = true;
    else if (argument === "--product") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--product requires a value.");
      options.product = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!options.product) throw new Error("--product is required.");
  if (options.product !== "sageset") throw new Error("Release certification is currently defined only for sageset.");

  const config = loadProductManifest(options.product);
  if (options.validateOnly) {
    const result = await validateReleaseCertification(config);
    console.log(`Validated SageSet release certification: ${result.validated.release.suites.join(", ")}`);
    console.log(`Passed ${result.preflight.length} non-mutating preflight group(s).`);
    return;
  }

  const certification = await runReleaseCertification(config);
  if (!certification.releaseCertified) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});

module.exports = { main, parseArgs };
