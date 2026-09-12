const { parseCorrelationSources, emptyCorrelationDiagnostics, correlationError } = require('./ui-correlation');

function parseAuthoritativeResult(stdout, expected, uiOutput, generation) {
  // npm may print a command preamble; the product verifier emits one final JSON
  // object. Missing/malformed counters are a failure, never inferred from exit 0.
  let diagnostics = emptyCorrelationDiagnostics();
  let captureError;
  try {
    diagnostics = parseCorrelationSources(typeof uiOutput === 'string' ? [{ source: 'runner/stdout', output: uiOutput }] : uiOutput);
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
  for (const key of ['requestId', 'operationId']) if (diagnostics.uiCorrelation[key] !== result[key]) throw correlationError(`UI/backend ${key} mismatch`, diagnostics);
  diagnostics.correlationMatched = true;
  return { ...Object.fromEntries(['generation', 'verificationCase', 'externalProviderInvocationCount', 'blockedProviderAttemptCount', 'crossTenantLeakageCount', 'successAuditCount', 'operationReceiptCount', 'tenantBUnchanged', 'revision', 'requestId', 'operationId'].map((key) => [key, result[key]])), ...diagnostics };
}
module.exports = { parseAuthoritativeResult };
