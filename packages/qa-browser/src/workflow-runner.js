const path = require("path");
const { chromium } = require("playwright");
const { ensureDir, fromRoot } = require("../../qa-utils/src");
const { seriousConsoleMessage, tryLogin } = require("./smoke-runner");

function check(status, name, message, extra = {}) {
  return { status, name, message, ...extra };
}

function workflowConfig(config, suiteName = "workflow") {
  const workflow = config.browserWorkflows?.[suiteName] || config.browserWorkflows?.workflow;
  if (!workflow) return null;
  if (typeof workflow === "string") return { path: workflow };
  return workflow;
}

function loadWorkflowModule(config, suiteName) {
  const workflow = workflowConfig(config, suiteName);
  if (!workflow?.path) return null;
  const workflowPath = path.isAbsolute(workflow.path) ? workflow.path : fromRoot(workflow.path);
  return { workflow, workflowPath, module: require(workflowPath) };
}

async function waitForAny(page, selectors = [], options = {}) {
  const timeout = options.timeout || 10000;
  for (const selector of selectors.filter(Boolean)) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: "visible", timeout });
      return { selector, locator };
    } catch (_error) {
      // Try the next selector.
    }
  }
  throw new Error(`None of the expected selectors became visible at ${page.url()}: ${selectors.join(", ")}`);
}

async function assertVisible(page, selectors, label, options = {}) {
  const found = await waitForAny(page, Array.isArray(selectors) ? selectors : [selectors], options);
  return check("passed", label, `Found ${found.selector}.`);
}

async function clickFirstVisible(page, selectors, label, options = {}) {
  const found = await waitForAny(page, Array.isArray(selectors) ? selectors : [selectors], options);
  await found.locator.click({ timeout: options.timeout || 10000 });
  return check("passed", label, `Opened ${found.selector}.`);
}

async function gotoPath(page, config, routePath, options = {}) {
  const url = new URL(routePath, config.resolvedBaseUrl).toString();
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeout || 20000 });
  await page.waitForLoadState("networkidle", { timeout: options.networkIdleTimeout || 10000 }).catch(() => null);
  const status = response?.status() || 0;
  return status >= 200 && status < 400
    ? check("passed", `route ${routePath}`, `${url} returned ${status}.`)
    : check("failed", `route ${routePath}`, `${url} returned ${status}.`);
}

async function safeScreenshot(page, config, name, screenshots, options = {}) {
  const screenshotDir = ensureDir(fromRoot("screenshots", "current", config.key));
  const screenshotPath = path.join(screenshotDir, `${config.key}-${name}.png`);
  await page.screenshot({
    path: screenshotPath,
    fullPage: options.fullPage !== false,
    mask: options.maskSelectors ? options.maskSelectors.map((selector) => page.locator(selector)) : [],
  });
  screenshots.push(screenshotPath);
  return check("passed", `safe screenshot ${name}`, "Captured safe workflow screenshot.", { artifact: screenshotPath });
}

async function runBrowserWorkflow(config, options = {}) {
  const checks = [];
  const consoleErrors = [];
  const networkFailures = [];
  const screenshots = [];
  const suiteName = options.suite || "workflow";

  if (options.dryRun) {
    checks.push(check("passed", "workflow dry run", `Would run ${suiteName} workflow for ${config.name}.`));
    return { checks, consoleErrors, networkFailures, screenshots };
  }

  const loaded = loadWorkflowModule(config, suiteName);
  if (!loaded) {
    checks.push(check("failed", "workflow config", `No browser workflow configured for suite "${suiteName}".`));
    return { checks, consoleErrors, networkFailures, screenshots };
  }
  if (typeof loaded.module.runWorkflow !== "function") {
    checks.push(check("failed", "workflow module", `${loaded.workflowPath} must export runWorkflow().`));
    return { checks, consoleErrors, networkFailures, screenshots };
  }

  const browser = await chromium.launch({ headless: options.headless !== false });
  const context = await browser.newContext({
    viewport: options.viewport || { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  page.on("console", (message) => {
    if (seriousConsoleMessage(message)) {
      consoleErrors.push({ type: message.type(), text: message.text() });
    }
  });

  page.on("requestfailed", (request) => {
    const url = request.url();
    const failure = request.failure()?.errorText || "request failed";
    const resourceType = request.resourceType();
    if (failure === "net::ERR_ABORTED" && ["media", "image", "font"].includes(resourceType)) return;
    const ignored = (config.browser?.ignoreNetworkFailurePatterns || []).some((pattern) => new RegExp(pattern).test(url));
    if (!ignored) networkFailures.push({ url, method: request.method(), resourceType, failure });
  });

  const helpers = {
    assertVisible,
    check,
    clickFirstVisible,
    gotoPath,
    safeScreenshot: (name, screenshotOptions) => safeScreenshot(page, config, name, screenshots, screenshotOptions),
    tryLogin,
    waitForAny,
  };

  try {
    checks.push(...(await loaded.module.runWorkflow({ page, config, options, helpers })));
    checks.push(consoleErrors.length === 0 ? check("passed", "workflow console errors", "No serious console errors captured.") : check("failed", "workflow console errors", `${consoleErrors.length} serious console error(s) captured.`));
    checks.push(networkFailures.length === 0 ? check("passed", "workflow network failures", "No failed network requests captured.") : check("failed", "workflow network failures", `${networkFailures.length} failed network request(s) captured.`));
  } catch (error) {
    checks.push(check("failed", "workflow", error.message));
  } finally {
    await browser.close();
  }

  return { checks, consoleErrors, networkFailures, screenshots };
}

module.exports = {
  runBrowserWorkflow,
};
