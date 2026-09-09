const { fileExists } = require("../../qa-utils/src");
const { hasFirebaseCredential } = require("./firebase-credentials");
const { listProductKeys, loadEnvFile, loadProductManifest, resolveProductConfig } = require("./manifest");

function check(status, name, message, extra = {}) {
  return { status, name, message, ...extra };
}

function suiteNeeds(config, capability, suiteName = null) {
  if (suiteName && Array.isArray(config.suites?.[suiteName])) {
    const suite = config.suites[suiteName];
    return suite.includes(capability) || suite.includes("release");
  }
  return Object.values(config.suites || {}).some((suite) => Array.isArray(suite) && suite.includes(capability));
}

function hasOpenAiKey() {
  return Boolean(process.env.OPENAI_API_KEY || process.env.OPENAI_KEY);
}

function dependencyGraph(config, options = {}) {
  const graph = {
    product: config.key,
    environment: config.environment,
    dependencies: [],
  };

  if (config.devServer?.enabled) {
    graph.dependencies.push({
      key: "web",
      type: "local-service",
      required: config.environment === "local",
      severity: config.environment === "local" ? "required" : "optional",
      healthUrl: config.devServer.healthUrl,
      command: config.devServer.command,
      workingDirectory: config.devServer.workingDirectory,
    });
  }

  if (config.auth?.strategy && config.auth.strategy !== "none") {
    graph.dependencies.push({
      key: "auth",
      type: "environment",
      required: true,
      severity: "required",
      envKeys: [config.auth.demoUserEnvKey, config.auth.demoPasswordEnvKey].filter(Boolean),
    });
  }

  for (const healthCheck of config.api?.healthChecks || []) {
    graph.dependencies.push({
      key: `api:${healthCheck.name || healthCheck.urlEnvKey || "health"}`,
      type: "url",
      required: healthCheck.required === true,
      severity: healthCheck.required === true ? "required" : "optional",
      urlEnvKey: healthCheck.urlEnvKey,
      expectedStatus: healthCheck.expectedStatus || 200,
    });
  }

  if (config.firebase?.enabled) {
    graph.dependencies.push({
      key: "firebase",
      type: "credential",
      required: false,
      severity: "optional",
      envKeys: ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_SERVICE_ACCOUNT_JSON", "FIREBASE_ACCESS_TOKEN"],
    });
  }

  if (config.ai?.enabled) {
    const requireAi = options.requireAi === true;
    graph.dependencies.push({
      key: "openai",
      type: "credential",
      required: requireAi,
      severity: requireAi ? "required" : "optional",
      envKeys: ["OPENAI_API_KEY", "OPENAI_KEY"],
    });
  }

  if (config.mobile?.pushNotifications?.enabled) {
    graph.dependencies.push({
      key: "push-token",
      type: "environment",
      required: false,
      severity: "optional",
      envKeys: [config.mobile.pushNotifications.testTokenEnvKey].filter(Boolean),
    });
  }

  return graph;
}

async function probeUrl(url, expectedStatus = 200, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { ok: response.status === expectedStatus, status: response.status };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function validateDependency(dependency, options = {}) {
  if (dependency.type === "local-service") {
    const checks = [
      fileExists(dependency.workingDirectory)
        ? check("passed", `${dependency.key} directory`, "Configured working directory exists.")
        : check(dependency.required ? "failed" : "warning", `${dependency.key} directory`, "Configured working directory was not found."),
    ];
    if (options.checkNetwork && dependency.healthUrl) {
      const result = await probeUrl(dependency.healthUrl, 200, options.timeoutMs);
      checks.push(
        result.ok
          ? check("passed", `${dependency.key} health`, `Health URL returned ${result.status}.`)
          : check(dependency.required ? "failed" : "warning", `${dependency.key} health`, `Health URL was not reachable or did not return 200.`)
      );
    }
    return checks;
  }

  if (dependency.type === "environment") {
    return dependency.envKeys.map((key) =>
      process.env[key]
        ? check("passed", `${dependency.key} env ${key}`, "Environment variable is set.")
        : check(dependency.required ? "failed" : "warning", `${dependency.key} env ${key}`, "Environment variable is missing.")
    );
  }

  if (dependency.type === "credential") {
    const available = dependency.key === "openai" ? hasOpenAiKey() : dependency.key === "firebase" ? hasFirebaseCredential(options.config) : false;
    return [
      available
        ? check("passed", `${dependency.key} credentials`, "At least one supported credential source is configured.")
        : check(dependency.required ? "failed" : "warning", `${dependency.key} credentials`, "No supported credential source is configured."),
    ];
  }

  if (dependency.type === "url") {
    const url = process.env[dependency.urlEnvKey];
    if (!url) {
      return [
        check(
          dependency.required ? "failed" : "warning",
          `${dependency.key} url`,
          `${dependency.urlEnvKey} is not configured.`
        ),
      ];
    }
    if (!options.checkNetwork) {
      return [check("passed", `${dependency.key} url`, `${dependency.urlEnvKey} is configured.`)];
    }
    const result = await probeUrl(url, dependency.expectedStatus, options.timeoutMs);
    return [
      result.ok
        ? check("passed", `${dependency.key} health`, `Health URL returned ${result.status}.`)
        : check(
            dependency.required ? "failed" : "warning",
            `${dependency.key} health`,
            `Health URL did not return expected status ${dependency.expectedStatus}.`
          ),
    ];
  }

  return [check("warning", dependency.key, `Unknown dependency type: ${dependency.type}.`)];
}

async function productEnvironmentHealth(productKey, options = {}) {
  const manifest = loadProductManifest(productKey);
  const config = resolveProductConfig(manifest, options.environment || "local");
  const graph = dependencyGraph(config, options);
  const checks = [];
  for (const dependency of graph.dependencies) {
    checks.push(...(await validateDependency(dependency, { ...options, config })));
  }
  return {
    productKey,
    productName: config.name,
    environment: config.environment,
    graph,
    checks,
    status: checks.some((item) => item.status === "failed") ? "FAIL" : checks.some((item) => item.status === "warning") ? "WARN" : "PASS",
  };
}

async function environmentHealth(options = {}) {
  loadEnvFile();
  const productKeys = options.all || !options.product ? listProductKeys() : [options.product];
  const products = [];
  for (const productKey of productKeys) {
    products.push(await productEnvironmentHealth(productKey, options));
  }
  const checks = products.flatMap((product) => product.checks);
  return {
    generatedAt: new Date().toISOString(),
    environment: options.environment || "local",
    products,
    counts: {
      passed: checks.filter((item) => item.status === "passed").length,
      failed: checks.filter((item) => item.status === "failed").length,
      warnings: checks.filter((item) => item.status === "warning").length,
      skipped: checks.filter((item) => item.status === "skipped").length,
    },
    status: checks.some((item) => item.status === "failed") ? "FAIL" : checks.some((item) => item.status === "warning") ? "WARN" : "PASS",
  };
}

module.exports = {
  dependencyGraph,
  environmentHealth,
  productEnvironmentHealth,
};
