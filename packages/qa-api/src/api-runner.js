function check(status, name, message, extra = {}) {
  return { status, name, message, ...extra };
}

function resolveEndpointUrl(endpoint, config) {
  if (endpoint.urlEnvKey && process.env[endpoint.urlEnvKey]) return process.env[endpoint.urlEnvKey];
  const rawUrl = endpoint.url || endpoint.path || "";
  const baseUrl = endpoint.baseUrl || config.api?.baseUrl?.[config.environment] || config.api?.baseUrl?.local || config.resolvedBaseUrl;
  if (!rawUrl) return "";
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  return `${baseUrl.replace(/\/$/, "")}/${rawUrl.replace(/^\//, "")}`;
}

async function readResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  return response.text();
}

function hasExpectedShape(body, expectedShape = {}) {
  if (!expectedShape || Object.keys(expectedShape).length === 0) return true;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return Object.entries(expectedShape).every(([key, expectedType]) => {
    if (!(key in body)) return false;
    return expectedType === "any" || typeof body[key] === expectedType;
  });
}

async function runApiChecks(config, options = {}) {
  const endpoints = config.api?.healthChecks || [];
  const checks = [];

  if (options.dryRun) {
    checks.push(check("passed", "api dry run", `Would evaluate ${endpoints.length} API health check(s).`));
    return { checks };
  }

  if (!config.api?.enabled || endpoints.length === 0) {
    checks.push(check("skipped", "api health", "No API health checks configured."));
    return { checks };
  }

  for (const endpoint of endpoints) {
    const startedAt = Date.now();
    const url = resolveEndpointUrl(endpoint, config);
    if (!url) {
      checks.push(check(endpoint.required === false ? "skipped" : "failed", `api ${endpoint.name}`, `No URL configured. Set ${endpoint.urlEnvKey || "endpoint.url"}.`));
      continue;
    }

    if (endpoint.enabled === false) {
      checks.push(check("skipped", `api ${endpoint.name}`, "Endpoint is registered but disabled."));
      continue;
    }

    try {
      const response = await fetch(url, { method: endpoint.method || "GET" });
      const latencyMs = Date.now() - startedAt;
      const expectedStatus = endpoint.expectedStatus || 200;
      const statusOk = response.status === expectedStatus;
      let shapeOk = true;
      if (statusOk && endpoint.expectedJsonShape) {
        shapeOk = hasExpectedShape(await readResponse(response), endpoint.expectedJsonShape);
      }

      if (!statusOk) {
        checks.push(check("failed", `api ${endpoint.name}`, `${url} returned ${response.status}; expected ${expectedStatus}.`, { latencyMs }));
      } else if (!shapeOk) {
        checks.push(check("failed", `api ${endpoint.name}`, `${url} returned ${response.status}, but response shape did not match expectedJsonShape.`, { latencyMs }));
      } else {
        checks.push(check("passed", `api ${endpoint.name}`, `${url} returned ${response.status} in ${latencyMs}ms.`, { latencyMs }));
      }
    } catch (error) {
      checks.push(check("failed", `api ${endpoint.name}`, error.message));
    }
  }

  return { checks };
}

module.exports = {
  resolveEndpointUrl,
  runApiChecks,
};
