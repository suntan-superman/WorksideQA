function check(status, name, message, extra = {}) {
  return { status, name, message, ...extra };
}

async function runPerformanceChecks(browserResult, config) {
  const checks = [];
  const maxNetworkFailures = config.performance?.maxNetworkFailures ?? 0;
  const networkFailures = browserResult.networkFailures?.length || 0;

  checks.push(
    networkFailures <= maxNetworkFailures
      ? check("passed", "network reliability budget", `${networkFailures} failed requests within budget ${maxNetworkFailures}.`)
      : check("failed", "network reliability budget", `${networkFailures} failed requests exceeds budget ${maxNetworkFailures}.`)
  );

  if (!config.performance?.enabled) {
    checks.push(check("skipped", "core web vitals", "Detailed performance collection is not configured yet."));
  }

  return { checks };
}

module.exports = {
  runPerformanceChecks,
};

