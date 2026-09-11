const { spawnCommand, terminateProcessTree } = require("../../../packages/qa-utils/src");

const children = [];
let shuttingDown = false;

function start(label, command, args, options = {}) {
  const child = spawnCommand(command, args, {
    cwd: options.cwd || process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  const forward = (source, chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      process[source].write(`[${label}] ${line}\n`);
    }
  };
  child.stdout.on("data", (chunk) => forward("stdout", chunk));
  child.stderr.on("data", (chunk) => forward("stderr", chunk));
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      shutdown();
      process.exitCode = code || (signal ? 1 : 0);
    }
  });
}

function shutdown() {
  shuttingDown = true;
  for (const child of children) {
    if (child.killed) continue;
    terminateProcessTree(child);
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(130);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(143);
});

start("api", "pnpm", ["dev:api"]);
start("web", "npm", ["run", "dev", "--", "--host", "localhost", "--port", "5173"], {
  cwd: `${process.cwd()}\\apps\\web`,
});
