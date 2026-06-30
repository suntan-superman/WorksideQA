const fs = require("fs");
const path = require("path");
const { listProductKeys, loadProductManifest } = require("../../qa-config/src");
const { ensureDir, fromRoot, platformVersion, readJson, writeJson, writeText } = require("../../qa-utils/src");

const PRODUCT_ICONS = {
  radiusiq: "📊",
  merxus: "🤖",
  sageset: "💪",
  "support-console": "🎧",
  "route-logistics": "🚛",
  anyryde: "🚗",
};

const CATEGORY_ROLLUP = {
  reliability: ["browser"],
  performance: ["performance"],
  security: ["security"],
  accessibility: ["accessibility"],
  visual: ["visual"],
  ai: ["ai"],
};

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

function checkKey(check) {
  return `${check.name || "unnamed"}:${check.message || ""}`;
}

function productReason(row) {
  if (!row) return "No QA run has been indexed yet.";
  const failed = row.checks.find((check) => check.status === "failed");
  if (failed) return `${failed.name}: ${failed.message || "failed"}`;
  const warning = row.checks.find((check) => check.status === "warning");
  if (warning) return `${warning.name}: ${warning.message || "warning"}`;
  return `Clean ${row.suite} run: ${row.counts.passed} checks passed.`;
}

function combineCategoryScores(scores = {}, names = []) {
  const evaluated = names
    .map((name) => scores[name])
    .filter((score) => score && score.score !== null && score.score !== undefined);
  if (!evaluated.length) return { status: "not evaluated", score: null };
  const failed = evaluated.some((score) => score.status === "failed");
  const warning = evaluated.some((score) => score.status === "warning");
  return {
    status: failed ? "failed" : warning ? "warning" : "passed",
    score: Math.round(evaluated.reduce((sum, item) => sum + item.score, 0) / evaluated.length),
  };
}

function categoryRollup(scores = {}) {
  return Object.fromEntries(
    Object.entries(CATEGORY_ROLLUP).map(([name, categories]) => [name, combineCategoryScores(scores, categories)])
  );
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
        checks: checks.map((check) => ({
          status: check.status,
          name: check.name,
          message: check.message,
        })),
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
  const scores = latest?.categoryScores || {};
  return {
    productKey,
    productName: manifest.name,
    icon: PRODUCT_ICONS[productKey] || "□",
    latestStatus: latest?.status || "NO DATA",
    latestReadiness: latest?.readiness ?? null,
    statusReason: productReason(latest),
    latestRunStartedAt: latest?.startedAt || null,
    lastCleanRunStartedAt: cleanRunStartedAt(productRows),
    failedChecks: counts.failed,
    warningChecks: counts.warnings,
    skippedChecks: counts.skipped,
    reportLinks: latest?.reportLinks || {},
    categoryScores: scores,
    categoryRollup: categoryRollup(scores),
    latestArtifacts: safeLatestArtifacts(latest),
    recentRuns: productRows.slice(0, 10),
  };
}

function compareRuns(latest, previous) {
  if (!latest) return null;
  const previousChecks = previous?.checks || [];
  const latestFailed = latest.checks.filter((check) => check.status === "failed");
  const previousFailed = previousChecks.filter((check) => check.status === "failed");
  const previousFailedKeys = new Set(previousFailed.map(checkKey));
  const latestFailedKeys = new Set(latestFailed.map(checkKey));

  return {
    productKey: latest.productKey,
    productName: latest.productName,
    latestStartedAt: latest.startedAt,
    previousStartedAt: previous?.startedAt || null,
    statusBefore: previous?.status || null,
    statusAfter: latest.status,
    readinessBefore: previous?.readiness ?? null,
    readinessAfter: latest.readiness,
    readinessDelta: previous ? latest.readiness - previous.readiness : null,
    newFailures: latestFailed.filter((check) => !previousFailedKeys.has(checkKey(check))),
    resolvedFailures: previousFailed.filter((check) => !latestFailedKeys.has(checkKey(check))),
    warningDelta: previous ? latest.counts.warnings - previous.counts.warnings : null,
    failedDelta: previous ? latest.counts.failed - previous.counts.failed : null,
    summary: comparisonSummary(latest, previous),
  };
}

function comparisonSummary(latest, previous) {
  if (!previous) return "First indexed run for this product.";
  if (previous.status !== latest.status) return `Status changed from ${previous.status} to ${latest.status}.`;
  const delta = latest.readiness - previous.readiness;
  if (delta > 0) return `Readiness improved by ${delta} point${delta === 1 ? "" : "s"}.`;
  if (delta < 0) return `Readiness declined by ${Math.abs(delta)} point${delta === -1 ? "" : "s"}.`;
  if (latest.counts.failed > 0) return `${latest.counts.failed} failure${latest.counts.failed === 1 ? "" : "s"} remain open.`;
  return "No regressions since the previous indexed run.";
}

function buildReleaseComparison(products, recentRuns) {
  const comparisons = products.map((product) => {
    const rows = recentRuns.filter((run) => run.productKey === product.productKey);
    return compareRuns(rows[0], rows[1]);
  }).filter(Boolean);

  return {
    platformVersion: platformVersion(),
    generatedAt: new Date().toISOString(),
    products: comparisons,
    summary: {
      improved: comparisons.filter((item) => (item.readinessDelta || 0) > 0 || (item.statusBefore === "FAIL" && item.statusAfter === "PASS")).length,
      regressed: comparisons.filter((item) => (item.readinessDelta || 0) < 0 || (item.statusBefore === "PASS" && item.statusAfter === "FAIL")).length,
      unchanged: comparisons.filter((item) => item.readinessDelta === 0 && item.statusBefore === item.statusAfter).length,
      newFailures: comparisons.reduce((sum, item) => sum + item.newFailures.length, 0),
      resolvedFailures: comparisons.reduce((sum, item) => sum + item.resolvedFailures.length, 0),
    },
  };
}

function buildDashboardData(limit = 100) {
  const reports = readJsonReports(limit);
  const recentRuns = reportRunRows(reports).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const products = listProductKeys().map((productKey) => buildProductSummary(productKey, recentRuns));
  const releaseComparison = buildReleaseComparison(products, recentRuns);
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
    releaseComparison,
    runs: readHistoryFiles(limit),
    aiReview: readLatestAiReview(),
  };
}

function writeDashboardData(limit = 100) {
  const data = buildDashboardData(limit);
  const dataDir = ensureDir(fromRoot("dashboard", "data"));
  const jsonPath = path.join(dataDir, "dashboard-summary.json");
  const comparisonPath = path.join(dataDir, "release-comparison.json");
  const jsPath = path.join(dataDir, "history.js");
  writeJson(jsonPath, data);
  writeJson(comparisonPath, data.releaseComparison);
  writeText(jsPath, `window.WORKSIDEQA_DASHBOARD = ${JSON.stringify(data, null, 2)};\nwindow.WORKSIDEQA_HISTORY = window.WORKSIDEQA_DASHBOARD;\n`);
  return { outputPath: jsonPath, comparisonPath, jsPath, data };
}

module.exports = {
  buildDashboardData,
  readHistoryFiles,
  readJsonReports,
  writeDashboardData,
};
