const fs = require('node:fs');
const path = require('node:path');
const { spawnCommandSync } = require('../../qa-utils/src');

const TOOL_OVERRIDES = {
  node: 'WORKSIDEQA_NODE_BIN',
  npm: 'WORKSIDEQA_NPM_BIN',
  firebase: 'WORKSIDEQA_FIREBASE_BIN',
  adb: 'WORKSIDEQA_ADB_BIN',
  maestro: 'WORKSIDEQA_MAESTRO_BIN',
  java: 'WORKSIDEQA_JAVA_BIN',
};

function expandPath(value, env = process.env) {
  let expanded = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  expanded = expanded.replace(/%([A-Z][A-Z0-9_]*)%/gi, (_, key) => String(env[key] || ''));
  expanded = expanded.replace(/\$env:([A-Z][A-Z0-9_]*)/gi, (_, key) => String(env[key] || ''));
  if (expanded.startsWith('~')) expanded = path.join(env.USERPROFILE || env.HOME || '', expanded.slice(1));
  return expanded;
}

function commandRuns(command, env) {
  if (!command) return false;
  const runtimeEnv = withToolPaths(env, [{ path: command }, { path: process.execPath }]);
  const outcome = spawnCommandSync(command, ['--version'], {
    env: runtimeEnv, encoding: 'utf8', timeout: 10000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return !outcome.error && outcome.status === 0;
}

function toolVersion(command, env = process.env) {
  if (!command) return null;
  const outcome = spawnCommandSync(command, ['--version'], {
    env: withToolPaths(env, [{ path: command }, { path: process.execPath }]),
    encoding: 'utf8', timeout: 10000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (outcome.error || outcome.status !== 0) return null;
  const lines = `${String(outcome.stdout || '')}\n${String(outcome.stderr || '')}`
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return [...lines].reverse().find((line) => /\d+\.\d+\.\d+/.test(line)) || lines[0] || null;
}

function versionTuple(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = versionTuple(left) || [0, 0, 0];
  const b = versionTuple(right) || [0, 0, 0];
  return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
}

function withToolPaths(env = process.env, tools = []) {
  const current = String(env.PATH || env.Path || env.path || '');
  const additions = [process.execPath, ...tools.map((tool) => tool?.path)]
    .filter(Boolean)
    .map((candidate) => path.dirname(expandPath(candidate, env)))
    .filter(Boolean);
  const entries = [...new Set([...additions, ...current.split(path.delimiter).filter(Boolean)])];
  return { ...env, PATH: entries.join(path.delimiter) };
}

function windowsCommandNames(command) {
  if (path.extname(command)) return [command];
  return [`${command}.cmd`, `${command}.bat`, `${command}.exe`, command];
}

function existingPathCandidates(command, env) {
  const names = windowsCommandNames(command).map((name) => name.toLowerCase());
  const pathValue = String(env.PATH || env.Path || env.path || '');
  const candidates = [];
  for (const directory of pathValue.split(path.delimiter).map((value) => value.trim()).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.resolve(expandPath(path.join(directory, name), env));
      if (fs.existsSync(candidate)) candidates.push(candidate);
    }
  }
  return [...new Set(candidates)];
}

function pathLookup(command, env) {
  if (process.platform === 'win32') {
    // Prefer executable shims over extensionless Unix companion files that
    // Yarn/npm may place beside them. This is important when the resolved
    // path is passed directly to child_process on Windows.
    const candidates = windowsCommandNames(command);
    const whereCandidates = [];
    for (const name of candidates) {
      const where = spawnCommandSync('where.exe', [name], {
        env, encoding: 'utf8', timeout: 5000, windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const entry of String(where.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
        if (fs.existsSync(entry)) whereCandidates.push(path.resolve(entry));
      }
    }
    // Evaluate every where.exe result, not just the first hit. A stale shim
    // earlier on PATH must not hide a valid NVM/Yarn installation later on.
    const runnable = [...new Set([...whereCandidates, ...existingPathCandidates(command, env)])]
      .filter((candidate) => commandRuns(candidate, env));
    if (command.toLowerCase() === 'firebase' && runnable.length > 1) {
      // Multiple global Firebase shims are common on Windows (for example
      // Yarn plus an NVM installation). Resolve the same supported binary on
      // every launch by choosing the highest installed CLI version. An
      // explicit WORKSIDEQA_FIREBASE_BIN override still wins before PATH.
      return runnable.sort((left, right) => compareVersions(toolVersion(right, env), toolVersion(left, env)))[0];
    }
    return runnable[0] || null;
  }
  const where = spawnCommandSync('sh', ['-lc', `command -v -- "$1"`, 'worksideqa', command], {
    env, encoding: 'utf8', timeout: 5000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const first = String(where.stdout || '').trim().split(/\r?\n/).find(Boolean);
  return first && commandRuns(first, env) ? first : (commandRuns(command, env) ? command : null);
}

function fallbackCandidates(name, env) {
  const userProfile = env.USERPROFILE || '';
  const localAppData = env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');
  const appData = env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
  const sdkRoots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, path.join(localAppData, 'Android', 'Sdk')].filter(Boolean);
  const candidates = [];
  if (name === 'node') candidates.push(process.execPath);
  if (name === 'npm') {
    candidates.push(path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm'));
    if (process.platform === 'win32') candidates.push(path.join(appData, 'npm', 'npm.cmd'));
  }
  if (name === 'firebase' && process.platform === 'win32') {
    candidates.push(
      path.join(localAppData, 'Yarn', 'Data', 'global', 'node_modules', '.bin', 'firebase.cmd'),
      path.join(localAppData, 'Yarn', 'bin', 'firebase.cmd'),
      path.join(appData, 'npm', 'firebase.cmd'),
      path.join(userProfile, '.yarn', 'bin', 'firebase.cmd'),
    );
  }
  if (name === 'adb' && process.platform === 'win32') candidates.push(...sdkRoots.map((root) => path.join(root, 'platform-tools', 'adb.exe')));
  if (name === 'maestro' && process.platform === 'win32') candidates.push(path.join(userProfile, '.maestro', 'bin', 'maestro.bat'));
  if (name === 'java' && env.JAVA_HOME) candidates.push(path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  return candidates;
}

function resolveTool(name, env = process.env) {
  const overrideKey = TOOL_OVERRIDES[name];
  const override = overrideKey && String(env[overrideKey] || '').trim();
  if (override) {
    const candidate = expandPath(override, env);
    if ((path.isAbsolute(candidate) && fs.existsSync(candidate) && commandRuns(candidate, env)) || (!path.isAbsolute(candidate) && commandRuns(candidate, env))) {
      return { name, path: path.isAbsolute(candidate) ? path.resolve(candidate) : candidate, source: 'local-config', overrideKey };
    }
    return { name, path: null, source: 'local-config', overrideKey, error: `Override ${overrideKey} does not resolve to a runnable executable: ${candidate}` };
  }
  const pathResult = pathLookup(name, env);
  if (pathResult) return { name, path: pathResult, source: 'PATH' };
  for (const candidate of fallbackCandidates(name, env)) {
    if (fs.existsSync(candidate) && commandRuns(candidate, env)) return { name, path: path.resolve(candidate), source: 'fallback' };
  }
  return { name, path: null, source: 'missing', error: `${name} is not available through PATH or supported fallback locations.` };
}

function resolveTools(env = process.env) {
  return Object.fromEntries(Object.keys(TOOL_OVERRIDES).map((name) => [name, resolveTool(name, env)]));
}

module.exports = {
  TOOL_OVERRIDES,
  expandPath,
  withToolPaths,
  resolveTool,
  resolveTools,
  toolVersion,
  compareVersions,
  windowsCommandNames,
  existingPathCandidates,
};
