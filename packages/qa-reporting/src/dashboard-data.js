const fs = require("fs");
const path = require("path");
const { listProductKeys, loadProductManifest } = require("../../qa-config/src");
const { ensureDir, fromRoot, platformVersion, readJson, writeJson, writeText } = require("../../qa-utils/src");

function readJsonReports(limit = 100) {
  const reportDir = fromRoot("reports", "json");
  if (!fs.existsSync(reportDir)) return [];

  return fs
    .readdirSync(reportDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(reportDir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, limit)
    .map((filePath) => ({ ...readJson(filePath), sourceJsonPath: filePath }));
}

function readHistoryFiles(limit = 100) {
  const historyDir = fromRoot("reports", "history");
  if (!fs.existsSync(historyDir)) return [];

  return fs
    .readdirSync(historyDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(historyDir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, limit)
    .map((filePath) => readJson(filePath));
}

function dashboardRelative(filePath) {
  if (!filePath) return null;
  return path.relative(fromRoot("dashboard"), filePath).replace(/\\/g, "/");
}

function isSafeDashboardScreenshot(filePath) {
  return /-home\.(png|jpg|jpeg|webp)$/i.test(path.basename(String(filePath || "")));
}

function countChecks(checks) {
  return {
    total: checks.length,
    passed: checks.filter((check) => check.status === "passed").length,
    failed: checks.filter((check) => check.status === "failed").length,
    warnings: checks.filter((check) => check.status === "warning").length,
    skipped: checks.filter((check) => check.status === "skipped").length,
  };
}

function resultReadiness(result) {
  const summary = (result.productSummaries || []).find((item) => item.productKey === result.productKey);
  if (summary) return summary.readiness;
  const counts = countChecks(result.checks || []);
  if (counts.total === 0) return 0;
  return Math.round(((counts.passed + counts.skipped * 0.4 + counts.warnings * 0.65) / counts.total) * 100);
}

function reportRunRows(reports) {
  return reports.flatMap((run) =>
    (run.results || []).map((result) => {
      const checks = result.checks || [];
      const counts = countChecks(checks);
      return {
        productKey: result.productKey,
        productName: result.productName,
        suite: result.suite || run.suite,
        environment: result.environment || run.environment,
        startedAt: run.startedAt,
        durationMs: result.durationMs,
        status: counts.failed > 0 ? "FAIL" : "PASS",
        readiness: resultReadiness({ ...result, productSummaries: run.productSummaries }),
        counts,
        reportLinks: {
          html: dashboardRelative(run.htmlPath),
          json: dashboardRelative(run.jsonPath || run.sourceJsonPath),
          junit: dashboardRelative(run.junitPath),
        },
        screenshots: (result.artifacts?.screenshots || []).filter(isSafeDashboardScreenshot).map(dashboardRelative),
        categoryScores:
          (run.productSummaries || []).find((item) => item.productKey === result.productKey)?.categoryScores || {},
      };
    })
  );
}

function cleanRunStartedAt(rows) {
  return rows.find((run) => run.status === "PASS")?.startedAt || null;
}

function safeLatestArtifacts(row) {
  return {
    screenshots: row?.screenshots || [],
  };
}

function readLatestAiReview() {
  const jsonPath = fromRoot("reports", "ai", "latest-release-review.json");
  if (!fs.existsSync(jsonPath)) return null;
  const review = readJson(jsonPath);
  return {
    status: review.status,
    generatedAt: review.generatedAt,
    recommendation: review.recommendation,
    summary: review.summary,
    markdown: dashboardRelative(fromRoot("reports", "ai", "latest-release-review.md")),
    json: dashboardRelative(jsonPath),
  };
}

function buildProductSummary(productKey, rows) {
  const manifest = loadProductManifest(productKey);
  const productRows = rows.filter((run) => run.productKey === productKey);
  const latest = productRows[0] || null;
  const counts = latest?.counts || { failed: 0, warnings: 0, skipped: 0 };
  return {
    productKey,
    productName: manifest.name,
    latestStatus: latest?.status || "NO DATA",
    latestReadiness: latest?.readiness ?? null,
    latestRunStartedAt: latest?.startedAt || null,
    lastCleanRunStartedAt: cleanRunStartedAt(productRows),
    failedChecks: counts.failed,
    warningChecks: counts.warnings,
    skippedChecks: counts.skipped,
    reportLinks: latest?.reportLinks || {},
    categoryScores: latest?.categoryScores || {},
    latestArtifacts: safeLatestArtifacts(latest),
    recentRuns: productRows.slice(0, 10),
  };
}

function buildDashboardData(limit = 100) {
  const reports = readJsonReports(limit);
  const recentRuns = reportRunRows(reports).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const products = listProductKeys().map((productKey) => buildProductSummary(productKey, recentRuns));
  const evaluated = products.filter((product) => product.latestReadiness !== null);
  const overallReadiness = evaluated.length
    ? Math.round(evaluated.reduce((sum, product) => sum + product.latestReadiness, 0) / evaluated.length)
    : 0;

  return {
    platformVersion: platformVersion(),
    generatedAt: new Date().toISOString(),
    overallReadiness,
    products,
    recentRuns: recentRuns.slice(0, limit),
    runs: readHistoryFiles(limit),
    aiReview: readLatestAiReview(),
  };
}

function writeDashboardData(limit = 100) {
  const data = buildDashboardData(limit);
  const dataDir = ensureDir(fromRoot("dashboard", "data"));
  const jsonPath = path.join(dataDir, "dashboard-summary.json");
  const jsPath = path.join(dataDir, "history.js");
  writeJson(jsonPath, data);
  writeText(jsPath, `window.WORKSIDEQA_DASHBOARD = ${JSON.stringify(data, null, 2)};\nwindow.WORKSIDEQA_HISTORY = window.WORKSIDEQA_DASHBOARD;\n`);
  return { outputPath: jsonPath, jsPath, data };
}

module.exports = {
  buildDashboardData,
  readHistoryFiles,
  readJsonReports,
  writeDashboardData,
};
