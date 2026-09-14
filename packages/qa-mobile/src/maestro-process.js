const {
  spawnCommand,
  spawnCommandSync,
  terminateProcessTree,
} = require("../../qa-utils/src/process-launcher");
const { resolveTool } = require("../../qa-core/src/tool-resolver");

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
  terminateImplementation = terminateProcessTree,
  resolveImplementation = null,
) {
  const isDefaultImplementation = spawnImplementation === spawnCommand && spawnSyncImplementation === spawnCommandSync;
  const resolveCommand = resolveImplementation || (isDefaultImplementation
    ? (environment) => resolveTool("maestro", environment).path || MAESTRO_COMMAND
    : () => MAESTRO_COMMAND);
  return {
    spawnMaestro(args, options = {}) {
      validateArgs(args);
      return spawnImplementation(resolveCommand(options.env || process.env), args, options);
    },
    spawnMaestroSync(args, options = {}) {
      validateArgs(args);
      return spawnSyncImplementation(resolveCommand(options.env || process.env), args, options);
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
