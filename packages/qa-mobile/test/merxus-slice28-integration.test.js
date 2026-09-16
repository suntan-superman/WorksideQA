const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { integrationConfig, safeJsonOutput } = require('../src/merxus-slice28-integration');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'merxus-slice28-integration.js'), 'utf8');

assert.deepEqual(integrationConfig({
  iosIntegration: {
    account: 'user-b', method: 'PATCH', readPath: '/api/sms/settings', mutationPath: '/api/sms/settings',
    field: 'notificationRetryMaxAttempts', before: 2, after: 3,
  },
}), {
  account: 'user-b', method: 'PATCH', readPath: '/api/sms/settings', mutationPath: '/api/sms/settings',
  field: 'notificationRetryMaxAttempts', before: 2, after: 3,
});
assert.throws(() => integrationConfig({ iosIntegration: { method: 'PATCH', readPath: '/api/sms/settings', mutationPath: '/api/sms/settings', field: 'dailyDigestTime', before: 2, after: 3 } }), /retry max 2 to 3/);
assert.deepEqual(safeJsonOutput('npm preamble\n{"ok":true,"generation":"g"}\n'), { ok: true, generation: 'g' });
assert.throws(() => safeJsonOutput('no result'), /no JSON/);

assert.match(source, /identitytoolkit\.googleapis\.com\/v1\/accounts:signInWithPassword/);
assert.match(source, /mutationUrl/);
assert.match(source, /method: 'PATCH'/);
assert.match(source, /readUrl/);
assert.match(source, /notificationRetryMaxAttempts/);
assert.doesNotMatch(source, /firestore|\.doc\(|\.collection\(/i, 'integration persistence must not mutate Firestore directly');
assert.match(source, /buildBackendVerificationPlan/);
assert.match(source, /authoritativeResult/);

console.log('PASS Slice 28 iOS persistence integration contract uses authenticated production API and authoritative verifier');
