const path = require("path");
const { ensureDir, fromRoot, maskSecrets, slugTimestamp, writeJson, writeText } = require("../../qa-utils/src");
const { writeDashboardData } = require("./dashboard-data");

function countChecks(results) {
  const checks = results.flatMap((result) => result.checks || []);
  const passed = checks.filter((check) => check.status === "passed").length;
  const failed = checks.filter((check) => check.status === "failed").length;
  const skipped = checks.filter((check) => check.status === "skipped").length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  return { total: checks.length, passed, failed, skipped, warnings };
}

function releaseReadiness(counts) {
  if (counts.total === 0) return 0;
  const score = ((counts.passed + counts.skipped * 0.4 + counts.warnings * 0.65) / counts.total) * 100;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusClass(status) {
  if (status === "passed") return "pass";
  if (status === "failed") return "fail";
  if (status === "warning") return "warn";
  return "skip";
}

function buildHtmlReport(run) {
  const checks = run.results.flatMap((result) =>
    (result.checks || []).map((check) => ({ ...check, product: result.productName, suite: result.suite }))
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WorksideQA Report - ${escapeHtml(run.status)}</title>
  <style>
    :root { color-scheme: light; --ink:#17202a; --muted:#667085; --line:#d9dee7; --pass:#12693d; --fail:#a61b1b; --warn:#9a5b00; --skip:#475467; --bg:#f6f7f9; }
    body { margin:0; font-family: Arial, sans-serif; color:var(--ink); background:var(--bg); }
    header, main { max-width:1120px; margin:0 auto; padding:24px; }
    header { padding-top:32px; }
    h1 { margin:0 0 8px; font-size:32px; letter-spacing:0; }
    h2 { margin:28px 0 12px; font-size:20px; }
    .meta { color:var(--muted); line-height:1.5; }
    .summary { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:12px; margin-top:20px; }
    .tile { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; }
    .tile strong { display:block; font-size:28px; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    th, td { text-align:left; padding:11px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
    th { font-size:12px; text-transform:uppercase; color:var(--muted); background:#fbfcfd; }
    tr:last-child td { border-bottom:0; }
    .badge { display:inline-block; min-width:64px; text-align:center; border-radius:999px; padding:3px 8px; font-size:12px; font-weight:700; color:#fff; }
    .pass { background:var(--pass); } .fail { background:var(--fail); } .warn { background:var(--warn); } .skip { background:var(--skip); }
    a { color:#175cd3; }
  </style>
</head>
<body>
  <header>
    <h1>WorksideQA ${escapeHtml(run.status)}</h1>
    <div class="meta">Suite: ${escapeHtml(run.suite)} | Environment: ${escapeHtml(run.environment)} | Started: ${escapeHtml(run.startedAt)} | Duration: ${escapeHtml(run.durationMs)}ms</div>
    <section class="summary">
      <div class="tile"><span>Release readiness</span><strong>${run.releaseReadiness}%</strong></div>
      <div class="tile"><span>Passed</span><strong>${run.counts.passed}</strong></div>
      <div class="tile"><span>Failed</span><strong>${run.counts.failed}</strong></div>
      <div class="tile"><span>Warnings</span><strong>${run.counts.warnings}</strong></div>
      <div class="tile"><span>Skipped</span><strong>${run.counts.skipped}</strong></div>
    </section>
  </header>
  <main>
    <h2>Checks</h2>
    <table>
      <thead><tr><th>Status</th><th>Product</th><th>Check</th><th>Detail</th><th>Artifact</th></tr></thead>
      <tbody>
        ${checks
          .map(
            (check) => `<tr><td><span class="badge ${statusClass(check.status)}">${escapeHtml(check.status)}</span></td><td>${escapeHtml(check.product)}</td><td>${escapeHtml(check.name)}</td><td>${escapeHtml(check.message || "")}</td><td>${check.artifact ? `<a href="${escapeHtml(path.relative(path.dirname(run.htmlPath), check.artifact))}">open</a>` : ""}</td></tr>`
          )
          .join("\n")}
      </tbody>
    </table>
  </main>
</body>
</html>
`;
}

function buildJunit(run) {
  const checks = run.results.flatMap((result) =>
    (result.checks || []).map((check) => ({ ...check, product: result.productName }))
  );
  const failures = checks.filter((check) => check.status === "failed");
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="WorksideQA ${escapeHtml(run.suite)}" tests="${checks.length}" failures="${failures.length}" skipped="${checks.filter((check) => check.status === "skipped").length}" time="${run.durationMs / 1000}">
${checks
  .map((check) => {
    const name = escapeHtml(`${check.product} ${check.name}`);
    if (check.status === "failed") return `  <testcase name="${name}"><failure>${escapeHtml(check.message || "failed")}</failure></testcase>`;
    if (check.status === "skipped") return `  <testcase name="${name}"><skipped>${escapeHtml(check.message || "skipped")}</skipped></testcase>`;
    return `  <testcase name="${name}" />`;
  })
  .join("\n")}
</testsuite>
`;
}

function writeReports(runInput) {
  const timestamp = slugTimestamp();
  const counts = countChecks(runInput.results);
  const status = counts.failed > 0 ? "FAIL" : "PASS";
  const run = maskSecrets({
    ...runInput,
    status,
    counts,
    releaseReadiness: releaseReadiness(counts),
    jsonPath: fromRoot("reports", "json", `${timestamp}.json`),
    htmlPath: fromRoot("reports", "html", `${timestamp}.html`),
    junitPath: fromRoot("reports", "junit", `${timestamp}.xml`),
    historyPath: fromRoot("reports", "history", `${timestamp}.json`),
  });

  ensureDir(fromRoot("reports", "json"));
  ensureDir(fromRoot("reports", "html"));
  ensureDir(fromRoot("reports", "junit"));
  ensureDir(fromRoot("reports", "history"));

  writeJson(run.jsonPath, run);
  writeJson(run.historyPath, {
    id: timestamp,
    status: run.status,
    suite: run.suite,
    environment: run.environment,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    counts: run.counts,
    releaseReadiness: run.releaseReadiness,
  });
  writeText(run.htmlPath, buildHtmlReport(run));
  writeText(run.junitPath, buildJunit(run));
  writeDashboardData();

  return run;
}

module.exports = {
  buildHtmlReport,
  buildJunit,
  countChecks,
  releaseReadiness,
  writeReports,
};
