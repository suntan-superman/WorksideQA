const { spawn } = require("child_process");
const { fileExists, log, warn } = require("../../qa-utils/src");

async function waitForUrl(url, timeoutMs = 30000, perAttemptTimeoutMs = 1500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), perAttemptTimeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status < 500) return true;
    } catch (_error) {
      // Retry until the overall timeout expires.
    } finally {
      clearTimeout(timeout);
    }
    if (Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return false;
}

async function startDevServer(config, options) {
  const devServer = config.devServer;
  if (!options.startServer || !devServer?.enabled) return null;
  const logs = [];

  if (!fileExists(devServer.workingDirectory)) {
    warn(`Dev server directory not found for ${config.key}: ${devServer.workingDirectory}`);
    return {
      child: null,
      started: false,
      healthy: false,
      logs,
      checks: [{ status: "failed", name: "dev server directory", message: `Directory not found: ${devServer.workingDirectory}` }],
    };
  }

  const ready = await waitForUrl(devServer.healthUrl, 1500);
  if (ready) {
    log(`Dev server already reachable for ${config.key}: ${devServer.healthUrl}`);
    return {
      child: null,
      started: false,
      healthy: true,
      logs,
      checks: [{ status: "passed", name: "dev server", message: `Already healthy: ${devServer.healthUrl}` }],
    };
  }

  log(`Starting ${config.key} dev server: ${devServer.command}`);
  const child = spawn(devServer.command, {
    cwd: devServer.workingDirectory,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const capture = (source, chunk) => {
    const text = chunk.toString();
    logs.push(
      ...text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `[${source}] ${line}`)
    );
    if (logs.length > 80) logs.splice(0, logs.length - 80);
  };

  child.stdout?.on("data", (chunk) => capture("stdout", chunk));
  child.stderr?.on("data", (chunk) => capture("stderr", chunk));

  let exitInfo = null;
  child.once("exit", (code, signal) => {
    exitInfo = { code, signal };
    logs.push(`[process] exited with code ${code}${signal ? ` and signal ${signal}` : ""}`);
  });

  const healthy = await waitForUrl(devServer.healthUrl, options.devServerTimeoutMs || devServer.healthTimeoutMs || 45000);
  if (!healthy) {
    warn(`Dev server did not become healthy: ${devServer.healthUrl}`);
  }

  const checks = [
    healthy
      ? { status: "passed", name: "dev server", message: `Healthy at ${devServer.healthUrl}` }
      : {
          status: "failed",
          name: "dev server",
          message: `Did not become healthy at ${devServer.healthUrl}${exitInfo ? `; process exited with code ${exitInfo.code}` : ""}.`,
        },
  ];

  return { child, started: true, healthy, logs, checks };
}

async function stopDevServer(server) {
  const child = server?.child || server;
  if (!child || child.killed) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  child.kill();
}

module.exports = {
  startDevServer,
  stopDevServer,
  waitForUrl,
};
