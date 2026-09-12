const fs = require('node:fs/promises');
const path = require('node:path');

function emptyCorrelationDiagnostics() {
  return { correlationCaptureSources: [], correlationUniqueCount: 0, uiCorrelation: null, backendCorrelation: null, correlationMatched: false };
}

function correlationError(message, diagnostics) {
  const error = new Error(message);
  error.correlationDiagnostics = diagnostics;
  return error;
}

function parseCorrelationSources(sources) {
  const diagnostics = emptyCorrelationDiagnostics();
  const records = new Map();
  let invalid = false;
  for (const { source, output } of sources) {
    // Match an emitted marker, including timestamped JsConsole output, but not
    // the quoted marker in Maestro's echo of the evalScript source command.
    const captures = [...String(output || '').matchAll(/(?:^|\s)WORKSIDEQA_CORRELATION=([^\r\n]*)/gm)];
    if (captures.length) diagnostics.correlationCaptureSources.push(source);
    for (const capture of captures) {
      try {
        const record = JSON.parse(capture[1].trim());
        if (!record || Array.isArray(record) || Object.keys(record).some((key) => !['requestId', 'operationId'].includes(key))) throw Error();
        for (const key of ['requestId', 'operationId']) {
          if (typeof record[key] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record[key]) || record[key].trim() !== record[key]) throw Error();
        }
        const normalized = { requestId: record.requestId, operationId: record.operationId };
        records.set(JSON.stringify(normalized), normalized);
      } catch {
        invalid = true;
      }
    }
  }
  diagnostics.correlationCaptureSources = [...new Set(diagnostics.correlationCaptureSources)];
  diagnostics.correlationUniqueCount = records.size;
  if (records.size === 1) diagnostics.uiCorrelation = [...records.values()][0];
  // Never include malformed marker payloads or unrelated log text in errors.
  if (invalid) throw correlationError('Malformed UI correlation marker', diagnostics);
  if (records.size !== 1) throw correlationError('Expected exactly one unique UI correlation capture', diagnostics);
  return diagnostics;
}

async function collectCorrelationSources({ stdout = '', stderr = '', artifactDirectory, applicationFlowNames = ['runtime-flow', 'runtime-resume'], notBeforeMs = 0 }) {
  const sources = [{ source: 'runner/stdout', output: stdout }, { source: 'runner/stderr', output: stderr }];
  if (!artifactDirectory) return sources;
  const root = path.resolve(artifactDirectory);
  // Never follow a symlink/junction into another run, even for the root itself.
  if ((await fs.lstat(root)).isSymbolicLink()) throw Error('Unsafe correlation artifact directory');
  const names = new Set(applicationFlowNames.map((name) => path.win32.basename(name).replace(/\.ya?ml$/i, '')));
  let entriesSeen = 0, bytesRead = 0;
  async function visit(directory, depth = 0) {
    if (depth > 12) throw Error('Correlation artifact discovery limit exceeded');
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++entriesSeen > 10000) throw Error('Correlation artifact discovery limit exceeded');
      if (entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename, depth + 1);
      else if (entry.isFile() && entry.name === 'maestro.log' && path.basename(directory) === 'logs' && names.has(path.basename(path.dirname(directory)))) {
        const stat = await fs.lstat(filename);
        if (stat.isSymbolicLink() || stat.mtimeMs < notBeforeMs) continue;
        bytesRead += stat.size;
        if (stat.size > 8 * 1024 * 1024 || bytesRead > 32 * 1024 * 1024) throw Error('Correlation artifact size limit exceeded');
        sources.push({ source: filename, output: await fs.readFile(filename, 'utf8') });
      }
    }
  }
  await visit(root);
  return sources;
}

module.exports = { collectCorrelationSources, parseCorrelationSources, emptyCorrelationDiagnostics, correlationError };
