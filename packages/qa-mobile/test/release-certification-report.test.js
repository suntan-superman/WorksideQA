const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildJUnit,
  buildMarkdown,
  finalizeCertification,
  writeCertificationArtifacts,
} = require("../src/release-certification-report");

function input(status = "passed") {
  const failed = status === "failed";
  return {
    startedAt: "2026-09-11T00:00:00.000Z",
    completedAt: "2026-09-11T00:00:02.000Z",
    environment: {
      appId: "com.workside.sageset",
      firebaseProjectId: "sageset-maestro-local",
      maestroVersion: "2.10.0",
      emulatorOnly: true,
      externalNotificationsAllowed: false,
    },
    preflight: [{ id: "fixture-safety", label: "Fixture safety", status: "passed" }],
    phases: [{
      name: "phase1",
      label: "Phase 1",
      status,
      flowCount: 1,
      flowsPassed: failed ? 0 : 1,
      flowsFailed: failed ? 1 : 0,
      flows: [{
        flow: "00-launch-smoke",
        status,
        failureStage: failed ? "ui" : null,
        message: failed ? "secret-password failed for qa-user@example.com" : "Passed.",
        stages: { backend: { status: "passed", verification: "launch" } },
      }],
    }],
    artifacts: { status: "passed" },
  };
}

const passed = finalizeCertification(input());
assert.equal(passed.releaseCertified, true);
assert.match(buildMarkdown(passed), /\*\*RELEASE CERTIFIED\*\*/);

const failed = finalizeCertification(input("failed"));
assert.equal(failed.releaseCertified, false);
assert.equal(failed.firstFailure.flow, "00-launch-smoke");
assert.match(buildMarkdown(failed), /RELEASE NOT CERTIFIED/);
assert.doesNotMatch(buildMarkdown(failed), /\*\*RELEASE CERTIFIED\*\*/);
assert.match(buildJUnit(failed), /<failure>/);
assert.match(buildJUnit(failed), /00-launch-smoke/);

const blockedInput = input("failed");
blockedInput.phases[0].flowCount = 2;
blockedInput.phases[0].flows.push({
  flow: "20-groups-challenges",
  status: "not-run",
  failureStage: "not-run",
  message: "Not run after an earlier failure in this phase.",
  stages: { backend: { status: "not-run", verification: null } },
});
const blocked = finalizeCertification(blockedInput);
assert.equal(blocked.summary.flowsFailed, 1);
assert.equal(blocked.summary.flowsNotRun, 1);
assert.match(buildMarkdown(blocked), /20-groups-challenges \| NOT RUN \/ BLOCKED/);
assert.match(buildJUnit(blocked), /<skipped>Not run after an earlier failure in this phase\.<\/skipped>/);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sageset-cert-report-"));
try {
  const output = writeCertificationArtifacts(input("failed"), temporaryRoot, ["secret-password", "qa-user@example.com"]);
  for (const artifactPath of Object.values(output.paths)) {
    assert.equal(fs.existsSync(artifactPath), true);
    assert.ok(fs.statSync(artifactPath).size > 0);
    const contents = fs.readFileSync(artifactPath, "utf8");
    assert.doesNotMatch(contents, /secret-password|qa-user@example\.com/);
  }
  assert.equal(JSON.parse(fs.readFileSync(output.paths.json, "utf8")).releaseCertified, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(output.paths.environment, "utf8")).repositories, {});
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log("SageSet release certification report tests passed.");
