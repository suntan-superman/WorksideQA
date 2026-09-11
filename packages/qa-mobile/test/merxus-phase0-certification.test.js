const assert = require('node:assert/strict');
const { CHECK_NAMES } = require('../src/merxus-phase0-certification');
assert.equal(CHECK_NAMES.length, 13);
assert.ok(CHECK_NAMES.includes('Notification security review'));
assert.ok(CHECK_NAMES.includes('iOS explicit-device support'));
assert.ok(CHECK_NAMES.includes('Android explicit-device support'));
console.log('Merxus Phase 0 certification report contract verified.');

