const { parseCorrelationSources, emptyCorrelationDiagnostics, correlationError } = require('./ui-correlation');

function parseAuthoritativeResult(stdout, expected, uiOutput, generation) {
  // npm may print a command preamble; the product verifier emits one final JSON
  // object. Missing/malformed counters are a failure, never inferred from exit 0.
  let diagnostics = emptyCorrelationDiagnostics();
  let captureError;
  try {
    diagnostics = parseCorrelationSources(typeof uiOutput === 'string' ? [{ source: 'runner/stdout', output: uiOutput }] : uiOutput, expected.correlationCount ?? 1);
  } catch (error) {
    diagnostics = error.correlationDiagnostics || diagnostics;
    captureError = error;
  }
  const start = stdout.indexOf('{');
  let result;
  try { result = JSON.parse(stdout.slice(start)); }
  catch { throw correlationError('Malformed authoritative verifier result', diagnostics); }
  const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) && id.trim() === id;
  if (validId(result?.requestId) && validId(result?.operationId)) diagnostics.backendCorrelation = { requestId: result.requestId, operationId: result.operationId };
  if (result?.ok !== true || result.generation !== generation) throw correlationError('Invalid authoritative verifier result/generation', diagnostics);
  for (const [key, value] of Object.entries(expected)) if (result[key] !== value) throw correlationError(`Authoritative verifier mismatch: ${key}`, diagnostics);
  if (captureError) throw correlationError(captureError.message, diagnostics);
  if (expected.correlationCount === 0) {
    if (diagnostics.correlationUniqueCount !== 0 || result.uiCorrelationCount !== 0 || result.mutationExpected !== false) throw correlationError('Non-mutation flow emitted correlation or mutation evidence', diagnostics);
    diagnostics.correlationMatched = true;
    return { ...Object.fromEntries(['generation', 'verificationCase', 'mutationExpected', 'uiCorrelationCount', 'externalProviderInvocationCount', 'blockedProviderAttemptCount', 'crossTenantLeakageCount', 'successAuditCount', 'operationReceiptCount', 'tenantBUnchanged', 'revision', 'unexpectedDomainRecords'].map((key) => [key, result[key]])), ...diagnostics };
  }
  if (expected.correlationCount === 2) {
    if (!Array.isArray(result.correlations) || result.correlations.length !== 2 || result.correlations.some((pair) => !validId(pair?.requestId) || !validId(pair?.operationId))) throw correlationError('Invalid backend round-trip correlations', diagnostics);
    diagnostics.backendCorrelations = result.correlations.map(({ requestId, operationId }) => ({ requestId, operationId }));
    if (new Set(result.correlations.map((pair) => pair.requestId)).size !== 2 || new Set(result.correlations.map((pair) => pair.operationId)).size !== 2) throw correlationError('Duplicate backend correlation identifiers', diagnostics);
    // Artifacts/stdout can arrive in different order. Match exact pairs against
    // the authoritative, revision-ordered receipt list, never IDs independently.
    for (const pair of diagnostics.backendCorrelations) if (!diagnostics.uiCorrelations.some((ui) => ui.requestId === pair.requestId && ui.operationId === pair.operationId)) throw correlationError('UI/backend round-trip correlation mismatch', diagnostics);
    if (!Array.isArray(result.unexpectedDomainRecords) || result.unexpectedDomainRecords.length) throw correlationError('Unexpected domain records', diagnostics);
    diagnostics.correlationMatched = true;
    return { ...expected, generation, verificationCase: result.verificationCase, ...diagnostics };
  }
  for (const key of ['requestId', 'operationId']) if (diagnostics.uiCorrelation[key] !== result[key]) throw correlationError(`UI/backend ${key} mismatch`, diagnostics);
  diagnostics.correlationMatched = true;
  return { ...Object.fromEntries(['generation', 'verificationCase', 'externalProviderInvocationCount', 'blockedProviderAttemptCount', 'crossTenantLeakageCount', 'successAuditCount', 'operationReceiptCount', 'tenantBUnchanged', 'revision', 'requestId', 'operationId'].map((key) => [key, result[key]])), ...diagnostics };
}
module.exports = { parseAuthoritativeResult };
