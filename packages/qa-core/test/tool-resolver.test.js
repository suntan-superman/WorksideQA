const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { expandPath, resolveTool } = require('../src/tool-resolver');

test('tool resolver expands environment-based local overrides', () => {
  const env = { USERPROFILE: 'C:\\Users\\qa', WORKSIDEQA_FIREBASE_BIN: '%USERPROFILE%\\tools\\firebase.cmd' };
  assert.equal(expandPath(env.WORKSIDEQA_FIREBASE_BIN, env), path.join('C:\\Users\\qa', 'tools', 'firebase.cmd'));
});

test('node resolves from the running executable when PATH is unavailable', () => {
  const result = resolveTool('node', { PATH: '', Path: '' });
  assert.equal(result.path, process.execPath);
  assert.equal(result.source, 'fallback');
});

test('valid explicit override wins over PATH and fallback candidates', () => {
  const result = resolveTool('node', { WORKSIDEQA_NODE_BIN: process.execPath, PATH: '' });
  assert.equal(result.path, process.execPath);
  assert.equal(result.source, 'local-config');
});

test('invalid explicit override fails closed instead of falling back', () => {
  const result = resolveTool('firebase', {
    ...process.env,
    WORKSIDEQA_FIREBASE_BIN: path.join('C:\\does-not-exist', 'firebase.cmd'),
  });
  assert.equal(result.path, null);
  assert.equal(result.source, 'local-config');
  assert.match(result.error, /WORKSIDEQA_FIREBASE_BIN/);
});

test('missing tool reports an actionable failure without throwing', () => {
  const result = resolveTool('java', { PATH: '', Path: '', USERPROFILE: 'C:\\Users\\qa-no-java', JAVA_HOME: 'C:\\missing-jdk' });
  assert.equal(result.path, null);
  assert.equal(result.source, 'missing');
  assert.match(result.error, /java is not available/i);
});

test('installed Firebase fallback is discovered when present', () => {
  if (process.platform !== 'win32') return;
  const expected = path.join(process.env.LOCALAPPDATA || '', 'Yarn', 'Data', 'global', 'node_modules', '.bin', 'firebase.cmd');
  if (!require('node:fs').existsSync(expected)) return;
  const result = resolveTool('firebase', { ...process.env, PATH: '', Path: '' });
  assert.equal(path.normalize(result.path), path.normalize(expected));
  assert.equal(result.source, 'fallback');
});
