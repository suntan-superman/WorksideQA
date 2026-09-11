const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const {
  createMaestroProcessHelper,
  spawnMaestroSync,
} = require("../src/maestro-process");
const { runProcess } = require("../src/maestro-runner");

(async () => {
const calls = [];
const fakeSpawn = (command, args, options) => {
  calls.push({ kind: "async", command, args, options });
  return { fake: true };
};
const fakeSpawnSync = (command, args, options) => {
  calls.push({ kind: "sync", command, args, options });
  return { status: 0 };
};
const portable = createMaestroProcessHelper(fakeSpawn, fakeSpawnSync);
const preservedArgs = ["test", "folder with spaces/flow.yaml", "--device", "emulator-5554"];
const preservedOptions = { cwd: "working directory", env: { SENTINEL: "preserved" }, stdio: "pipe", timeout: 321 };
portable.spawnMaestro(preservedArgs, preservedOptions);
portable.spawnMaestroSync(["--version"], preservedOptions);
assert.deepEqual(calls[0], { kind: "async", command: "maestro", args: preservedArgs, options: preservedOptions });
assert.deepEqual(calls[1], { kind: "sync", command: "maestro", args: ["--version"], options: preservedOptions });
assert.throws(() => portable.spawnMaestro(["test", 123]), /array of strings/);

if (process.platform === "win32") {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "worksideqa maestro "));
  const capturePath = path.join(fixtureDirectory, "captured arguments.json");
  const fixtureScript = path.join(fixtureDirectory, "fake maestro.js");
  const fixtureBatch = path.join(fixtureDirectory, "maestro.bat");
  fs.writeFileSync(fixtureScript, `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.10.0"); process.exit(0); }
if (args[0] === "exit") process.exit(Number(args[1]));
if (args[0] === "hang") setInterval(() => {}, 1000);
fs.writeFileSync(process.env.MAESTRO_CAPTURE_PATH, JSON.stringify(args));
`, "utf8");
  fs.writeFileSync(fixtureBatch, `@echo off\r\n"${process.execPath}" "${fixtureScript}" %*\r\n`, "utf8");

  const environment = {
    ...process.env,
    PATH: `${fixtureDirectory}${path.delimiter}${process.env.PATH || ""}`,
    MAESTRO_CAPTURE_PATH: capturePath,
  };
  const version = spawnMaestroSync(["--version"], { cwd: fixtureDirectory, env: environment, encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), "2.10.0");

  const windowsArgs = ["test", path.join(fixtureDirectory, "flow path with spaces.yaml"), "--device", "emulator-5554"];
  const execution = spawnMaestroSync(windowsArgs, { cwd: fixtureDirectory, env: environment, encoding: "utf8" });
  assert.equal(execution.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(capturePath, "utf8")), windowsArgs);

  const failed = spawnMaestroSync(["exit", "23"], { cwd: fixtureDirectory, env: environment, encoding: "utf8" });
  assert.equal(failed.status, 23);

  const timedOut = await runProcess("maestro", ["hang"], {
    cwd: fixtureDirectory,
    env: environment,
    logStream: new PassThrough(),
    secretValues: [],
    timeoutMs: 75,
  });
  assert.equal(timedOut.timedOut, true);
  assert.notEqual(timedOut.signal, undefined);
}

console.log("Portable Maestro process execution contract verified.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
