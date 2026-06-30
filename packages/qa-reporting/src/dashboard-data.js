const fs = require("fs");
const path = require("path");
const { ensureDir, fromRoot, writeText } = require("../../qa-utils/src");

function readHistoryFiles(limit = 100) {
  const historyDir = fromRoot("reports", "history");
  if (!fs.existsSync(historyDir)) return [];

  return fs
    .readdirSync(historyDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(historyDir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, limit)
    .map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")));
}

function buildDashboardData(limit = 100) {
  const runs = readHistoryFiles(limit);
  const latest = runs[0] || null;
  const byStatus = runs.reduce(
    (acc, run) => {
      acc[run.status] = (acc[run.status] || 0) + 1;
      return acc;
    },
    { PASS: 0, FAIL: 0 }
  );

  return {
    generatedAt: new Date().toISOString(),
    latest,
    byStatus,
    runs,
  };
}

function writeDashboardData(limit = 100) {
  const data = buildDashboardData(limit);
  const outputPath = fromRoot("dashboard", "data", "history.js");
  ensureDir(path.dirname(outputPath));
  writeText(outputPath, `window.WORKSIDEQA_HISTORY = ${JSON.stringify(data, null, 2)};\n`);
  return { outputPath, data };
}

module.exports = {
  buildDashboardData,
  readHistoryFiles,
  writeDashboardData,
};

