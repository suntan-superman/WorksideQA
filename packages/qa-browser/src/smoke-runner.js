const path = require("path");
const { chromium } = require("playwright");
const { runAccessibilityChecks } = require("../../qa-accessibility/src");
const { ensureDir, fromRoot } = require("../../qa-utils/src");

function check(status, name, message, extra = {}) {
  return { status, name, message, ...extra };
}

function seriousConsoleMessage(message) {
  const text = message.text();
  if (message.type() !== "error") return false;
  return !/favicon|ResizeObserver loop|Non-Error promise rejection/i.test(text);
}

async function tryLogin(page, config) {
  const auth = config.auth || {};
  const email = process.env[auth.demoUserEnvKey];
  const password = process.env[auth.demoPasswordEnvKey];
  if (!auth.strategy || auth.strategy === "none") {
    return check("skipped", "login", "No login strategy configured.");
  }

  if (!email || !password) {
    return check("skipped", "login", `Missing ${auth.demoUserEnvKey} or ${auth.demoPasswordEnvKey}.`);
  }

  const emailSelector = auth.selectors?.email || 'input[type="email"], input[name="email"], input[autocomplete="email"]';
  const passwordSelector = auth.selectors?.password || 'input[type="password"], input[name="password"]';
  const submitSelector = auth.selectors?.submit || 'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")';

  try {
    if (auth.loginPath) {
      await page.goto(new URL(auth.loginPath, config.resolvedBaseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);
    }

    if (auth.selectors?.mode) {
      await page.locator(auth.selectors.mode).first().click({ timeout: 6000 });
    }

    await page.locator(emailSelector).first().fill(email, { timeout: 6000 });
    if (auth.strategy === "email-password") {
      await page.locator(passwordSelector).first().fill(password, { timeout: 6000 });
    }

    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null),
      page.locator(submitSelector).first().click({ timeout: 6000 }),
    ]);

    if (auth.strategy === "demo-email-code") {
      return check("passed", "login", "Demo email login request submitted.");
    }

    return check("passed", "login", "Demo credentials submitted.");
  } catch (error) {
    return check("failed", "login", `Could not complete generic login flow: ${error.message}`);
  }
}

async function runBrowserSmoke(config, options = {}) {
  const checks = [];
  const consoleErrors = [];
  const networkFailures = [];
  const screenshots = [];
  let accessibilityResult = { checks: [] };
  const screenshotDir = ensureDir(fromRoot("screenshots", "current", config.key));

  if (options.dryRun) {
    checks.push(check("passed", "browser dry run", `Would open ${config.resolvedBaseUrl}.`));
    return { checks, consoleErrors, networkFailures, screenshots, accessibilityResult };
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
    if (!ignored) {
      networkFailures.push({ url, method: request.method(), resourceType, failure });
    }
  });

  try {
    const response = await page.goto(config.resolvedBaseUrl, { waitUntil: "domcontentloaded", timeout: options.timeoutMs || 30000 });
    const status = response?.status() || 0;
    checks.push(status >= 200 && status < 400 ? check("passed", "open app", `${config.resolvedBaseUrl} returned ${status}.`) : check("failed", "open app", `${config.resolvedBaseUrl} returned ${status}.`));

    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);
    const title = await page.title();
    checks.push(title ? check("passed", "page title", title) : check("warning", "page title", "No document title found."));

    const initialScreenshot = path.join(screenshotDir, `${config.key}-home.png`);
    await page.screenshot({ path: initialScreenshot, fullPage: true });
    screenshots.push(initialScreenshot);
    checks.push(check("passed", "screenshot", "Captured initial page screenshot.", { artifact: initialScreenshot }));

    if ((config.suites.smoke || []).includes("login")) {
      checks.push(await tryLogin(page, config));
      const loginScreenshot = path.join(screenshotDir, `${config.key}-after-login.png`);
      await page.screenshot({ path: loginScreenshot, fullPage: true });
      screenshots.push(loginScreenshot);
    }

    if (options.collectAccessibility) {
      accessibilityResult = await runAccessibilityChecks(config, options, page);
    }

    checks.push(consoleErrors.length === 0 ? check("passed", "console errors", "No serious console errors captured.") : check("failed", "console errors", `${consoleErrors.length} serious console error(s) captured.`));
    checks.push(networkFailures.length === 0 ? check("passed", "network failures", "No failed network requests captured.") : check("failed", "network failures", `${networkFailures.length} failed network request(s) captured.`));
  } catch (error) {
    checks.push(check("failed", "browser smoke", error.message));
  } finally {
    await browser.close();
  }

  return { checks, consoleErrors, networkFailures, screenshots, accessibilityResult };
}

module.exports = {
  runBrowserSmoke,
};
