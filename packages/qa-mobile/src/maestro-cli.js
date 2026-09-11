#!/usr/bin/env node

const { loadProductManifest } = require("../../qa-config/src");
const { runMaestroFlows, selectFlows, validateMaestroConfiguration } = require("./maestro-runner");

function usage() {
  console.log(`Usage:
  node packages/qa-mobile/src/maestro-cli.js --product <key> [--suite <name> | --flow <name>] [--validate]

Options:
  --product <key>  Product manifest key (required)
  --suite <name>   Run a configured Maestro suite
  --flow <name>    Run one configured flow; .yaml is optional
  --device <name>  Use an explicit manifest device descriptor
  --validate       Validate configuration and YAML without invoking Maestro
  --list           List configured suites and flows
  --help            Show this help`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--validate") options.validateOnly = true;
    else if (argument === "--list") options.list = true;
    else if (["--product", "--suite", "--flow", "--device"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (options.flow && options.suite) throw new Error("Choose either --flow or --suite, not both.");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!options.product) throw new Error("--product is required.");

  const config = loadProductManifest(options.product);
  const validated = validateMaestroConfiguration(config);
  if (options.list) {
    console.log(`Suites: ${Object.keys(validated.maestro.suites).join(", ")}`);
    console.log(`Flows: ${validated.flows.map((flow) => flow.name).join(", ")}`);
    return;
  }

  const selected = selectFlows(validated, options);
  if (options.validateOnly) {
    console.log(`Validated ${selected.length} Maestro flow(s) for ${options.product}:`);
    for (const flow of selected) console.log(`- ${flow.name}`);
    return;
  }

  await runMaestroFlows(config, options);
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
