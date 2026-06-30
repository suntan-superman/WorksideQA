#!/usr/bin/env node
const path = require("path");
const { spawn } = require("child_process");
const { generateReleaseReview } = require("../../qa-openai/src");
const { writeDashboardData } = require("../../qa-reporting/src/dashboard-data");
const { fromRoot, log } = require("../../qa-utils/src");
const { runAllProducts } = require("./runner");

function parseArgs(argv) {
  const options = {
    product: null,
    dryRun: false,
    openDashboard: process.platform === "win32",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--product") options.product = argv[++index];
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-open") options.openDashboard = false;
    else if (arg === "--open") options.openDashboard = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function helpText() {
  return `WorksideQA local release workflow

Usage:
  npm run qa:release
  npm run qa:release:no-open
  npm run qa:release:dry
  npm run qa:release:radiusiq

Options:
  --product <key>  Run release workflow for one product instead of all products
  --dry-run        Validate orchestration without launching product apps
  --no-open        Do not open dashboard after the workflow
  --open           Open dashboard after the workflow
`;
}

function productCounts(products) {
  const clean = products.filter((product) => product.latestStatus === "PASS");
  const failing = products.filter((product) => product.latestStatus === "FAIL");
  return { clean, failing };
}

function openDashboardFile(dashboardPath) {
  if (process.platform !== "win32") return false;
  const child = spawn("cmd", ["/c", "start", "", dashboardPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return true;
}

function printSummary({ report, dashboardData, aiReview, dashboardPath }) {
  const { clean, failing } = productCounts(dashboardData.products || []);
  log("");
  log("WorksideQA Release Summary");
  log(`Overall status: ${report.status}`);
  log(`Readiness score: ${dashboardData.overallReadiness}%`);
  log(`Clean products: ${clean.length}`);
  log(`Failing products: ${failing.length}`);
  if (failing.length) log(`Failing product keys: ${failing.map((product) => product.productKey).join(", ")}`);
  log(`Dashboard: ${dashboardPath}`);
  log(`AI review: ${aiReview.markdownPath}`);
}

async function runReleaseWorkflow(options = {}) {
  const productOptions = options.product ? { product: options.product, all: false } : { all: true };
  const report = await runAllProducts({
    ...productOptions,
    suite: "smoke",
    startServer: !options.dryRun,
    dryRun: options.dryRun,
  });

  writeDashboardData();
  const aiReview = await generateReleaseReview();
  const { data: dashboardData } = writeDashboardData();
  const dashboardPath = fromRoot("dashboard", "index.html");

  printSummary({ report, dashboardData, aiReview, dashboardPath });

  if (options.openDashboard) {
    const opened = openDashboardFile(dashboardPath);
    if (opened) log("Dashboard opened in your default browser.");
  }

  return { report, dashboardData, aiReview, dashboardPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    log(helpText());
    return;
  }

  const result = await runReleaseWorkflow(options);
  if (result.report.status !== "PASS") process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  runReleaseWorkflow,
};
