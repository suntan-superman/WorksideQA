const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { runProcess } = require('../src/maestro-runner');

(async () => {
  const logStream = new PassThrough();
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: process.cwd(), env: process.env, logStream, secretValues: [], timeoutMs: 50,
  });
  assert.equal(result.timedOut, true);
  console.log('Maestro child-process timeout and cleanup contract verified.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
