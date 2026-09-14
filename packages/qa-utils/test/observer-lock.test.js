const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PassThrough } = require('node:stream');
const { acquireObserverLock, readLock } = require('../src');
const { runProcess } = require('../../qa-mobile/src/maestro-runner');
const { spawnMaestroSyncExclusive } = require('../../qa-mobile/src/maestro-process');

function temporaryLock() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worksideqa-observer-'));
  return { directory, path: path.join(directory, 'observer.lock') };
}

test('observer lock serializes a second observer and releases after success', () => {
  const fixture = temporaryLock();
  const first = acquireObserverLock(fixture.path, { product: 'merxus', stage: 'application' });
  assert.equal(first.ok, true);
  const second = acquireObserverLock(fixture.path, { product: 'merxus' });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'OBSERVER_BUSY');
  assert.equal(second.owner.pid, process.pid);
  first.release();
  const third = acquireObserverLock(fixture.path, { product: 'merxus' });
  assert.equal(third.ok, true);
  third.release();
  fs.rmSync(fixture.directory, { recursive: true, force: true });
});

test('stale observer lock is reclaimed only when its recorded owner is dead', () => {
  const fixture = temporaryLock();
  fs.mkdirSync(path.dirname(fixture.path), { recursive: true });
  fs.writeFileSync(fixture.path, JSON.stringify({ pid: 2147483647, product: 'merxus', stage: 'application' }));
  const lock = acquireObserverLock(fixture.path, { product: 'merxus' });
  assert.equal(lock.ok, true);
  assert.equal(readLock(fixture.path).pid, process.pid);
  lock.release();
  fs.rmSync(fixture.directory, { recursive: true, force: true });
});

test('unreadable lock fails closed instead of deleting unknown state', () => {
  const fixture = temporaryLock();
  fs.mkdirSync(path.dirname(fixture.path), { recursive: true });
  fs.writeFileSync(fixture.path, 'not-json');
  const lock = acquireObserverLock(fixture.path, { product: 'merxus' });
  assert.equal(lock.ok, false);
  assert.equal(lock.error.code, 'OBSERVER_BUSY');
  assert.equal(fs.existsSync(fixture.path), true);
  fs.rmSync(fixture.directory, { recursive: true, force: true });
});

test('Maestro feature execution cannot overlap an active rendered observer', async () => {
  const fixture = temporaryLock();
  const active = acquireObserverLock(fixture.path, { product: 'merxus', stage: 'rendered-runtime' });
  await assert.rejects(runProcess('maestro', ['test'], {
    cwd: process.cwd(), env: process.env, logStream: new PassThrough(), secretValues: [],
    timeoutMs: 1000, observerLockPath: fixture.path,
  }), (error) => error.code === 'OBSERVER_BUSY');
  active.release();
  fs.rmSync(fixture.directory, { recursive: true, force: true });
});

test('direct synchronous Maestro feature execution shares the observer mutex', () => {
  const fixture = temporaryLock();
  const active = acquireObserverLock(fixture.path, { product: 'merxus', stage: 'rendered-runtime' });
  assert.throws(
    () => spawnMaestroSyncExclusive(['test', 'flow.yaml'], { observerLockPath: fixture.path }),
    (error) => error.code === 'OBSERVER_BUSY',
  );
  active.release();
  fs.rmSync(fixture.directory, { recursive: true, force: true });
});
