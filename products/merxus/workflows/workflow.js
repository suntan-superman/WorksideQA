async function verifyArea({ page, config, helpers, area }) {
  const failures = [];
  for (const routePath of area.routes || []) {
    const routeCheck = await helpers.gotoPath(page, config, routePath, { timeout: 25000 });
    if (routeCheck.status === "failed") {
      failures.push(routeCheck.message);
      continue;
    }
    try {
      await helpers.waitForAny(page, area.selectors || [], { timeout: area.timeoutMs || 15000 });
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

  checks.push(await helpers.gotoPath(page, config, workflow.publicRoute || "/", { timeout: 25000 }));
  checks.push(await helpers.assertVisible(page, workflow.publicSelectors || ["body"], "workflow public landing"));
  checks.push(await helpers.safeScreenshot("workflow-public-landing", workflow.safeScreenshot || {}));

  const loginCheck = await helpers.tryLogin(page, config);
  checks.push(loginCheck);
  if (loginCheck.status !== "passed") return checks;
  checks.push(await helpers.gotoPath(page, config, workflow.dashboardRoute || "/merxus", { timeout: 30000 }));
  checks.push(await helpers.assertVisible(page, workflow.dashboardSelectors || ["main", "body"], "workflow dashboard", { timeout: 20000 }));

  for (const area of workflow.areas || []) {
    checks.push(await verifyArea({ page, config, helpers, area }));
  }

  return checks;
}

module.exports = {
  runWorkflow,
};
