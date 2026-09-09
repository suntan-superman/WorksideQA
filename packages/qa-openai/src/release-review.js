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
    releaseAdvisor: data.releaseAdvisor,
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
      workflowMaturity: product.workflowMaturity,
      failureExplanation: product.failureExplanation,
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

function advisorFromData(data) {
  const products = data.products || [];
  const failing = products.filter((product) => product.latestStatus === "FAIL");
  const warnings = products.filter((product) => product.warningChecks > 0);
  const newFailures = data.releaseComparison?.summary?.newFailures || 0;
  const regressed = data.releaseComparison?.summary?.regressed || 0;
  const readiness = data.overallReadiness || 0;
  const workflowFailures = products.filter((product) => product.workflowMaturity?.status === "failed");
  const riskScore = Math.max(
    0,
    Math.min(100, 100 - readiness + failing.length * 12 + newFailures * 10 + regressed * 8 + workflowFailures.length * 8 + warnings.length * 3)
  );
  const recommendation =
    failing.length > 0 || newFailures > 0 || workflowFailures.length > 0
      ? "hold"
      : riskScore >= 35 || readiness < 90
        ? "investigate"
        : "deploy";
  return {
    generatedAt: new Date().toISOString(),
    recommendation,
    riskScore,
    readiness,
    cleanProducts: products.filter((product) => product.latestStatus === "PASS").length,
    failingProducts: failing.map((product) => product.productKey),
    workflowFailures: workflowFailures.map((product) => product.productKey),
    newFailures,
    regressed,
    summary:
      recommendation === "deploy"
        ? "Release is low risk based on current indexed QA data."
        : recommendation === "hold"
          ? "Release should be held until failing or regressed product checks are resolved."
          : "Release needs engineering review before deployment.",
  };
}

function skippedReview(reason, data) {
  const advisor = advisorFromData(data);
  return {
    platformVersion: platformVersion(),
    generatedAt: new Date().toISOString(),
    status: "skipped",
    recommendation: advisor.recommendation,
    advisor,
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
    review.advisor ? `Risk score: ${review.advisor.riskScore}` : "",
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
    report.advisor ? `Risk score: ${report.advisor.riskScore}` : "",
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
  const advisorPath = path.join(outputDir, "latest-release-advisor.json");
  const advisor = advisorFromData(data);

  let review;
  let dailyReport;
  if (options.deterministicOnly || !openAiApiKey()) {
    review = skippedReview("Set OPENAI_API_KEY or OPENAI_KEY to run the credential-gated AI release review.", data);
    if (options.deterministicOnly) review.summary = "Deterministic release advisor completed; AI prose generation was skipped for this run.";
    dailyReport = {
      platformVersion: platformVersion(),
      generatedAt: review.generatedAt,
      status: "skipped",
      recommendation: advisor.recommendation,
      advisor,
      summary: review.summary,
      model: null,
    };
  } else {
    const model = process.env.WORKSIDEQA_OPENAI_MODEL || "gpt-5.4-mini";
    const input = sanitizeForAi(reviewPayload(data));
    try {
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
        recommendation: advisor.recommendation,
        advisor,
        aiRecommendation: recommendationFromText(summary),
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
        recommendation: advisor.recommendation,
        advisor,
        aiRecommendation: recommendationFromText(dailySummary),
        model,
        summary: dailySummary,
      };
    } catch (error) {
      const summary = `AI release prose unavailable: ${sanitizeForAi(error.message)}. Deterministic release advisor still completed.`;
      review = {
        platformVersion: platformVersion(),
        generatedAt: new Date().toISOString(),
        status: "error",
        recommendation: advisor.recommendation,
        advisor,
        model,
        summary,
        input: JSON.parse(input),
      };
      dailyReport = {
        platformVersion: platformVersion(),
        generatedAt: review.generatedAt,
        status: "error",
        recommendation: advisor.recommendation,
        advisor,
        model,
        summary,
      };
    }
  }

  writeJson(comparisonPath, data.releaseComparison);
  writeJson(advisorPath, advisor);
  writeJson(jsonPath, review);
  writeText(markdownPath, markdownForReview(review));
  writeJson(dailyJsonPath, dailyReport);
  writeText(dailyMarkdownPath, markdownForDailyReport(dailyReport));
  return { jsonPath, markdownPath, comparisonPath, dailyJsonPath, dailyMarkdownPath, advisorPath, review, dailyReport, advisor };
}

module.exports = {
  advisorFromData,
  generateReleaseReview,
};
