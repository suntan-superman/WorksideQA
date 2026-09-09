#!/usr/bin/env node
const path = require("path");
const { buildDashboardData } = require("./dashboard-data");
const { loadEnvFile } = require("../../qa-config/src");
const { ensureDir, fromRoot, maskSecrets, platformVersion, writeJson, writeText } = require("../../qa-utils/src");

function dateLabel(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function statusLine(advisor) {
  if (!advisor) return "Engineering review is available.";
  if (advisor.recommendation === "deploy") return "No critical regressions are currently indexed.";
  if (advisor.recommendation === "hold") return "One or more regressions should be resolved before deployment.";
  return "Engineering review is recommended before deployment.";
}

function productNotes(products = []) {
  return products
    .map((product) => {
      const status = product.latestStatus || "NO DATA";
      const readiness = product.latestReadiness === null || product.latestReadiness === undefined ? "not evaluated" : `${product.latestReadiness}%`;
      return `- ${product.productName}: ${status}, readiness ${readiness}. ${product.failureExplanation || product.statusReason || ""}`;
    })
    .join("\n");
}

function priorityToday(advisor, products = []) {
  if (!advisor) return "Refresh QA data and review the latest release dashboard.";
  if (advisor.failingProducts?.length) return `Resolve failing QA checks for: ${advisor.failingProducts.join(", ")}.`;
  if (advisor.workflowFailures?.length) return `Resolve workflow failures for: ${advisor.workflowFailures.join(", ")}.`;
  const warningProduct = products.find((product) => product.warningChecks > 0);
  if (warningProduct) return `Review warnings for ${warningProduct.productName}.`;
  return "Maintain the clean baseline and continue expanding workflow coverage.";
}

function buildExecutiveEmail(data = buildDashboardData()) {
  const advisor = data.releaseAdvisor;
  const subject = `WorksideQA Daily Engineering Report - ${dateLabel()}`;
  const body = [
    "Good morning Stan.",
    "",
    "Overall Platform Health",
    "",
    `Readiness: ${data.overallReadiness}%`,
    `Recommendation: ${advisor?.recommendation || "not evaluated"}`,
    `Risk score: ${advisor?.riskScore ?? "not evaluated"}`,
    "",
    statusLine(advisor),
    "",
    "Product Notes",
    "",
    productNotes(data.products),
    "",
    "Priority Today",
    "",
    priorityToday(advisor, data.products),
    "",
    "Dashboard",
    "",
    "Open dashboard/index.html for product timelines, workflow maturity, release comparison, and report links.",
    "",
  ].join("\n");

  return maskSecrets({
    platformVersion: platformVersion(),
    generatedAt: new Date().toISOString(),
    subject,
    body,
    recommendation: advisor?.recommendation || "not evaluated",
    riskScore: advisor?.riskScore ?? null,
  });
}

function emailRecipients() {
  const sendGridFrom = process.env.SENDGRID_FROM_EMAIL
    ? `${process.env.SENDGRID_FROM_NAME || "WorksideQA"} <${process.env.SENDGRID_FROM_EMAIL}>`
    : "";
  return {
    to: process.env.WORKSIDEQA_EXECUTIVE_EMAIL_TO || "",
    from: process.env.WORKSIDEQA_EXECUTIVE_EMAIL_FROM || sendGridFrom || "WorksideQA <no-reply@workside.local>",
  };
}

function parseEmailAddress(value) {
  const raw = String(value || "").trim();
  const angle = raw.match(/<([^>]+)>/);
  return (angle ? angle[1] : raw).trim();
}

function parseEmailList(value) {
  return String(value || "")
    .split(",")
    .map(parseEmailAddress)
    .filter(Boolean);
}

function emlForEmail(email) {
  const recipients = emailRecipients();
  return [
    `Subject: ${email.subject}`,
    `To: ${recipients.to}`,
    `From: ${recipients.from}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    email.body,
  ].join("\n");
}

function writeExecutiveEmail(data = buildDashboardData()) {
  const outputDir = ensureDir(fromRoot("reports", "ai"));
  const email = buildExecutiveEmail(data);
  const markdownPath = path.join(outputDir, "executive-engineering-email.md");
  const jsonPath = path.join(outputDir, "executive-engineering-email.json");
  const emlPath = path.join(outputDir, "executive-engineering-email.eml");
  writeText(markdownPath, [`# ${email.subject}`, "", email.body].join("\n"));
  writeJson(jsonPath, email);
  writeText(emlPath, emlForEmail(email));
  return { email, markdownPath, jsonPath, emlPath };
}

function deliveryConfig() {
  loadEnvFile();
  const recipients = emailRecipients();
  return {
    provider: process.env.WORKSIDEQA_EMAIL_PROVIDER || (process.env.SENDGRID_API_KEY ? "sendgrid" : "none"),
    to: recipients.to,
    from: recipients.from,
    sendGridApiKey: process.env.SENDGRID_API_KEY || "",
  };
}

async function sendWithSendGrid(email, config) {
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.sendGridApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: parseEmailList(config.to).map((email) => ({ email })) }],
      from: { email: parseEmailAddress(config.from) },
      subject: email.subject,
      content: [{ type: "text/plain", value: email.body }],
    }),
  });
  if (![200, 202].includes(response.status)) {
    const body = await response.text().catch(() => "");
    throw new Error(`SendGrid returned ${response.status}: ${body.slice(0, 200)}`);
  }
  return { status: "sent", provider: "sendgrid", statusCode: response.status };
}

