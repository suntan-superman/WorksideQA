const { listProductKeys, loadEnvFile, loadProductManifest, resolveProductConfig } = require("../../qa-config/src");
const { runApiChecks } = require("../../qa-api/src");
const { runBrowserSmoke, runVisualRegression } = require("../../qa-browser/src");
const { runFirebaseChecks } = require("../../qa-firebase/src");
const { runPerformanceChecks } = require("../../qa-performance/src");
const { runAccessibilityChecks } = require("../../qa-accessibility/src");
const { runSecurityChecks } = require("../../qa-security/src");
const { runAiChecks } = require("../../qa-openai/src");
const { runMobileChecks } = require("../../qa-mobile/src");
const { writeReports } = require("../../qa-reporting/src");
const { durationMs, log, nowIso } = require("../../qa-utils/src");
const { startDevServer, stopDevServer } = require("./dev-server");

function check(status, name, message) {
  return { status, name, message };
}

function suiteHas(config, suiteName, capability) {
  const suite = config.suites[suiteName] || [];
  return suite.includes(capability) || suite.includes("release");
}

async function runProductSuite(productKey, suiteName = "smoke", options = {}) {
  const manifest = loadProductManifest(productKey);
  const config = resolveProductConfig(manifest, options.environment || "local");
  const startedAt = Date.now();
  const devServer = await startDevServer(config, options);
  const checks = [];
  let browserResult = { checks: [], consoleErrors: [], networkFailures: [], screenshots: [] };

  try {
    if (!config.suites[suiteName]) {
      checks.push(check("failed", "suite selection", `Suite "${suiteName}" is not defined for ${config.key}.`));
    } else {
      checks.push(check("passed", "suite selection", `Loaded ${suiteName} suite for ${config.name}.`));
    }
    if (devServer?.checks?.length) checks.push(...devServer.checks);

    browserResult = await runBrowserSmoke(config, {
      ...options,
      collectAccessibility: suiteHas(config, suiteName, "accessibility"),
    });
    checks.push(...browserResult.checks);
    if (suiteHas(config, suiteName, "visual")) {
      const visualResult = runVisualRegression(config, browserResult.screenshots, options);
      checks.push(...visualResult.checks);
    }

    if (suiteHas(config, suiteName, "api")) {
      const apiResult = await runApiChecks(config, options);
      checks.push(...apiResult.checks);
    }

    if (suiteHas(config, suiteName, "firebase")) {
      const firebaseResult = await runFirebaseChecks(config, options);
      checks.push(...firebaseResult.checks);
    }

    if (suiteHas(config, suiteName, "performance")) {
      const performanceResult = await runPerformanceChecks(browserResult, config, options);
      checks.push(...performanceResult.checks);
    }

    if (suiteHas(config, suiteName, "accessibility")) {
      const accessibilityResult = browserResult.accessibilityResult?.checks?.length
        ? browserResult.accessibilityResult
        : await runAccessibilityChecks(config, options);
      checks.push(...accessibilityResult.checks);
    }

    if (suiteHas(config, suiteName, "security")) {
      const securityResult = await runSecurityChecks(browserResult, config, options);
      checks.push(...securityResult.checks);
    }

    if (suiteHas(config, suiteName, "ai")) {
      const aiResult = await runAiChecks(config, options);
      checks.push(...aiResult.checks);
    }

    if (suiteHas(config, suiteName, "mobile")) {
      const mobileResult = runMobileChecks(config, options);
      checks.push(...mobileResult.checks);
    }
  } finally {
    await stopDevServer(devServer);
  }

  return {
    productKey: config.key,
    productName: config.name,
    suite: suiteName,
    environment: config.environment,
    baseUrl: config.resolvedBaseUrl,
    durationMs: durationMs(startedAt),
    checks,
    artifacts: {
      screenshots: browserResult.screenshots || [],
      consoleErrors: browserResult.consoleErrors || [],
      networkFailures: browserResult.networkFailures || [],
      accessibilityViolations: browserResult.accessibilityResult?.violations || [],
      devServerLogs: devServer?.logs || [],
    },
  };
}

async function runAllProducts(options = {}) {
  const productKeys = options.all ? listProductKeys() : [options.product];
  if (!productKeys.length || productKeys.some((key) => !key)) {
    throw new Error("No product selected. Use --product <key> or --all.");
  }

  loadEnvFile();
  const startedAt = Date.now();
  const startedAtIso = nowIso();
  const results = [];

  for (const productKey of productKeys) {
    log(`Running ${options.suite || "smoke"} suite for ${productKey}...`);
    results.push(await runProductSuite(productKey, options.suite || "smoke", options));
  }

  return writeReports({
    suite: options.suite || "smoke",
    environment: options.environment || "local",
    startedAt: startedAtIso,
    durationMs: durationMs(startedAt),
    results,
  });
}

module.exports = {
  loadProductManifest,
  resolveProductConfig,
  runAllProducts,
  runProductSuite,
  suiteHas,
};
