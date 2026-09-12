function parseAuthoritativeResult(stdout, expected, uiOutput, generation) {
  // npm may print a command preamble; the product verifier emits one final JSON
  // object. Missing/malformed counters are a failure, never inferred from exit 0.
  const start = stdout.indexOf('{');
  const result = JSON.parse(stdout.slice(start));
  if (result.ok !== true || result.generation !== generation) throw Error('Invalid authoritative verifier result/generation');
  for (const [key, value] of Object.entries(expected)) if (result[key] !== value) throw Error(`Authoritative verifier mismatch: ${key}`);
  const captures = [...uiOutput.matchAll(/WORKSIDEQA_CORRELATION=(\{[^\r\n]+\})/g)];
  if (captures.length !== 1) throw Error('Expected exactly one UI correlation capture');
  const ui = JSON.parse(captures[0][1]);
  for (const key of ['requestId', 'operationId']) if (!ui[key] || ui[key] !== result[key]) throw Error(`UI/backend ${key} mismatch`);
  return Object.fromEntries(['generation', 'verificationCase', 'externalProviderInvocationCount', 'blockedProviderAttemptCount', 'crossTenantLeakageCount', 'successAuditCount', 'operationReceiptCount', 'tenantBUnchanged', 'revision', 'requestId', 'operationId'].map((key) => [key, result[key]]));
}
module.exports = { parseAuthoritativeResult };
