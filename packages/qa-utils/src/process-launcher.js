const crossSpawn = require("cross-spawn");

function validateInvocation(command, args) {
  if (typeof command !== "string" || !command.trim()) {
    throw new TypeError("Process command must be a non-empty string.");
  }
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new TypeError("Process arguments must be an array of strings.");
  }
}

function createProcessLauncher(spawnImplementation = crossSpawn, spawnSyncImplementation = crossSpawn.sync) {
  return {
    spawnCommand(command, args = [], options = {}) {
      validateInvocation(command, args);
      return spawnImplementation(command, args, options);
    },
    spawnCommandSync(command, args = [], options = {}) {
      validateInvocation(command, args);
      return spawnSyncImplementation(command, args, options);
    },
    terminateProcessTree(child, signal = "SIGTERM") {
      if (!child || !Number.isInteger(child.pid)) return false;
      if (process.platform !== "win32") return child.kill(signal);

      const killer = spawnImplementation("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => child.kill(signal));
      return true;
    },
  };
}

const { spawnCommand, spawnCommandSync, terminateProcessTree } = createProcessLauncher();

module.exports = {
  createProcessLauncher,
  spawnCommand,
  spawnCommandSync,
  terminateProcessTree,
  validateInvocation,
};
