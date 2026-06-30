const fs = require("fs");
const path = require("path");
const { ensureDir, fromRoot, writeText } = require("../../qa-utils/src");

function latestJsonReport() {
  const dir = fromRoot("reports", "json");
  if (!fs.existsSync(dir)) return null;
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(dir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function failedChecks(run) {
  return (run.results || []).flatMap((result) =>
    (result.checks || [])
      .filter((item) => item.status === "failed")
      .map((item) => ({
        product: result.productName,
        suite: result.suite,
        name: item.name,
        message: item.message,
      }))
  );
}

function buildBugReport(run) {
  const failures = failedChecks(run);
  const lines = [
    `# WorksideQA Bug Report - ${run.status}`,
    "",
    `Started: ${run.startedAt}`,
    `Suite: ${run.suite}`,
    `Environment: ${run.environment}`,
    `Release readiness: ${run.releaseReadiness}%`,
    "",
    "## Failures",
    "",
  ];

  if (failures.length === 0) {
    lines.push("No failed checks were found in the latest report.");
  } else {
    for (const failure of failures) {
      lines.push(`### ${failure.product}: ${failure.name}`);
      lines.push("");
      lines.push(`Suite: ${failure.suite}`);
      lines.push("");
      lines.push("```text");
      lines.push(failure.message || "No failure message recorded.");
      lines.push("```");
      lines.push("");
      lines.push("Suggested next action: reproduce locally, inspect attached report artifacts, and assign to the product owner.");
      lines.push("");
    }
  }

  return lines.join("\n");
}

function writeBugReport(reportPath = latestJsonReport()) {
  if (!reportPath) throw new Error("No JSON reports found.");
  const run = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const outputDir = ensureDir(fromRoot("reports", "bug-reports"));
  const id = path.basename(reportPath, ".json");
  const outputPath = path.join(outputDir, `${id}.md`);
  writeText(outputPath, buildBugReport(run));
  return outputPath;
}

module.exports = {
  buildBugReport,
  failedChecks,
  latestJsonReport,
  writeBugReport,
};

