const {
  spawnCommand,
  spawnCommandSync,
  terminateProcessTree,
} = require("../../qa-utils/src/process-launcher");

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
function createMaestroProcessHelper(
  spawnImplementation = spawnCommand,
  spawnSyncImplementation = spawnCommandSync,
  terminateImplementation = terminateProcessTree
) {
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
      return terminateImplementation(child, signal);
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
