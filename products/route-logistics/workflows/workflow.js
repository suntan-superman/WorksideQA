async function verifyArea({ page, config, helpers, area }) {
  const failures = [];
  for (const routePath of area.routes || ["/"]) {
    const routeCheck = await helpers.gotoPath(page, config, routePath, { timeout: 25000 });
    if (routeCheck.status === "failed") {
      failures.push(routeCheck.message);
      continue;
    }
    try {
      await helpers.waitForAny(page, area.selectors || ["body"], { timeout: area.timeoutMs || 12000 });
      return helpers.check("passed", `workflow ${area.name}`, `${area.name} area is reachable.`);
    } catch (error) {
      failures.push(`${routePath}: ${error.message}`);
    }
  }
  return helpers.check("failed", `workflow ${area.name}`, `${area.name} area was not reachable. ${failures.join(" ")}`);
}

async function runWorkflow({ page, config, helpers }) {
  const checks = [];
  const workflow = config.browserWorkflows?.workflow || {};

  const loginCheck = await helpers.tryLogin(page, config);
  checks.push(loginCheck);
  if (loginCheck.status === "failed") return checks;

  checks.push(await helpers.gotoPath(page, config, workflow.dashboardRoute || "/", { timeout: 30000 }));
  checks.push(await helpers.assertVisible(page, workflow.dashboardSelectors || ["body"], "workflow dashboard", { timeout: 20000 }));
  checks.push(await helpers.safeScreenshot("workflow-dashboard", workflow.safeScreenshot || {}));

  for (const area of workflow.areas || []) {
    checks.push(await verifyArea({ page, config, helpers, area }));
  }

  return checks;
}

module.exports = {
  runWorkflow,
};
