#!/usr/bin/env node
const { helpText, parseArgs } = require("./args");
const { runAllProducts } = require("./runner");
const { log } = require("../../qa-utils/src");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    log(helpText());
    return;
  }

  const report = await runAllProducts(options);
  log(`WorksideQA ${report.status}: ${report.counts.passed} passed, ${report.counts.failed} failed, ${report.counts.warnings} warning(s), ${report.counts.skipped} skipped.`);
  log(`HTML report: ${report.htmlPath}`);
  log(`JSON report: ${report.jsonPath}`);

  if (report.status !== "PASS") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

