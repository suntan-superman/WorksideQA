const fs = require('node:fs');
const path = require('node:path');

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Cross-process lock for WorksideQA-owned Maestro/UiAutomation sessions.
 * wx is atomic on the local filesystem. A lock whose recorded owner is dead
 * is stale and may be removed; live owners are never adopted or interrupted.
 */
function acquireObserverLock(lockPath, metadata = {}) {
  const resolvedPath = path.resolve(lockPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  let owner = null;
  try {
    const fd = fs.openSync(resolvedPath, 'wx');
    owner = { pid: process.pid, startedAt: new Date().toISOString(), ...metadata };
    fs.writeFileSync(fd, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    fs.closeSync(fd);
    let released = false;
    return {
      ok: true,
      path: resolvedPath,
      owner,
      release() {
        if (released) return;
        released = true;
        try {
          const current = readLock(resolvedPath);
          if (current?.pid === process.pid) fs.unlinkSync(resolvedPath);
        } catch { /* cleanup is best effort; stale-owner recovery handles it */ }
      },
    };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    owner = readLock(resolvedPath);
    if (owner && processIsAlive(Number(owner.pid))) {
      const busy = new Error(`Maestro observer is already active (PID ${owner.pid}).`);
      busy.code = 'OBSERVER_BUSY';
      busy.lockPath = resolvedPath;
      busy.owner = owner;
      return { ok: false, path: resolvedPath, owner, error: busy };
    }
    // Only a demonstrably stale WorksideQA lock can be reclaimed. An invalid
    // lock is treated as busy rather than deleting unknown state.
    if (!owner) {
      const busy = new Error(`Maestro observer lock is unreadable: ${resolvedPath}`);
      busy.code = 'OBSERVER_BUSY';
      busy.lockPath = resolvedPath;
      return { ok: false, path: resolvedPath, owner: null, error: busy };
    }
    try { fs.unlinkSync(resolvedPath); } catch (unlinkError) {
      const busy = new Error(`Maestro observer lock could not be reclaimed: ${resolvedPath}`);
      busy.code = 'OBSERVER_BUSY';
      busy.lockPath = resolvedPath;
      busy.owner = owner;
      busy.cause = unlinkError;
      return { ok: false, path: resolvedPath, owner, error: busy };
    }
    return acquireObserverLock(resolvedPath, metadata);
  }
}

module.exports = { acquireObserverLock, processIsAlive, readLock };
