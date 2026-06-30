const { AxeBuilder } = require("@axe-core/playwright");

function check(status, name, message) {
  return { status, name, message };
}

async function runAccessibilityChecks(config, options = {}, page = null) {
  if (options.dryRun) {
    return { checks: [check("passed", "accessibility dry run", "Would run Axe accessibility checks.")] };
  }

  if (!config.accessibility?.enabled) {
    return { checks: [check("skipped", "accessibility", "Accessibility checks are not enabled for this product.")] };
  }

  if (!page) {
    return { checks: [check("skipped", "accessibility axe", "Axe requires an active Playwright page.")] };
  }

  const tags = config.accessibility.tags || ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
  const result = await new AxeBuilder({ page }).withTags(tags).analyze();
  const violations = result.violations || [];

  return {
    checks: [
      violations.length === 0
        ? check("passed", "accessibility axe", `No Axe violations found for tags: ${tags.join(", ")}.`)
        : check("failed", "accessibility axe", `${violations.length} Axe violation(s): ${violations.map((item) => item.id).join(", ")}.`),
    ],
    violations,
  };
}

module.exports = {
  runAccessibilityChecks,
};
