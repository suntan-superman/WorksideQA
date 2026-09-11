const fs = require("fs");
const path = require("path");
const { ensureDir, toPosixPath, writeJson, writeText } = require("../../qa-utils/src");

const SCOPE_STATEMENT = "This certification validates the deterministic SageSet QA build against the local Firebase emulator environment using Maestro UI automation and SageSet-owned backend verification. It does not certify production infrastructure, App Store processing, external provider availability, or live AR camera behavior.";

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function markdownEscape(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function redactText(value, secretValues = []) {
  return [...new Set(secretValues.filter(Boolean).map(String))]
    .sort((left, right) => right.length - left.length)
    .reduce((output, secret) => output.split(secret).join("[REDACTED]"), String(value ?? ""));
}

function redactValue(value, secretValues = []) {
  if (typeof value === "string") return redactText(value, secretValues);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secretValues));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry, secretValues)]));
  }
  return value;
}

function collectFailures(preflight, phases, artifactStatus) {
  const failures = [];
  for (const check of preflight) {
    if (check.status === "passed") continue;
    failures.push({
      stage: check.id === "environment-safety" ? "environment" : "preflight",
      category: check.id,
      message: check.message || `${check.label} failed.`,
      exitCode: check.exitCode ?? null,
      artifact: check.artifact || null,
    });
  }
  for (const phase of phases) {
    for (const flow of phase.flows || []) {
      if (flow.status === "passed" || flow.status === "not-run") continue;
      failures.push({
        stage: flow.failureStage || "maestro",
        phase: phase.name,
        flow: flow.flow,
        category: flow.failureStage || "flow",
        exitCode: flow.backendExitCode ?? flow.exitCode ?? null,
        artifact: flow.artifacts || flow.report || phase.artifact || null,
        message: flow.message || `${flow.flow} failed during ${flow.failureStage || "execution"}.`,
      });
    }
    if (phase.status === "failed" && !(phase.flows || []).some((flow) => flow.status === "failed")) {
      failures.push({
        stage: "maestro",
        phase: phase.name,
        category: "phase",
        exitCode: null,
        artifact: phase.artifact || null,
        message: phase.message || `${phase.name} failed.`,
      });
    }
  }
  if (artifactStatus?.status === "failed") {
    failures.push({
      stage: "artifacts",
      category: "artifacts",
      message: artifactStatus.message || "Certification artifacts are incomplete.",
      exitCode: null,
      artifact: artifactStatus.directory || null,
    });
  }
  return failures;
}

function finalizeCertification(input) {
  const preflight = input.preflight || [];
  const phases = input.phases || [];
  const flows = phases.flatMap((phase) => phase.flows || []);
  const backendFlows = flows.filter((flow) => flow.stages?.backend?.verification);
  const artifactStatus = input.artifacts || { status: "passed" };
  const failures = collectFailures(preflight, phases, artifactStatus);
  if (phases.length > 0 && backendFlows.length === 0) {
    failures.push({
      stage: "backend",
      category: "backend-verification",
      message: "No SageSet-owned backend verification result was recorded.",
      exitCode: null,
      artifact: null,
    });
  }
  const releaseCertified = failures.length === 0
    && preflight.every((check) => check.status === "passed")
    && phases.length > 0
    && phases.every((phase) => phase.status === "passed")
    && backendFlows.length > 0
    && backendFlows.every((flow) => flow.stages.backend.status === "passed")
    && artifactStatus.status === "passed";
  const completedAt = input.completedAt || new Date().toISOString();
  const startedMs = Date.parse(input.startedAt);
  const completedMs = Date.parse(completedAt);
  return {
    product: "sageset",
    certificationType: "maestro-release",
    startedAt: input.startedAt,
    completedAt,
    durationMs: Number.isFinite(startedMs) && Number.isFinite(completedMs) ? Math.max(0, completedMs - startedMs) : 0,
    overallStatus: releaseCertified ? "passed" : "failed",
    releaseCertified,
    scope: SCOPE_STATEMENT,
    environment: input.environment || {},
    repositories: input.repositories || {},
    preflight,
    phases,
    backendVerification: {
      status: backendFlows.length === 0
        ? "not-run"
        : backendFlows.every((flow) => flow.stages.backend.status === "passed") ? "passed" : "failed",
      passed: backendFlows.filter((flow) => flow.stages.backend.status === "passed").length,
      failed: backendFlows.filter((flow) => flow.stages.backend.status === "failed").length,
      notRun: backendFlows.filter((flow) => flow.stages.backend.status === "not-run").length,
    },
    artifacts: artifactStatus,
    summary: {
      phaseCount: phases.length,
      phasesPassed: phases.filter((phase) => phase.status === "passed").length,
      phasesFailed: phases.filter((phase) => phase.status === "failed").length,
      flowsTotal: flows.length,
      flowsPassed: flows.filter((flow) => flow.status === "passed").length,
      flowsFailed: flows.filter((flow) => flow.status === "failed").length,
      flowsNotRun: flows.filter((flow) => flow.status === "not-run").length,
      backendVerificationsPassed: backendFlows.filter((flow) => flow.stages.backend.status === "passed").length,
      backendVerificationsFailed: backendFlows.filter((flow) => flow.stages.backend.status === "failed").length,
    },
    firstFailure: failures[0] || null,
    failures,
  };
}

