const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expandPath, resolveTool, canonicalizeToolEnvironment, posixPathCandidates } = require('../src/tool-resolver');

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

test('Windows resolver evaluates later where.exe hits when an earlier shim is broken', () => {
  if (process.platform !== 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-tool-resolution-'));
  const staleDir = path.join(root, 'stale');
  const validDir = path.join(root, 'valid');
  fs.mkdirSync(staleDir); fs.mkdirSync(validDir);
  fs.writeFileSync(path.join(staleDir, 'firebase.cmd'), '@echo off\r\nexit /b 1\r\n', 'utf8');
  fs.writeFileSync(path.join(validDir, 'firebase.cmd'), '@echo off\r\nexit /b 0\r\n', 'utf8');
  const result = resolveTool('firebase', {
    ...process.env,
    PATH: `${staleDir}${path.delimiter}${validDir}`,
    Path: '',
    USERPROFILE: root,
    LOCALAPPDATA: root,
    APPDATA: root,
  });
  assert.equal(path.normalize(result.path), path.normalize(path.join(validDir, 'firebase.cmd')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('Windows Firebase resolution is deterministic across multiple installed versions', () => {
  if (process.platform !== 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-firebase-versions-'));
  const oldDir = path.join(root, 'old');
  const newDir = path.join(root, 'new');
  fs.mkdirSync(oldDir); fs.mkdirSync(newDir);
  fs.writeFileSync(path.join(oldDir, 'firebase.cmd'), '@echo off\r\necho 14.19.1\r\n', 'utf8');
  fs.writeFileSync(path.join(newDir, 'firebase.cmd'), '@echo off\r\necho 15.23.0\r\n', 'utf8');
  try {
    const env = { ...process.env, PATH: `${oldDir}${path.delimiter}${newDir}`, Path: '', USERPROFILE: root, LOCALAPPDATA: root, APPDATA: root };
    const result = resolveTool('firebase', env);
    assert.equal(path.normalize(result.path), path.normalize(path.join(newDir, 'firebase.cmd')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolver does not retain a negative result after the environment changes', () => {
  const missing = resolveTool('firebase', { PATH: '', Path: '', USERPROFILE: path.join(os.tmpdir(), 'worksideqa-no-firebase') });
  assert.equal(missing.path, null);
  const available = resolveTool('firebase', { PATH: '', Path: '', WORKSIDEQA_FIREBASE_BIN: process.env.LOCALAPPDATA + '\\Yarn\\bin\\firebase.cmd' });
  assert.equal(path.normalize(available.path), path.normalize(process.env.LOCALAPPDATA + '\\Yarn\\bin\\firebase.cmd'));
});

test('root-relative Firebase template is normalized before child-process handoff', () => {
  if (process.platform !== 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-firebase-handoff-'));
  const firebase = path.join(root, 'firebase.cmd');
  fs.writeFileSync(firebase, '@echo off\r\necho 15.23.0\r\n', 'utf8');
  try {
    const normalized = canonicalizeToolEnvironment({
      PATH: root,
      Path: '',
      NVM_SYMLINK: '',
      WORKSIDEQA_FIREBASE_BIN: '%NVM_SYMLINK%\\nodejs\\firebase.cmd',
    });
    assert.equal(path.normalize(normalized.WORKSIDEQA_FIREBASE_BIN), path.normalize(firebase));
    assert.ok(path.isAbsolute(normalized.WORKSIDEQA_FIREBASE_BIN));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('POSIX PATH resolution ignores stale entries and finds a later executable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-posix-path-'));
  const staleDir = path.join(root, 'stale');
  const validDir = path.join(root, 'valid');
  fs.mkdirSync(staleDir); fs.mkdirSync(validDir);
  fs.writeFileSync(path.join(validDir, 'firebase'), '#!/bin/sh\nprintf 15.30.0\n', 'utf8');
  try {
    const candidates = posixPathCandidates('firebase', { PATH: `${staleDir}${path.delimiter}${validDir}` });
    assert.deepEqual(candidates, [path.resolve(validDir, 'firebase')]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
