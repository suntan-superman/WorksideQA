#!/usr/bin/env node
const path = require("path");
const { generateReleaseReview } = require("../../qa-openai/src");
const { sendExecutiveEmail, writeExecutiveEmail } = require("../../qa-reporting/src/executive-email");
const { writeDashboardData } = require("../../qa-reporting/src/dashboard-data");
const { fromRoot, log, spawnCommand } = require("../../qa-utils/src");
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
    else if (arg === "--send-executive-email") options.sendExecutiveEmail = true;
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
  --send-executive-email
                 Send the executive email through the configured provider
`;
}

function productCounts(products) {
  const clean = products.filter((product) => product.latestStatus === "PASS");
  const failing = products.filter((product) => product.latestStatus === "FAIL");
  return { clean, failing };
}

function openDashboardFile(dashboardPath) {
  if (process.platform !== "win32") return false;
  const child = spawnCommand("cmd", ["/c", "start", "", dashboardPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return true;
}

function printSummary({ report, dashboardData, aiReview, executiveEmail, emailDelivery, dashboardPath }) {
  const { clean, failing } = productCounts(dashboardData.products || []);
  log("");
  log("WorksideQA Release Summary");
  log(`Overall status: ${report.status}`);
  log(`Readiness score: ${dashboardData.overallReadiness}%`);
  if (dashboardData.releaseAdvisor) {
    log(`Release advisor: ${dashboardData.releaseAdvisor.recommendation} (risk ${dashboardData.releaseAdvisor.riskScore})`);
  }
  log(`Clean products: ${clean.length}`);
  log(`Failing products: ${failing.length}`);
  if (failing.length) log(`Failing product keys: ${failing.map((product) => product.productKey).join(", ")}`);
  log(`Dashboard: ${dashboardPath}`);
  log(`AI review: ${aiReview.markdownPath}`);
  log(`Executive email: ${executiveEmail.markdownPath}`);
  if (emailDelivery) log(`Executive email delivery: ${emailDelivery.status}`);
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
  const executiveEmail = writeExecutiveEmail(dashboardData);
  const emailDelivery = options.sendExecutiveEmail ? await sendExecutiveEmail(dashboardData) : null;
  const dashboardPath = fromRoot("dashboard", "index.html");

  printSummary({ report, dashboardData, aiReview, executiveEmail, emailDelivery, dashboardPath });

  if (options.openDashboard) {
    const opened = openDashboardFile(dashboardPath);
    if (opened) log("Dashboard opened in your default browser.");
  }

  return { report, dashboardData, aiReview, executiveEmail, emailDelivery, dashboardPath };
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
