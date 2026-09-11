const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const {
  createProcessLauncher,
  spawnCommandSync,
} = require("../src/process-launcher");
const { runProcess } = require("../../qa-mobile/src/maestro-runner");

(async () => {
  const calls = [];
  const portable = createProcessLauncher(
    (command, args, options) => {
      calls.push({ kind: "async", command, args, options });
      return { fake: true };
    },
    (command, args, options) => {
      calls.push({ kind: "sync", command, args, options });
      return { status: 0 };
    }
  );
  const args = ["run", "fixture:reset", "--", "--device", "Pixel Emulator", "path with spaces/file.json"];
  const options = { cwd: "directory with spaces", env: { SENTINEL: "preserved" }, timeout: 1234 };
  portable.spawnCommand("npm", args, options);
  portable.spawnCommandSync("firebase", ["--version"], options);
  assert.deepEqual(calls[0], { kind: "async", command: "npm", args, options });
  assert.deepEqual(calls[1], { kind: "sync", command: "firebase", args: ["--version"], options });

  if (process.platform !== "win32") {
    console.log("Native POSIX process-launch contract verified.");
    return;
  }

  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "worksideqa npm shim "));
  const capturePath = path.join(fixtureDirectory, "captured command.json");
  const fixtureScript = path.join(fixtureDirectory, "fake npm.js");
  const fixtureCommand = path.join(fixtureDirectory, "npm.cmd");
  try {
    fs.writeFileSync(fixtureScript, `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("10.9.0"); process.exit(0); }
fs.writeFileSync(process.env.PROCESS_CAPTURE_PATH, JSON.stringify({ args, cwd: process.cwd() }));
if (args.includes("hang")) setInterval(() => {}, 1000);
if (args.includes("fail")) { console.error("fixture reset failed"); process.exit(19); }
console.log(args.includes("verify") ? "backend verifier passed" : "fixture reset passed");
`, "utf8");
    fs.writeFileSync(fixtureCommand, `@"${process.execPath}" "${fixtureScript}" %*\r\n`, "utf8");
    const environment = {
      ...process.env,
      PATH: `${fixtureDirectory}${path.delimiter}${process.env.PATH || ""}`,
      PROCESS_CAPTURE_PATH: capturePath,
    };

    const version = spawnCommandSync("npm", ["--version"], { cwd: fixtureDirectory, env: environment, encoding: "utf8" });
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), "10.9.0");

    const syncArgs = ["run", "qa:maestro:reset", "--", "--source", path.join(fixtureDirectory, "path with spaces.json")];
    const syncResult = spawnCommandSync("npm", syncArgs, { cwd: fixtureDirectory, env: environment, encoding: "utf8" });
    assert.equal(syncResult.status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(capturePath, "utf8")), { args: syncArgs, cwd: fixtureDirectory });

    let output = "";
    const fixtureLog = new PassThrough();
    fixtureLog.on("data", (chunk) => { output += chunk.toString(); });
    const reset = await runProcess("npm", ["run", "qa:maestro:reset"], {
      cwd: fixtureDirectory, env: environment, logStream: fixtureLog, secretValues: [], timeoutMs: 2000,
    });
    assert.equal(reset.code, 0);
    assert.match(output, /fixture reset passed/);

    const failed = await runProcess("npm", ["run", "qa:maestro:reset", "--", "fail"], {
      cwd: fixtureDirectory, env: environment, logStream: new PassThrough(), secretValues: [], timeoutMs: 2000,
    });
    assert.equal(failed.code, 19);

    output = "";
    const verifierLog = new PassThrough();
    verifierLog.on("data", (chunk) => { output += chunk.toString(); });
    const verified = await runProcess("npm", ["run", "qa:maestro:verify", "--", "verify"], {
      cwd: fixtureDirectory, env: environment, logStream: verifierLog, secretValues: [], timeoutMs: 2000,
    });
    assert.equal(verified.code, 0);
    assert.match(output, /backend verifier passed/);

    const timedOut = await runProcess("npm", ["run", "qa:maestro:reset", "--", "hang"], {
      cwd: fixtureDirectory, env: environment, logStream: new PassThrough(), secretValues: [], timeoutMs: 75,
    });
    assert.equal(timedOut.timedOut, true);
  } finally {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }

  console.log("Windows command-shim fixture and verifier execution contract verified.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
