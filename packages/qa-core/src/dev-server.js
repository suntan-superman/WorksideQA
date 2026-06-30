const { spawn } = require("child_process");
const { fileExists, log, warn } = require("../../qa-utils/src");

async function waitForUrl(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return true;
    } catch (_error) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return false;
}

async function startDevServer(config, options) {
  const devServer = config.devServer;
  if (!options.startServer || !devServer?.enabled) return null;

  if (!fileExists(devServer.workingDirectory)) {
    warn(`Dev server directory not found for ${config.key}: ${devServer.workingDirectory}`);
    return null;
  }

  const ready = await waitForUrl(devServer.healthUrl, 1500);
  if (ready) {
    log(`Dev server already reachable for ${config.key}: ${devServer.healthUrl}`);
    return null;
  }

  log(`Starting ${config.key} dev server: ${devServer.command}`);
  const child = spawn(devServer.command, {
    cwd: devServer.workingDirectory,
    shell: true,
    stdio: "ignore",
    detached: false,
  });

  const healthy = await waitForUrl(devServer.healthUrl, options.devServerTimeoutMs || 45000);
  if (!healthy) {
    warn(`Dev server did not become healthy: ${devServer.healthUrl}`);
  }

  return child;
}

async function stopDevServer(child) {
  if (!child || child.killed) return;
  child.kill();
}

module.exports = {
  startDevServer,
  stopDevServer,
  waitForUrl,
};

