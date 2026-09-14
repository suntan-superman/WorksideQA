const {
  spawnCommand,
  spawnCommandSync,
  terminateProcessTree,
} = require("../../qa-utils/src/process-launcher");
const { fromRoot } = require("../../qa-utils/src");
const { acquireObserverLock } = require("../../qa-utils/src/observer-lock");
const { resolveTool } = require("../../qa-core/src/tool-resolver");

const MAESTRO_COMMAND = "maestro";
const OBSERVER_LOCK_PATH = fromRoot('.worksideqa', 'maestro-observer.lock');

function isObserverInvocation(args) {
  return Array.isArray(args) && args.some((argument) => ["test", "hierarchy", "screenshot"].includes(argument));
}

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

/**
 * Serialize direct synchronous Maestro observer commands (for example the
 * release runner or legacy mobile runner) with the rendered-runtime probe.
 * Version checks intentionally remain lock-free because they do not register
 * UiAutomation. Callers receive OBSERVER_BUSY rather than racing a live
 * observer session.
 */
function spawnMaestroSyncExclusive(args, options = {}) {
  validateArgs(args);
  if (options.serializeMaestro === false || !isObserverInvocation(args)) {
    return spawnMaestroSync(args, options);
  }
  const lockPath = options.observerLockPath || OBSERVER_LOCK_PATH;
  const lock = acquireObserverLock(lockPath, {
    product: options.product || null,
    deviceId: options.deviceId || null,
    stage: options.stage || 'synchronous-observer',
    command: 'maestro',
  });
  if (!lock.ok) throw lock.error || new Error('Maestro observer is busy.');
  try {
    return spawnMaestroSync(args, options);
  } finally {
    lock.release();
  }
}

module.exports = {
  MAESTRO_COMMAND,
  createMaestroProcessHelper,
  spawnMaestro,
  spawnMaestroSync,
  spawnMaestroSyncExclusive,
  terminateMaestro,
};
