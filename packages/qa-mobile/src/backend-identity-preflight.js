const { spawnCommandSync } = require('../../qa-utils/src');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function safeString(value) {
  return value == null ? null : String(value);
}

function resolveBackendPid(port) {
  const normalizedPort = Number(port);
  if (!Number.isInteger(normalizedPort) || normalizedPort <= 0) return null;

  if (process.platform === 'win32') {
    const result = spawnCommandSync('netstat.exe', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0) return null;
    const match = String(result.stdout || '').match(
      new RegExp(`^\\s*TCP\\s+\\S+:${normalizedPort}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'im'),
    );
    return match ? Number(match[1]) : null;
  }

  const result = spawnCommandSync('lsof', ['-nP', `-iTCP:${normalizedPort}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0) return null;
  const pid = String(result.stdout || '').trim().split(/\s+/).find((value) => /^\d+$/.test(value));
  return pid ? Number(pid) : null;
}

function validateBackendIdentityContract(mobile, phase0) {
  const environment = mobile?.environment || {};
  const backendUrl = String(environment.backendUrl || '').trim();
  let parsed;
  try {
    parsed = new URL(backendUrl);
  } catch {
    throw new Error('Merxus backend identity preflight requires a valid backendUrl.');
  }
  const expectedPort = 8787;
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname) || parsed.port !== String(expectedPort)) {
    throw new Error('Merxus backend identity preflight requires http://127.0.0.1:8787.');
  }
  if (environment.firebaseProjectId !== 'merxus-maestro-local') {
    throw new Error('Merxus backend identity preflight requires merxus-maestro-local.');
  }
  const emulators = environment.emulators || {};
  if (emulators.auth !== 9099 || emulators.firestore !== 8080) {
    throw new Error('Merxus backend identity preflight requires Auth 9099 and Firestore 8080.');
  }
  if (!phase0?.authPreflightCommand || !Array.isArray(phase0.authPreflightCommand) || phase0.authPreflightCommand.length < 2) {
    throw new Error('Merxus backend identity preflight requires phase0.authPreflightCommand.');
  }
  const owners = phase0.backendIdentityVerify?.owners;
  if (!Array.isArray(owners) || owners.length === 0 || owners.some((owner) => !/^owner[A-Z]$/.test(owner))) {
    throw new Error('Merxus backend identity preflight requires a bounded owner list.');
  }
  const endpointPath = String(phase0.backendIdentityVerify.endpointPath || '/api/auth/check-email');
  if (!endpointPath.startsWith('/') || endpointPath.includes('://')) {
    throw new Error('Merxus backend identity preflight endpointPath must be a relative path.');
  }
  const expected = phase0.backendIdentityVerify.expected || { exists: true, provider: 'email', hasWorkspace: true };
  if (expected.exists !== true || expected.provider !== 'email' || expected.hasWorkspace !== true) {
    throw new Error('Merxus backend identity preflight expected result is unsafe.');
  }
  return {
    backendUrl,
    endpoint: new URL(endpointPath, backendUrl).toString(),
    backendPort: expectedPort,
    projectId: environment.firebaseProjectId,
    authEmulatorHost: `127.0.0.1:${emulators.auth}`,
    firestoreEmulatorHost: `127.0.0.1:${emulators.firestore}`,
    owners,
    expected,
  };
}

function ownerEmailKey(owner) {
  if (owner === 'ownerA') return 'userAEmail';
  if (owner === 'ownerB') return 'userBEmail';
  return `${owner}Email`;
}

async function checkEmail(endpoint, email, timeoutMs = 5000) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  return {
    status: response.status,
    result: {
      exists: body.exists === true,
      provider: safeString(body.provider),
      hasWorkspace: body.hasWorkspace === true,
    },
  };
}

async function runBackendIdentityPreflight({
  validated,
  flow,
  fixturePlan,
  runProcess,
  logStream,
  secretValues = [],
  generation,
}) {
  const { mobile } = validated;
  const phase0 = mobile.phase0;
  const contract = validateBackendIdentityContract(mobile, phase0);
  const environment = fixturePlan?.env || process.env;
  const credentialEnvKeys = mobile.fixtures?.credentialEnvKeys || {};
  const backendPid = resolveBackendPid(contract.backendPort);
  const baseDiagnostics = {
    fixtureGeneration: generation,
    backendPid,
    projectId: contract.projectId,
    backendPort: contract.backendPort,
    authEmulatorHost: contract.authEmulatorHost,
    firestoreEmulatorHost: contract.firestoreEmulatorHost,
    backendUrl: contract.backendUrl,
  };

  const authCommand = phase0.authPreflightCommand;
  let authOutcome;
  try {
    authOutcome = await runProcess(authCommand[0], authCommand.slice(1), {
      cwd: fixturePlan?.cwd,
      env: environment,
      logStream,
      secretValues,
      timeoutMs: 30000,
      stage: 'backend-preflight-auth',
      captureOutput: true,
    });
  } catch (cause) {
    const error = new Error('Backend identity preflight failed: qa:maestro:auth:verify could not start.');
    error.preflightDiagnostics = {
      ...baseDiagnostics,
      failedCheck: 'authVerify',
      safeAuthVerifyError: { name: cause?.name || 'Error', message: cause?.message || 'process start failed' },
    };
    throw error;
  }
  if (authOutcome.code !== 0 || authOutcome.timedOut || authOutcome.cancelled) {
    const error = new Error('Backend identity preflight failed: qa:maestro:auth:verify.');
    error.preflightDiagnostics = {
      ...baseDiagnostics,
      failedCheck: 'authVerify',
      authVerifyExitCode: authOutcome.code,
    };
    throw error;
  }

  const identities = [];
  for (const owner of contract.owners) {
    const key = ownerEmailKey(owner);
    const envKey = credentialEnvKeys[key];
    const email = String(environment[envKey] || '').trim().toLowerCase();
    if (!envKey || !email) {
      const error = new Error(`Backend identity preflight failed: missing ${envKey || key}.`);
      error.preflightDiagnostics = { ...baseDiagnostics, failedCheck: `${owner}.email` };
      throw error;
    }
    let checked;
    try {
      checked = await checkEmail(contract.endpoint, email);
    } catch (cause) {
      const error = new Error(`Backend identity preflight failed: ${owner} check-email request.`);
      error.preflightDiagnostics = {
        ...baseDiagnostics,
        failedCheck: `${owner}.checkEmail`,
        safeCheckEmailResult: { error: { name: cause?.name || 'Error', message: 'request failed' } },
      };
      throw error;
    }
    const safeResult = { status: checked.status, ...checked.result };
    const passed = checked.status === 200
      && safeResult.exists === contract.expected.exists
      && safeResult.provider === contract.expected.provider
      && safeResult.hasWorkspace === contract.expected.hasWorkspace;
    identities.push({ owner, email, ...safeResult, passed });
    if (!passed) {
      const error = new Error(`Backend identity preflight failed: ${owner} check-email result.`);
      error.preflightDiagnostics = { ...baseDiagnostics, failedCheck: `${owner}.checkEmail`, safeCheckEmailResult: safeResult, identities };
      throw error;
    }
  }

  return { ...baseDiagnostics, identities, authVerify: 'passed' };
}

module.exports = {
  resolveBackendPid,
  validateBackendIdentityContract,
  runBackendIdentityPreflight,
};