function buildMarkdown(certification) {
  const result = certification.releaseCertified ? "RELEASE CERTIFIED" : "RELEASE NOT CERTIFIED";
  const preflightRows = certification.preflight.map((check) =>
    `| ${markdownEscape(check.label)} | ${check.status === "passed" ? "PASS" : "FAIL"} |`
  ).join("\n");
  const phaseRows = certification.phases.map((phase) => {
    const backend = (phase.flows || []).filter((flow) => flow.stages?.backend?.verification);
    const backendPassed = backend.every((flow) => flow.stages.backend.status === "passed");
    return `| ${markdownEscape(phase.label || phase.name)} | ${phase.status === "passed" ? "PASS" : "FAIL"} | ${phase.flowsPassed}/${phase.flowCount} | ${backend.length === 0 || backendPassed ? "PASS" : "FAIL"} |`;
  }).join("\n");
  const failureSection = certification.failures.length === 0
    ? ""
    : `\n## Failures\n\n${certification.failures.map((failure) =>
      `- **${markdownEscape(failure.phase || failure.stage)}${failure.flow ? ` / ${markdownEscape(failure.flow)}` : ""}:** stage=${markdownEscape(failure.stage)}, category=${markdownEscape(failure.category)}, exit=${failure.exitCode ?? "n/a"}; ${markdownEscape(failure.message)}${failure.artifact ? ` — \`${markdownEscape(failure.artifact)}\`` : ""}`
    ).join("\n")}\n`;
  return `# SageSet Release Certification

**Result:** ${result}  
**App ID:** ${markdownEscape(certification.environment.appId)}  
**Firebase Project:** ${markdownEscape(certification.environment.firebaseProjectId)}  
**Maestro:** ${markdownEscape(certification.environment.maestroVersion || "not checked")}

## Preflight

| Check | Result |
|---|---|
${preflightRows}

## Maestro Certification

| Phase | Result | Flows | Backend |
|---|---|---:|---|
${phaseRows}
${failureSection}
## Scope

${SCOPE_STATEMENT}

## Final Status

**${result}**
`;
}

function buildJUnit(certification) {
  const cases = [];
  for (const check of certification.preflight) {
    cases.push({ suite: "Preflight", name: check.label, status: check.status, message: check.message });
  }
  for (const phase of certification.phases) {
    for (const flow of phase.flows || []) {
      cases.push({ suite: phase.label || phase.name, name: flow.flow, status: flow.status, message: flow.message });
    }
  }
  cases.push({ suite: "Artifacts", name: "Consolidated artifacts", status: certification.artifacts.status, message: certification.artifacts.message });
  const failures = cases.filter((entry) => entry.status === "failed").length;
  const skipped = cases.filter((entry) => entry.status === "not-run" || entry.status === "skipped").length;
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="SageSet Release Certification" tests="${cases.length}" failures="${failures}" skipped="${skipped}" time="${certification.durationMs / 1000}">
${cases.map((entry) => {
    const attrs = `classname="${xmlEscape(entry.suite)}" name="${xmlEscape(entry.name)}"`;
    if (entry.status === "failed") return `  <testcase ${attrs}><failure>${xmlEscape(entry.message || "failed")}</failure></testcase>`;
    if (entry.status === "not-run" || entry.status === "skipped") return `  <testcase ${attrs}><skipped>${xmlEscape(entry.message || "not run")}</skipped></testcase>`;
    return `  <testcase ${attrs} />`;
  }).join("\n")}
</testsuite>
`;
}

function writeCertificationArtifacts(certificationInput, directory, secretValues = []) {
  const resolvedDirectory = path.resolve(directory);
  ensureDir(resolvedDirectory);
  const paths = {
    json: path.join(resolvedDirectory, "certification.json"),
    markdown: path.join(resolvedDirectory, "certification.md"),
    junit: path.join(resolvedDirectory, "junit.xml"),
    environment: path.join(resolvedDirectory, "environment.json"),
  };
  let certification = finalizeCertification({
    ...certificationInput,
    artifacts: {
      status: "passed",
      directory: toPosixPath(resolvedDirectory),
      files: Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, toPosixPath(value)])),
    },
  });
  certification = redactValue(certification, secretValues);
  writeJson(paths.environment, {
    ...certification.environment,
    repositories: certification.repositories,
  });
  writeText(paths.markdown, redactText(buildMarkdown(certification), secretValues));
  writeText(paths.junit, redactText(buildJUnit(certification), secretValues));
  writeJson(paths.json, certification);
  for (const filePath of Object.values(paths)) {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
      throw new Error(`Certification artifact was not created: ${filePath}`);
    }
  }
  const serialized = Object.values(paths).map((filePath) => fs.readFileSync(filePath, "utf8")).join("\n");
  for (const secret of secretValues.filter(Boolean)) {
    if (serialized.includes(secret)) throw new Error("Certification artifacts contain an unredacted secret.");
  }
  return { certification, paths };
}

function validateReportContract() {
  const sample = finalizeCertification({
    startedAt: "2026-09-11T00:00:00.000Z",
    completedAt: "2026-09-11T00:00:01.000Z",
    environment: { appId: "com.workside.sageset", firebaseProjectId: "sageset-maestro-local", maestroVersion: "2.10.0" },
    preflight: [{ id: "fixture-safety", label: "Fixture safety", status: "passed" }],
    phases: [{ name: "phase1", label: "Phase 1", status: "passed", flowCount: 1, flowsPassed: 1, flows: [{ flow: "sample", status: "passed", stages: { backend: { status: "passed", verification: "sample-verifier" } } }] }],
    artifacts: { status: "passed" },
  });
  if (!sample.releaseCertified || !buildMarkdown(sample).includes("RELEASE CERTIFIED") || !buildJUnit(sample).includes("testsuite")) {
    throw new Error("Release certification report contract self-test failed.");
  }
  return true;
}

module.exports = {
  SCOPE_STATEMENT,
  buildJUnit,
  buildMarkdown,
  finalizeCertification,
  redactText,
  redactValue,
  validateReportContract,
  writeCertificationArtifacts,
};
