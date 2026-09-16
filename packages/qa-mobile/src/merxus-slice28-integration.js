const fs = require('node:fs');
const path = require('node:path');
const { buildBackendVerificationPlan, buildFixtureResetPlan, runProcess } = require('./maestro-runner');
const { ensureDir, writeJson } = require('../../qa-utils/src');

function safeJsonOutput(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('{');
  if (start < 0) throw new Error('Authoritative verifier returned no JSON result.');
  try { return JSON.parse(text.slice(start)); } catch { throw new Error('Authoritative verifier returned malformed JSON.'); }
}

function integrationConfig(flow) {
  const config = flow.iosIntegration;
  if (!config || config.account !== 'user-b' || config.method !== 'PATCH' || config.readPath !== '/api/sms/settings' || config.mutationPath !== '/api/sms/settings') {
    throw new Error('Slice 28 iOS integration contract is incomplete or unsafe.');
  }
  if (config.field !== 'notificationRetryMaxAttempts' || config.before !== 2 || config.after !== 3) {
    throw new Error('Slice 28 iOS integration contract must certify retry max 2 to 3.');
  }
  return config;
}

function endpoint(baseUrl, route) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(base.hostname) || base.port !== '8787') {
    throw new Error('Slice 28 iOS integration requires the local backend at http://127.0.0.1:8787.');
  }
  return new URL(route, base).toString();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs || 10000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`SMS integration ${options.method || 'GET'} failed with HTTP ${response.status}.`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return { response, body };
}

async function signInOwnerB(validated, fixturePlan) {
  const keyMap = validated.mobile.fixtures.credentialEnvKeys || {};
  const email = String(fixturePlan.env[keyMap.userBEmail] || '').trim();
  const password = fixturePlan.env[keyMap.userBPassword];
  if (!email || !password) throw new Error('Owner B integration credentials are not configured.');
  const host = fixturePlan.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!host) throw new Error('Auth emulator host is not configured for Slice 28 integration.');
  const { body } = await requestJson(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=maestro-local-not-a-secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!body.idToken || body.localId !== 'merxus-maestro-owner-b') throw new Error('Owner B integration authentication did not return the canonical fixture identity.');
  return { token: body.idToken, uid: body.localId, email: body.email || email };
}

async function runAuthenticatedSmsIntegration({ validated, flow, generation, runDirectory }) {
  const integration = integrationConfig(flow);
  const directory = ensureDir(runDirectory);
  const logPath = path.join(directory, 'integration.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const secretValues = Object.values(process.env).filter((value) => typeof value === 'string' && value.length > 8);
  const fixturePlan = buildFixtureResetPlan(validated, flow, process.env, generation);
  const backendPlan = buildBackendVerificationPlan(validated, flow, process.env, generation);
  const writeRecord = (name, value) => logStream.write(`[Slice 28 integration] ${name} ${JSON.stringify(value)}\n`);
  try {
    const fixtureOutcome = await runProcess(fixturePlan.command, fixturePlan.args, {
      cwd: fixturePlan.cwd, env: fixturePlan.env, logStream, secretValues,
      timeoutMs: validated.maestro.timeoutMs, stage: 'integration-fixture', captureOutput: true,
    });
    if (fixtureOutcome.code !== 0 || fixtureOutcome.timedOut || fixtureOutcome.cancelled) throw new Error(`Slice 28 integration fixture reset failed (exit ${fixtureOutcome.code ?? 'unknown'}).`);

    const identity = await signInOwnerB(validated, fixturePlan);
    const readUrl = endpoint(validated.mobile.environment.backendUrl, integration.readPath);
    const mutationUrl = endpoint(validated.mobile.environment.backendUrl, integration.mutationPath);
    const authHeaders = { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json' };
    const initial = (await requestJson(readUrl, { headers: authHeaders })).body;
    if (initial.tenantId !== 'merxus-maestro-tenant-b' || initial.revision !== 1 || initial.sms?.[integration.field] !== integration.before) {
      throw new Error('Slice 28 integration baseline did not return Tenant B retry max 2 at revision 1.');
    }
    const operationId = `slice28-ios-${Date.now()}`;
    const mutation = (await requestJson(mutationUrl, {
      method: 'PATCH', headers: authHeaders,
      body: JSON.stringify({ sms: { [integration.field]: integration.after }, revision: initial.revision, operationId }),
    })).body;
    if (mutation.success !== true || mutation.tenantId !== 'merxus-maestro-tenant-b' || mutation.sms?.[integration.field] !== integration.after || mutation.revision !== 2 || mutation.operationId !== operationId || !mutation.requestId) {
      throw new Error('Slice 28 integration mutation response did not match the protected production contract.');
    }
    const reloaded = (await requestJson(readUrl, { headers: authHeaders })).body;
    if (reloaded.tenantId !== 'merxus-maestro-tenant-b' || reloaded.sms?.[integration.field] !== integration.after || reloaded.revision !== 2) {
      throw new Error('Slice 28 integration authoritative GET did not return retry max 3.');
    }
    writeRecord('authenticatedMutation', { uid: identity.uid, tenantId: reloaded.tenantId, field: integration.field, before: integration.before, after: integration.after, revision: reloaded.revision, requestId: mutation.requestId, operationId: mutation.operationId });

    const backendOutcome = await runProcess(backendPlan.command, backendPlan.args, {
      cwd: backendPlan.cwd, env: backendPlan.env, logStream, secretValues,
      timeoutMs: validated.maestro.timeoutMs, stage: 'backend', captureOutput: true,
    });
    let authoritativeResult = null;
    let verifierParseError = null;
    try { authoritativeResult = backendOutcome.stdout ? safeJsonOutput(backendOutcome.stdout) : null; }
    catch (error) { verifierParseError = error; }
    if (backendOutcome.code !== 0 || backendOutcome.timedOut || backendOutcome.cancelled || verifierParseError || authoritativeResult?.ok !== true || authoritativeResult.generation !== generation) {
      return {
        status: 'failed',
        failureStage: 'backend',
        ...(verifierParseError ? { reason: verifierParseError.message } : {}),
        execution: { results: [{ status: 'failed', stages: { fixture: { status: 'passed' }, ui: { status: 'passed', mode: 'authenticated-integration' }, backend: { status: 'failed', verification: backendPlan.verificationName }, ...(authoritativeResult ? { authoritativeResult } : {}) } }] },
        artifacts: directory,
      };
    }
    return {
      status: 'passed',
      execution: { results: [{ status: 'passed', stages: { fixture: { status: 'passed' }, ui: { status: 'passed', mode: 'authenticated-integration' }, backend: { status: 'passed', verification: backendPlan.verificationName } }, authoritativeResult }] },
      artifacts: directory,
    };
  } finally {
    logStream.end();
  }
}

module.exports = { integrationConfig, runAuthenticatedSmsIntegration, safeJsonOutput };
