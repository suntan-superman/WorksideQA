#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { SECRET_PATTERNS, fromRoot, maskSecrets } = require("../../qa-utils/src");

const IGNORED_DIRS = new Set([".git", "node_modules", "reports", "screenshots", "dashboard/data"]);
const GENERATED_PATH_PATTERNS = [
  /^reports[\\/]/,
  /^screenshots[\\/](current|diff)[\\/]/,
  /^dashboard[\\/]data[\\/]/,
  /^\.env\.local$/,
];

function relative(filePath) {
  return path.relative(fromRoot(), filePath);
}

function shouldSkipDirectory(directory) {
  const rel = relative(directory).replace(/\\/g, "/");
  if (!rel) return false;
  return [...IGNORED_DIRS].some((ignored) => rel === ignored || rel.startsWith(`${ignored}/`));
}

function walk(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(filePath)) walk(filePath, files);
    } else {
      files.push(filePath);
    }
  }
  return files;
}

function looksGenerated(filePath) {
  const rel = relative(filePath);
  return GENERATED_PATH_PATTERNS.some((pattern) => pattern.test(rel));
}

function scanSecrets(filePath) {
  const rel = relative(filePath);
  if (/^\.env(?:\.local)?$/i.test(rel)) return [];
  if (/\.(png|jpg|jpeg|webp|gif|ico|lock)$/i.test(rel)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  const findings = [];
  const secretPatterns = SECRET_PATTERNS.filter((pattern) => !String(pattern).includes("@") && !String(pattern).includes("\\d"));
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) findings.push(maskSecrets(`${rel} matched ${pattern}`));
  }
  return findings;
}

function runSafetyGate(options = {}) {
  const files = walk(fromRoot());
  const secretFindings = files.flatMap(scanSecrets);
  const generatedFindings = files.filter(looksGenerated).map((filePath) => relative(filePath));
  return {
    status: secretFindings.length || (options.strictArtifacts && generatedFindings.length) ? "FAIL" : "PASS",
    secretFindings,
    generatedFindings,
  };
}

function printResult(result) {
  process.stdout.write(`WorksideQA safety gate: ${result.status}\n`);
  if (result.secretFindings.length) {
    process.stdout.write("Secret scan findings:\n");
    for (const finding of result.secretFindings) process.stdout.write(`  ${finding}\n`);
  }
  if (result.generatedFindings.length) {
    process.stdout.write("Generated/local artifact paths present in workspace:\n");
    for (const finding of result.generatedFindings.slice(0, 50)) process.stdout.write(`  ${finding}\n`);
    if (result.generatedFindings.length > 50) process.stdout.write(`  ...${result.generatedFindings.length - 50} more\n`);
  }
}

if (require.main === module) {
  try {
    const result = runSafetyGate({ strictArtifacts: process.argv.includes("--strict-artifacts") });
    printResult(result);
    if (result.status === "FAIL") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${maskSecrets(error.stack || error.message)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  runSafetyGate,
};
