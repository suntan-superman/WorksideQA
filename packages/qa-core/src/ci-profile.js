#!/usr/bin/env node
const { generateReleaseReview } = require("../../qa-openai/src");
const { writeDashboardData } = require("../../qa-reporting/src/dashboard-data");
const { environmentHealth } = require("../../qa-config/src");
const { maskSecrets } = require("../../qa-utils/src");
const { runAllProducts } = require("./runner");
const { runSafetyGate } = require("./safety-gate");

function stepResult(name, status, message, extra = {}) {
  return { name, status, message, ...extra };
}

function printStep(result) {
  process.stdout.write(`${result.status}: ${result.name} - ${result.message}\n`);
}

async function runCiProfile(options = {}) {
  const results = [];

  const safety = runSafetyGate({ strictArtifacts: options.strictArtifacts === true });
  results.push(stepResult("safety gate", safety.status, `${safety.secretFindings.length} secret finding(s), ${safety.generatedFindings.length} generated artifact path(s).`, { safety }));

  const env = await environmentHealth({ checkNetwork: false, environment: options.environment || "local" });
  results.push(stepResult("environment health", env.status === "FAIL" ? "WARN" : env.status, `${env.counts.passed} passed, ${env.counts.failed} failed, ${env.counts.warnings} warning(s).`, { env }));

  const smoke = await runAllProducts({ all: true, suite: "smoke", dryRun: true, startServer: false, skipPreflight: true, environment: options.environment || "local" });
  results.push(stepResult("smoke dry run", smoke.status, `${smoke.counts.passed} passed, ${smoke.counts.failed} failed.`));

  const workflows = await runAllProducts({ all: true, suite: "workflow", dryRun: true, startServer: false, skipPreflight: true, environment: options.environment || "local" });
  results.push(stepResult("workflow dry run", workflows.status, `${workflows.counts.passed} passed, ${workflows.counts.failed} failed.`));

  const dashboard = writeDashboardData();
  results.push(stepResult("dashboard data", "PASS", `Dashboard data written to ${dashboard.outputPath}.`));

  const review = await generateReleaseReview({ limit: 100, deterministicOnly: true });
  results.push(stepResult("release advisor", review.advisor?.recommendation === "hold" ? "WARN" : "PASS", `${review.advisor?.recommendation || "unknown"} risk ${review.advisor?.riskScore ?? "n/a"}.`, { advisor: review.advisor }));

  return {
    status: results.some((item) => item.status === "FAIL") ? "FAIL" : results.some((item) => item.status === "WARN") ? "WARN" : "PASS",
    results,
  };
}

function parseArgs(argv) {
  const options = { strictArtifacts: false, environment: process.env.WORKSIDEQA_ENVIRONMENT || "local" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--strict-artifacts") options.strictArtifacts = true;
    else if (arg === "--environment" || arg === "--env") options.environment = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function helpText() {
  return `WorksideQA CI profile

Usage:
  npm run qa:ci
  node packages/qa-core/src/ci-profile.js --strict-artifacts

Runs CI-safe validation without launching local product servers:
- safety gate
- offline environment health
- all-product smoke dry run
- all-product workflow dry run
- dashboard data generation
- deterministic release advisor
`;
}

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(helpText());
      return;
    }
    const result = maskSecrets(await runCiProfile(options));
    process.stdout.write(`WorksideQA CI profile: ${result.status}\n`);
    for (const item of result.results) printStep(item);
    if (result.status === "FAIL") process.exitCode = 1;
  })().catch((error) => {
    process.stderr.write(`${maskSecrets(error.stack || error.message)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  runCiProfile,
};
