const { spawnSync } = require("child_process");
const path = require("path");
const { fileExists, fromRoot } = require("../../qa-utils/src");

function check(status, name, message) {
  return { status, name, message };
}

function runMobileChecks(config, options = {}) {
  const flows = config.mobile?.flows || [];
  const pushNotifications = config.mobile?.pushNotifications;

  if (options.dryRun) {
    return { checks: [check("passed", "mobile dry run", `Would inspect Maestro availability, ${flows.length} flow(s), and push notification readiness.`)] };
  }

  if (!config.mobile?.enabled) {
    return { checks: [check("skipped", "mobile", "Mobile testing is not enabled for this product.")] };
  }

  const checks = [];
  const maestro = spawnSync("maestro", ["--version"], { encoding: "utf8" });
  if (maestro.error || maestro.status !== 0) {
    checks.push(check("skipped", "maestro", "Maestro is not installed or not on PATH."));
  } else if (flows.length === 0) {
    checks.push(check("skipped", "maestro flows", "No Maestro flows are configured."));
  } else {
    for (const flow of flows) {
      const flowPath = path.isAbsolute(flow.path) ? flow.path : fromRoot(flow.path);
      if (!fileExists(flowPath)) {
        checks.push(check("failed", `maestro ${flow.name}`, `Flow file not found: ${flowPath}`));
        continue;
      }

      if (flow.runByDefault === false) {
        checks.push(check("skipped", `maestro ${flow.name}`, "Flow is registered but not run by default."));
        continue;
      }

      const result = spawnSync("maestro", ["test", flowPath], { encoding: "utf8" });
      checks.push(result.status === 0 ? check("passed", `maestro ${flow.name}`, "Flow completed.") : check("failed", `maestro ${flow.name}`, result.stderr || result.stdout || "Flow failed."));
    }
  }

  if (!pushNotifications?.enabled) {
    checks.push(check("skipped", "push notifications", "Push notification checks are not enabled for this product."));
  } else if (!pushNotifications.testTokenEnvKey || !process.env[pushNotifications.testTokenEnvKey]) {
    checks.push(check("skipped", "push notifications", `Set ${pushNotifications.testTokenEnvKey || "a test token env key"} to run push notification checks.`));
  } else {
    checks.push(check("skipped", "push notifications", "Push token is configured; provider send simulation requires a product-specific adapter."));
  }

  return { checks };
}

module.exports = {
  runMobileChecks,
};
