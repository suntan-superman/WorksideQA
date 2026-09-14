const { spawnCommandSync } = require('../../qa-utils/src');
const { resolveTool } = require('../../qa-core/src/tool-resolver');

const DISMISS_STRATEGY = 'android-keyevent-escape';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 250;

function createDismissError(reason, diagnostics = {}) {
  const error = new Error(`ANDROID_IME_DISMISS_FAILED: ${reason}`);
  error.code = 'ANDROID_IME_DISMISS_FAILED';
  error.diagnostics = {
    keyboardDismissStrategy: DISMISS_STRATEGY,
    reason,
    ...diagnostics,
  };
  return error;
}

function commandExitCode(outcome) {
  return outcome?.status ?? outcome?.code ?? null;
}

function defaultExecute(command, args, environment, timeoutMs = 5000) {
  return spawnCommandSync(command, args, {
    env: environment,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseAndroidImeState(inputMethodOutput, windowOutput) {
  const inputShownValues = [...String(inputMethodOutput || '').matchAll(/\bmInputShown=(true|false)\b/g)];
  const inputShown = inputShownValues.length > 0
    ? inputShownValues.at(-1)[1] === 'true'
    : null;
  const inputMethodWindow = String(windowOutput || '').match(
    /Window #\d+ Window\{[^\r\n]*\bInputMethod\}:[\s\S]*?(?=\r?\n\s*Window #\d+|$)/
  )?.[0] || '';
  const windowOnScreen = inputMethodWindow
    ? /\bisOnScreen=true\b/.test(inputMethodWindow)
    : null;
  const windowVisible = inputMethodWindow
    ? /\bisVisible=true\b/.test(inputMethodWindow)
    : null;
  const activeMethod = String(inputMethodOutput || '').match(/\bmCurMethodId=([^\s]+)/)?.[1] || null;
  const focusedWindow = String(windowOutput || '').match(/\bmCurrentFocus=([^\r\n]+)/)?.[1]?.trim() || null;
  const visibilityKnown = inputShown !== null || inputMethodWindow.length > 0;

  return {
    visibilityKnown,
    imeVisible: inputShown === true || (windowOnScreen === true && windowVisible === true),
    inputShown,
    windowOnScreen,
    windowVisible,
    activeImePackage: activeMethod ? activeMethod.split('/')[0] : null,
    focusedWindow,
  };
}

async function inspectAndroidIme({ adbPath, deviceId, environment, execute = defaultExecute, deadlineMs = null, now = Date.now }) {
  const invoke = async (args, label) => {
    const commandTimeoutMs = deadlineMs == null ? 5000 : deadlineMs - now();
    if (commandTimeoutMs <= 0) {
      throw createDismissError('IME inspection exceeded its bounded deadline', { deviceId });
    }
    const outcome = await execute(adbPath, ['-s', deviceId, 'shell', ...args], environment, commandTimeoutMs);
    const exitCode = commandExitCode(outcome);
    if (outcome?.error || exitCode !== 0) {
      throw createDismissError(`${label} failed`, {
        deviceId,
        exitCode,
        stderr: String(outcome?.stderr || outcome?.error?.message || '').trim().slice(0, 500) || null,
      });
    }
    return String(outcome?.stdout || '');
  };

  const inputMethodOutput = await invoke(['dumpsys', 'input_method'], 'input-method inspection');
  const windowOutput = await invoke(['dumpsys', 'window'], 'window inspection');
  const state = parseAndroidImeState(inputMethodOutput, windowOutput);
  if (!state.visibilityKnown) {
    throw createDismissError('Android did not expose a supported IME visibility signal', { deviceId });
  }
  return state;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function dismissAndroidIme(options = {}) {
  const deviceId = String(options.deviceId || '').trim();
  if (!deviceId) throw createDismissError('explicit Android device ID is required', { deviceId: null });

  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollIntervalMs = Number(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
    throw createDismissError('timeoutMs must be a bounded positive integer no greater than 30000', { deviceId });
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > timeoutMs) {
    throw createDismissError('pollIntervalMs must be a positive integer within timeoutMs', { deviceId });
  }

  const environment = options.environment || process.env;
  const adbResolution = options.adbPath
    ? { path: options.adbPath, source: 'provided' }
    : resolveTool('adb', environment);
  if (!adbResolution.path) {
    throw createDismissError(adbResolution.error || 'ADB executable could not be resolved', { deviceId });
  }

  const execute = options.execute || defaultExecute;
  const wait = options.wait || sleep;
  const now = options.now || Date.now;
  const startedAtMs = now();
  const deadlineMs = startedAtMs + timeoutMs;
  const before = await inspectAndroidIme({
    adbPath: adbResolution.path,
    deviceId,
    environment,
    execute,
    deadlineMs,
    now,
  });
  const base = {
    keyboardDismissStrategy: DISMISS_STRATEGY,
    deviceId,
    adbExecutable: adbResolution.path,
    activeImePackage: before.activeImePackage,
    focusedWindow: before.focusedWindow,
    imeVisibleBefore: before.imeVisible,
  };

  if (!before.imeVisible) {
    return {
      ...base,
      attempted: false,
      keyEvent: null,
      imeVisibleAfter: false,
      dismissElapsedMs: now() - startedAtMs,
    };
  }

  const keyEventTimeoutMs = deadlineMs - now();
  if (keyEventTimeoutMs <= 0) {
    throw createDismissError('IME dismissal exceeded its bounded deadline before KEYCODE_ESCAPE', {
      ...base,
      attempted: false,
      imeVisibleAfter: true,
      dismissElapsedMs: now() - startedAtMs,
    });
  }
  const keyEventOutcome = await execute(
    adbResolution.path,
    ['-s', deviceId, 'shell', 'input', 'keyevent', 'KEYCODE_ESCAPE'],
    environment,
    keyEventTimeoutMs
  );
  const keyEventExitCode = commandExitCode(keyEventOutcome);
  if (keyEventOutcome?.error || keyEventExitCode !== 0) {
    throw createDismissError('KEYCODE_ESCAPE command failed', {
      ...base,
      attempted: true,
      keyEvent: 'KEYCODE_ESCAPE',
      imeVisibleAfter: true,
      dismissElapsedMs: now() - startedAtMs,
      exitCode: keyEventExitCode,
      stderr: String(keyEventOutcome?.stderr || keyEventOutcome?.error?.message || '').trim().slice(0, 500) || null,
    });
  }

  let after;
  while (now() < deadlineMs) {
    after = await inspectAndroidIme({
      adbPath: adbResolution.path,
      deviceId,
      environment,
      execute,
      deadlineMs,
      now,
    });
    if (!after.imeVisible) {
      return {
        ...base,
        attempted: true,
        keyEvent: 'KEYCODE_ESCAPE',
        imeVisibleAfter: false,
        activeImePackage: after.activeImePackage || base.activeImePackage,
        focusedWindow: after.focusedWindow || base.focusedWindow,
        dismissElapsedMs: now() - startedAtMs,
      };
    }
    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) break;
    await wait(Math.min(pollIntervalMs, remainingMs));
  }

  throw createDismissError('IME remained visible after KEYCODE_ESCAPE', {
    ...base,
    attempted: true,
    keyEvent: 'KEYCODE_ESCAPE',
    imeVisibleAfter: true,
    activeImePackage: after?.activeImePackage || base.activeImePackage,
    focusedWindow: after?.focusedWindow || base.focusedWindow,
    dismissElapsedMs: now() - startedAtMs,
  });
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  DISMISS_STRATEGY,
  dismissAndroidIme,
  inspectAndroidIme,
  parseAndroidImeState,
};