async function sendExecutiveEmail(data = buildDashboardData(), options = {}) {
  const draft = writeExecutiveEmail(data);
  const config = deliveryConfig();
  const missing = [];
  if (config.provider !== "sendgrid") missing.push("WORKSIDEQA_EMAIL_PROVIDER=sendgrid");
  if (!config.to) missing.push("WORKSIDEQA_EXECUTIVE_EMAIL_TO");
  if (!config.from) missing.push("WORKSIDEQA_EXECUTIVE_EMAIL_FROM or SENDGRID_FROM_EMAIL");
  if (!config.sendGridApiKey) missing.push("SENDGRID_API_KEY");

  if (missing.length) {
    const result = {
      status: options.requireDelivery ? "failed" : "skipped",
      provider: config.provider,
      message: `Executive email delivery not configured. Missing: ${missing.join(", ")}.`,
      draft,
    };
    if (options.requireDelivery) throw new Error(result.message);
    return maskSecrets(result);
  }

  return maskSecrets({
    ...(await sendWithSendGrid(draft.email, config)),
    draft,
  });
}

function parseArgs(argv) {
  const options = { send: false, requireDelivery: false };
  for (const arg of argv) {
    if (arg === "--send") options.send = true;
    else if (arg === "--require-delivery") {
      options.send = true;
      options.requireDelivery = true;
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function helpText() {
  return `WorksideQA executive engineering email

Usage:
  npm run qa:executive-email
  npm run qa:executive-email:send

Delivery is credential-gated. Set:
  WORKSIDEQA_EXECUTIVE_EMAIL_TO=<recipient>
  SENDGRID_FROM_EMAIL=<verified sender>
  SENDGRID_FROM_NAME=<display name>
  SENDGRID_API_KEY=<key>
`;
}

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(helpText());
      return;
    }
    if (options.send) {
      const result = await sendExecutiveEmail(undefined, options);
      process.stdout.write(`Executive email delivery: ${result.status}\n`);
      process.stdout.write(`${result.message || `Provider: ${result.provider}`}\n`);
      process.stdout.write(`Executive email markdown: ${result.draft.markdownPath}\n`);
      if (result.status === "failed") process.exitCode = 1;
      return;
    }
    const result = writeExecutiveEmail();
    process.stdout.write(`Executive email markdown: ${result.markdownPath}\n`);
    process.stdout.write(`Executive email JSON: ${result.jsonPath}\n`);
    process.stdout.write(`Executive email draft: ${result.emlPath}\n`);
  })().catch((error) => {
    process.stderr.write(`${maskSecrets(error.stack || error.message)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildExecutiveEmail,
  sendExecutiveEmail,
  writeExecutiveEmail,
};
