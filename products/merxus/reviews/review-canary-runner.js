#!/usr/bin/env node
const { spawnCommandSync } = require("../../../packages/qa-utils/src");
const fs = require("node:fs");
const path = require("node:path");
const config = require("./review-canary.config.json");

function parseArgs(argv) {
  const result = { suite: "smoke", execute: false, cleanup: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--execute") result.execute = true;
    else if (item === "--cleanup") result.cleanup = true;
    else if (item === "--suite" && argv[index + 1]) result.suite = argv[++index];
    else if (item === "--tenant" && argv[index + 1]) result.tenant = argv[++index];
    else if (item === "--backend" && argv[index + 1]) result.backend = argv[++index];
  }
  return result;
}

function runBackend(backendDirectory, args) {
  const executable = process.platform === "win32" ? "node.exe" : "node";
  const script = path.join(backendDirectory, "scripts", "run-review-qa.js");
  const result = spawnCommandSync(executable, [script, ...args], {
    cwd: backendDirectory,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  return result;
}

function parseResults(output) {
  return String(output || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("REVIEW_QA_RESULT_JSON="))
    .map((line) => JSON.parse(line.slice("REVIEW_QA_RESULT_JSON=".length)));
}

function artifactPaths() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.resolve(__dirname, "../../../artifacts/merxus/reviews");
  fs.mkdirSync(directory, { recursive: true });
  return {
    json: path.join(directory, `Merxus_Review_Canary_QA_${stamp}.json`),
    markdown: path.join(directory, `Merxus_Review_Canary_QA_${stamp}.md`),
  };
}

function writeEvidence({ options, commandArgs, results, exitCode, cleanupResults }) {
  const artifacts = artifactPaths();
  const payload = {
    createdAt: new Date().toISOString(),
    environment: process.env.MERXUS_ENV || "not-set",
    suite: options.suite,
    execute: options.execute,
    backendDirectory: options.backend || config.backendDirectory,
    commandArgs,
    exitCode,
    providerWritesAllowed: String(process.env.REVIEW_QA_ALLOW_PROVIDER_WRITES || "false").toLowerCase() === "true",
    externalNotificationsAllowed: String(process.env.REVIEW_QA_ALLOW_EXTERNAL_NOTIFICATIONS || "false").toLowerCase() === "true",
    results,
    cleanupResults,
  };
  fs.writeFileSync(artifacts.json, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const lines = [
    "# Merxus Review Canary QA Evidence",
    "",
    `- Created: ${payload.createdAt}`,
    `- Environment: ${payload.environment}`,
    `- Suite: ${payload.suite}`,
    `- Mode: ${payload.execute ? "execute" : "dry run"}`,
    `- Provider writes: ${payload.providerWritesAllowed ? "enabled (invalid for canary)" : "disabled"}`,
    `- External notifications: ${payload.externalNotificationsAllowed ? "allowlisted" : "disabled"}`,
    `- Exit code: ${exitCode}`,
    "",
    "## Scenarios",
    "",
    "| Scenario | Run ID | Status | Assertions | Cleanup |",
    "|---|---|---|---:|---|",
    ...results.map((result) => {
      const total = Number(result.assertionsPassed || 0) + Number(result.assertionsFailed || 0);
      const cleanup = cleanupResults.find((item) => item.runId === result.runId);
      return `| ${result.scenarioId || "unknown"} | ${result.runId || "—"} | ${result.status || (result.dryRun ? "dry-run" : "unknown")} | ${result.assertionsPassed || 0}/${total} | ${cleanup ? (cleanup.deleted == null ? "dry-run" : `deleted ${cleanup.deleted}`) : "not requested"} |`;
    }),
    "",
    "Live certification was not performed by this deterministic canary run.",
  ];
  fs.writeFileSync(artifacts.markdown, `${lines.join("\n")}\n`, "utf8");
  return artifacts;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = config.commands[options.suite];
  if (!command) throw new Error(`Unknown Merxus review suite: ${options.suite}`);
  const backendDirectory = options.backend || config.backendDirectory;
  const commandArgs = [...command];
  if (options.tenant) commandArgs.push("--tenant", options.tenant);
  if (options.execute) commandArgs.push("--execute");

  const run = runBackend(backendDirectory, commandArgs);
  const results = parseResults(run.stdout);
  const cleanupResults = [];
  if (options.cleanup && results.length) {
    for (const result of results.filter((item) => item.runId && !item.dryRun)) {
      const cleanup = runBackend(backendDirectory, ["cleanup", "--run-id", result.runId, "--execute"]);
      cleanupResults.push(...parseResults(cleanup.stdout));
      if (cleanup.status !== 0) run.status = cleanup.status;
    }
  }
  const artifacts = writeEvidence({
    options: { ...options, backend: backendDirectory },
    commandArgs,
    results,
    exitCode: run.status || 0,
    cleanupResults,
  });
  console.log(`WorksideQA evidence: ${artifacts.markdown}`);
  console.log(`WorksideQA JSON: ${artifacts.json}`);
  process.exit(run.status || 0);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
}
