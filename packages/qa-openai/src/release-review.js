const path = require("path");
const { buildDashboardData } = require("../../qa-reporting/src/dashboard-data");
const { loadEnvFile } = require("../../qa-config/src");
const { ensureDir, fromRoot, platformVersion, sanitizeForAi, writeJson, writeText } = require("../../qa-utils/src");
const { createResponse, openAiApiKey } = require("./ai-runner");

function reviewPayload(data) {
  return {
    platformVersion: data.platformVersion,
    generatedAt: data.generatedAt,
    overallReadiness: data.overallReadiness,
    releaseComparison: data.releaseComparison,
    products: data.products.map((product) => ({
      productKey: product.productKey,
      productName: product.productName,
      icon: product.icon,
      latestStatus: product.latestStatus,
      latestReadiness: product.latestReadiness,
      statusReason: product.statusReason,
      latestRunStartedAt: product.latestRunStartedAt,
      lastCleanRunStartedAt: product.lastCleanRunStartedAt,
      failedChecks: product.failedChecks,
      warningChecks: product.warningChecks,
      skippedChecks: product.skippedChecks,
      categoryScores: product.categoryScores,
      categoryRollup: product.categoryRollup,
    })),
    recentRuns: data.recentRuns.slice(0, 30).map((run) => ({
      productKey: run.productKey,
      suite: run.suite,
      startedAt: run.startedAt,
      status: run.status,
      readiness: run.readiness,
      counts: run.counts,
    })),
  };
}

function skippedReview(reason, data) {
  return {
    platformVersion: platformVersion(),
    generatedAt: new Date().toISOString(),
    status: "skipped",
    recommendation: "not evaluated",
    summary: reason,
    model: null,
    input: reviewPayload(data),
  };
}

function markdownForReview(review) {
  return [
    `# WorksideQA AI Release Review`,
    "",
    `Version: ${review.platformVersion}`,
    `Generated: ${review.generatedAt}`,
    `Status: ${review.status}`,
    `Recommendation: ${review.recommendation}`,
    "",
    "## Summary",
    "",
    review.summary || "No summary was generated.",
    "",
  ].join("\n");
}

function markdownForDailyReport(report) {
  return [
    "# WorksideQA Daily Engineering Report",
    "",
    `Version: ${report.platformVersion}`,
    `Generated: ${report.generatedAt}`,
    `Recommendation: ${report.recommendation}`,
    "",
    report.summary || "No daily summary was generated.",
    "",
  ].join("\n");
}

function recommendationFromText(text) {
  if (/no[- ]deploy|do not deploy|hold/i.test(text)) return "no-deploy";
  if (/deploy/i.test(text)) return "deploy";
  return "review-required";
}

async function generateReleaseReview(options = {}) {
  loadEnvFile();
  const data = buildDashboardData(options.limit || 100);
  const outputDir = ensureDir(fromRoot("reports", "ai"));
  const jsonPath = path.join(outputDir, "latest-release-review.json");
  const markdownPath = path.join(outputDir, "latest-release-review.md");
  const comparisonPath = path.join(outputDir, "latest-release-comparison.json");
  const dailyJsonPath = path.join(outputDir, "daily-engineering-report.json");
  const dailyMarkdownPath = path.join(outputDir, "daily-engineering-report.md");

  let review;
  let dailyReport;
  if (!openAiApiKey()) {
    review = skippedReview("Set OPENAI_API_KEY or OPENAI_KEY to run the credential-gated AI release review.", data);
    dailyReport = {
      platformVersion: platformVersion(),
      generatedAt: review.generatedAt,
      status: "skipped",
      recommendation: "not evaluated",
      summary: review.summary,
      model: null,
    };
  } else {
    const model = process.env.WORKSIDEQA_OPENAI_MODEL || "gpt-5.4-mini";
    const input = sanitizeForAi(reviewPayload(data));
    const response = await createResponse({
      model,
      input: [
        {
          role: "developer",
          content:
            "You are the executive QA reviewer for WorksideQA. Be concise. Do not reveal secrets. Return: current release readiness, clean products, failing products, major regressions, warnings, score deltas, next actions, and a deploy/no-deploy recommendation.",
        },
        {
          role: "user",
          content: input,
        },
      ],
    });
    const summary = sanitizeForAi(response.output_text || JSON.stringify(response.output || []));
    review = {
      platformVersion: platformVersion(),
      generatedAt: new Date().toISOString(),
      status: "generated",
      recommendation: recommendationFromText(summary),
      model,
      summary,
      input: JSON.parse(input),
    };

    const dailyResponse = await createResponse({
      model,
      input: [
        {
          role: "developer",
          content:
            "Write a brief daily engineering report for a non-developer executive. Start with a greeting, then platform health, critical regressions, product notes, recommendation, and priority today. Do not reveal secrets.",
        },
        {
          role: "user",
          content: input,
        },
      ],
    });
    const dailySummary = sanitizeForAi(dailyResponse.output_text || JSON.stringify(dailyResponse.output || []));
    dailyReport = {
      platformVersion: platformVersion(),
      generatedAt: new Date().toISOString(),
      status: "generated",
      recommendation: recommendationFromText(dailySummary),
      model,
      summary: dailySummary,
    };
  }

  writeJson(comparisonPath, data.releaseComparison);
  writeJson(jsonPath, review);
  writeText(markdownPath, markdownForReview(review));
  writeJson(dailyJsonPath, dailyReport);
  writeText(dailyMarkdownPath, markdownForDailyReport(dailyReport));
  return { jsonPath, markdownPath, comparisonPath, dailyJsonPath, dailyMarkdownPath, review, dailyReport };
}

module.exports = {
  generateReleaseReview,
};
