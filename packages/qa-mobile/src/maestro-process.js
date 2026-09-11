const crossSpawn = require("cross-spawn");

const MAESTRO_COMMAND = "maestro";

function validateArgs(args) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new TypeError("Maestro arguments must be an array of strings.");
  }
}

/**
 * Launch Maestro without opting the whole process into shell execution.
 *
 * cross-spawn keeps the native `maestro <args>` path on macOS/Linux and, on
 * Windows, resolves PATHEXT command shims such as maestro.bat and invokes them
 * through cmd.exe with escaped arguments. Its API mirrors child_process.spawn,
 * so cwd, env, stdio, timeout and AbortSignal options pass through unchanged.
 */
function createMaestroProcessHelper(spawnImplementation = crossSpawn, spawnSyncImplementation = crossSpawn.sync) {
  return {
    spawnMaestro(args, options = {}) {
      validateArgs(args);
      return spawnImplementation(MAESTRO_COMMAND, args, options);
    },
    spawnMaestroSync(args, options = {}) {
      validateArgs(args);
      return spawnSyncImplementation(MAESTRO_COMMAND, args, options);
    },
    terminateMaestro(child, signal = "SIGTERM") {
      if (!child || !Number.isInteger(child.pid)) return false;
      if (process.platform !== "win32") return child.kill(signal);

      // A .bat launch has a cmd.exe parent. taskkill /T prevents its Java/CLI
      // descendant from surviving a timeout or Ctrl+C after the wrapper exits.
      const killer = spawnImplementation("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => child.kill(signal));
      return true;
    },
  };
}

const { spawnMaestro, spawnMaestroSync, terminateMaestro } = createMaestroProcessHelper();

module.exports = {
  MAESTRO_COMMAND,
  createMaestroProcessHelper,
  spawnMaestro,
  spawnMaestroSync,
  terminateMaestro,
};
