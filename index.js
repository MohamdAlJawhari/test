const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const wppconnect = require('@wppconnect-team/wppconnect');
const express = require('express');

const app = express();

// Allow big JSON bodies for base64 media
app.use(express.json({ limit: '50mb' }));

const SESSION_NAME = 'my-session';
const TOKEN_BASE_DIR = path.join(__dirname, 'tokens');
const ACK_WAIT_TIMEOUT_MS = Number(process.env.ACK_WAIT_TIMEOUT_MS || 90000);
const MIN_ACK_TO_LOGOUT = Number(process.env.MIN_ACK_TO_LOGOUT || 1);
const STRICT_ACK = process.env.STRICT_ACK === '1';
const LOGOUT_STEP_TIMEOUT_MS = Number(process.env.LOGOUT_STEP_TIMEOUT_MS || 8000);
const AUTO_CLOSE_MS = Number(process.env.AUTO_CLOSE_MS || 0);
const SHUTDOWN_WAIT_TIMEOUT_MS = Number(
  process.env.SHUTDOWN_WAIT_TIMEOUT_MS || 12000
);

let clientInstance = null;
let initPromise = null;
let recoveryPromise = null;
let httpServer = null;
let shutdownPromise = null;
let shutdownRequested = false;

app.use((req, res, next) => {
  if (shutdownRequested && req.path !== '/system/shutdown') {
    return res.status(503).json({
      ok: false,
      error: 'Node API is shutting down.',
    });
  }
  next();
});

const authState = {
  status: 'idle',
  message: 'Press Send to start login and generate a QR code.',
  qrCode: null,
  updatedAt: new Date().toISOString(),
};

const interfaceState = {
  displayInfo: null,
  mode: null,
  updatedAt: null,
};

function setInterfaceState(displayInfo, mode) {
  interfaceState.displayInfo = displayInfo || null;
  interfaceState.mode = mode || null;
  interfaceState.updatedAt = new Date().toISOString();
}

function clearInterfaceState() {
  setInterfaceState(null, null);
  interfaceState.updatedAt = null;
}

function isClientReadyForSend() {
  return (
    Boolean(clientInstance) &&
    interfaceState.displayInfo === 'NORMAL' &&
    interfaceState.mode === 'MAIN'
  );
}

function formatInterfaceLabel() {
  if (!interfaceState.displayInfo && !interfaceState.mode) {
    return '';
  }
  if (interfaceState.mode && interfaceState.displayInfo) {
    return `${interfaceState.mode} (${interfaceState.displayInfo})`;
  }
  return interfaceState.mode || interfaceState.displayInfo || '';
}

function setAuthState(status, message, qrCode = null) {
  authState.status = status;
  authState.message = message;
  authState.qrCode = qrCode;
  authState.updatedAt = new Date().toISOString();
}

function getAuthSnapshot() {
  return {
    status: authState.status,
    message: authState.message,
    qrCode: authState.qrCode,
    updatedAt: authState.updatedAt,
    readyForSend: isClientReadyForSend(),
    interfaceState: {
      displayInfo: interfaceState.displayInfo,
      mode: interfaceState.mode,
      updatedAt: interfaceState.updatedAt,
    },
  };
}

function normalizeQrCode(base64Qrimg) {
  if (!base64Qrimg) {
    return null;
  }

  if (base64Qrimg.startsWith('data:image')) {
    return base64Qrimg;
  }

  return `data:image/png;base64,${base64Qrimg}`;
}

function cleanupSessionTokens() {
  const sessionPath = path.join(TOKEN_BASE_DIR, SESSION_NAME);
  try {
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log(`Removed saved tokens from ${sessionPath}`);
    }
  } catch (err) {
    console.warn('Could not clean session tokens:', err.toString());
  }
}

function isBrowserProfileLockedError(err) {
  const text = String(err && err.message ? err.message : err || '').toLowerCase();
  return (
    text.includes('browser is already running') &&
    text.includes('tokens') &&
    text.includes(SESSION_NAME.toLowerCase())
  );
}

function cleanupSessionLockFiles() {
  const sessionPath = path.join(TOKEN_BASE_DIR, SESSION_NAME);
  const lockFiles = [
    path.join(sessionPath, 'SingletonLock'),
    path.join(sessionPath, 'SingletonCookie'),
    path.join(sessionPath, 'SingletonSocket'),
    path.join(sessionPath, 'Default', 'SingletonLock'),
    path.join(sessionPath, 'Default', 'SingletonCookie'),
    path.join(sessionPath, 'Default', 'SingletonSocket'),
  ];

  for (const filePath of lockFiles) {
    try {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
      }
    } catch (err) {
      console.warn(`Could not remove lock file ${filePath}:`, err.toString());
    }
  }
}

function runProcessCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const details = stderr || stdout || error.message || '';
        reject(new Error(details));
        return;
      }
      resolve((stdout || '').trim());
    });
  });
}

async function killStaleSessionBrowsers() {
  const sessionPath = path.join(TOKEN_BASE_DIR, SESSION_NAME);
  if (process.platform !== 'win32') {
    return 0;
  }

  const escapedPath = sessionPath.replace(/'/g, "''");
  const script = [
    `$sessionPath = '${escapedPath}'`,
    "$killed = 0",
    "$targets = Get-CimInstance Win32_Process | Where-Object {",
    "  $_.CommandLine -and",
    "  $_.CommandLine -like \"*${sessionPath}*\" -and",
    "  ($_.Name -match 'chrome|msedge|chromium')",
    "}",
    "foreach ($p in $targets) {",
    "  try {",
    "    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop",
    "    $killed++",
    "  } catch {}",
    "}",
    "Write-Output $killed",
  ].join('; ');

  try {
    const output = await runProcessCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ]);
    const killed = Number(output);
    return Number.isFinite(killed) ? killed : 0;
  } catch (err) {
    console.warn('Could not terminate stale browser processes:', err.toString());
    return 0;
  }
}

async function recoverFromLockedBrowserProfile() {
  const killedCount = await killStaleSessionBrowsers();
  cleanupSessionLockFiles();
  await sleep(700);
  return killedCount;
}

function withTimeout(promise, timeoutMs, timeoutLabel) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAckTimeoutError(minAck, lastAck) {
  return new Error(
    `Timed out waiting for ACK >= ${minAck} (last ACK: ${lastAck ?? 'unknown'})`
  );
}

function statusCodeForSendError(err) {
  const text = String(err && err.message ? err.message : err || '').toLowerCase();
  if (text.includes('wpp is not defined')) {
    return 503;
  }
  if (text.includes('timed out waiting for ack')) {
    return 504;
  }
  if (text.includes('ack failed')) {
    return 502;
  }
  if (text.includes('not ready')) {
    return 503;
  }
  return 500;
}

function isWppMissingError(err) {
  const text = String(err && err.message ? err.message : err || '').toLowerCase();
  return text.includes('wpp is not defined');
}

async function recoverFromWppMissing() {
  if (recoveryPromise) {
    return recoveryPromise;
  }

  recoveryPromise = (async () => {
    setAuthState(
      'initializing',
      'Recovering WhatsApp session after an internal WhatsApp Web error...'
    );

    if (clientInstance) {
      try {
        await withTimeout(clientInstance.close(), LOGOUT_STEP_TIMEOUT_MS, 'close');
      } catch (err) {
        console.warn('Close warning during recovery:', err.toString());
      }
    }

    clientInstance = null;
    clearInterfaceState();

    try {
      await recoverFromLockedBrowserProfile();
    } catch (_err) {
      // Best effort cleanup.
    }

    initClientIfNeeded();
  })().finally(() => {
    recoveryPromise = null;
  });

  return recoveryPromise;
}

function asBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
  }

  return Boolean(value);
}

function parseSerializedMessageId(value) {
  if (typeof value !== 'string' || !value) {
    return {};
  }

  const parts = value.split('_');
  if (parts.length >= 3) {
    return {
      serialized: value,
      fromMe: parts[0] === 'true',
      remote: parts[1],
      id: parts.slice(2).join('_'),
    };
  }

  return {
    serialized: value,
    id: value,
  };
}

function parseMessageKey(raw) {
  if (!raw) {
    return {};
  }

  if (typeof raw === 'string') {
    return parseSerializedMessageId(raw);
  }

  if (typeof raw === 'object') {
    if (typeof raw._serialized === 'string') {
      const parsed = parseSerializedMessageId(raw._serialized);
      if (!parsed.remote && typeof raw.remote === 'string') {
        parsed.remote = raw.remote;
      }
      if (!parsed.id && typeof raw.id === 'string') {
        parsed.id = raw.id;
      }
      if (typeof parsed.fromMe !== 'boolean' && typeof raw.fromMe === 'boolean') {
        parsed.fromMe = raw.fromMe;
      }
      return parsed;
    }

    const remote =
      typeof raw.remote === 'string'
        ? raw.remote
        : typeof raw.to === 'string'
          ? raw.to
          : undefined;
    const id = typeof raw.id === 'string' ? raw.id : undefined;
    const fromMe = typeof raw.fromMe === 'boolean' ? raw.fromMe : undefined;

    return {
      serialized:
        remote && id && typeof fromMe === 'boolean'
          ? `${fromMe ? 'true' : 'false'}_${remote}_${id}`
          : '',
      remote,
      id,
      fromMe,
    };
  }

  return parseSerializedMessageId(String(raw));
}

function messageKeysMatch(target, candidate) {
  if (!target || !candidate) {
    return false;
  }

  if (
    typeof target.serialized === 'string' &&
    target.serialized &&
    typeof candidate.serialized === 'string' &&
    candidate.serialized
  ) {
    if (target.serialized === candidate.serialized) {
      return true;
    }
  }

  if (target.id && candidate.id && target.id === candidate.id) {
    if (target.remote && candidate.remote) {
      return target.remote === candidate.remote;
    }
    return true;
  }

  return false;
}

function ackInvolvesRecipient(ackPayload, recipient) {
  if (!ackPayload || !recipient) {
    return false;
  }

  return ackPayload.to === recipient || ackPayload.from === recipient;
}

function buildCandidateMessageIds(targetKey) {
  const ids = new Set();

  if (targetKey?.serialized) {
    ids.add(targetKey.serialized);
  }

  if (targetKey?.remote && targetKey?.id) {
    ids.add(`true_${targetKey.remote}_${targetKey.id}`);
    ids.add(`false_${targetKey.remote}_${targetKey.id}`);
  }

  if (targetKey?.id && !targetKey?.remote) {
    ids.add(targetKey.id);
  }

  return [...ids];
}

async function readMessageAck(targetKey) {
  if (!clientInstance || typeof clientInstance.getMessageById !== 'function') {
    return null;
  }

  const candidateIds = buildCandidateMessageIds(targetKey);
  for (const id of candidateIds) {
    try {
      const msg = await clientInstance.getMessageById(id);
      const ack = Number(msg?.ack);
      if (Number.isFinite(ack)) {
        return { ack, id };
      }
    } catch (_err) {
      // Try next candidate id.
    }
  }

  return null;
}

async function waitForMessageAck(
  messageId,
  minAck = MIN_ACK_TO_LOGOUT,
  recipient = '',
  options = {}
) {
  const signal = options?.signal;
  if (!clientInstance) {
    return { status: 'skipped' };
  }

  if (signal?.aborted) {
    return { status: 'aborted' };
  }

  const targetKey = parseMessageKey(messageId);
  const canMatchById = Boolean(targetKey?.serialized || targetKey?.id);

  if (!canMatchById && !recipient) {
    return { status: 'skipped' };
  }

  let lastAck = null;

  const initial = await readMessageAck(targetKey);
  if (initial) {
    lastAck = initial.ack;
    if (initial.ack < 0) {
      throw new Error(`Message ACK failed (${initial.ack})`);
    }
    if (initial.ack >= minAck) {
      return { status: 'ack', ack: initial.ack };
    }
  }

  const waitOutcome = await new Promise((resolve, reject) => {
    let settled = false;
    let disposable = null;
    let abortHandler = null;

    const finish = (result, error = null) => {
      if (settled) {
        return;
      }
      settled = true;

      if (disposable && typeof disposable.dispose === 'function') {
        disposable.dispose();
      }

      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }

      clearTimeout(timeoutHandle);

      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const timeoutHandle = setTimeout(() => {
      finish({ status: 'timeout', lastAck });
    }, ACK_WAIT_TIMEOUT_MS);

    if (typeof clientInstance.onAck !== 'function') {
      return finish(
        null,
        new Error('ACK listener is not available in this WPPConnect version.')
      );
    }

    if (signal) {
      abortHandler = () => finish({ status: 'aborted' });
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    disposable = clientInstance.onAck((ackPayload) => {
      const ackValue = Number(ackPayload?.ack);
      if (!Number.isFinite(ackValue)) {
        return;
      }

      const ackKey = parseMessageKey(ackPayload?.id);
      const matchedById = canMatchById && messageKeysMatch(targetKey, ackKey);
      const matchedByRecipient =
        !canMatchById && ackInvolvesRecipient(ackPayload, recipient);

      if (!matchedById && !matchedByRecipient) {
        return;
      }

      lastAck = ackValue;

      if (ackValue < 0) {
        return finish(null, new Error(`Message ACK failed (${ackValue})`));
      }

      if (ackValue >= minAck) {
        return finish({ status: 'ack', ack: ackValue });
      }
    });
  });

  if (waitOutcome.status === 'ack') {
    return waitOutcome;
  }

  if (waitOutcome.status === 'aborted') {
    return waitOutcome;
  }

  const latest = await readMessageAck(targetKey);
  if (latest) {
    lastAck = latest.ack;
    if (latest.ack < 0) {
      throw new Error(`Message ACK failed (${latest.ack})`);
    }
    if (latest.ack >= minAck) {
      return { status: 'ack', ack: latest.ack };
    }
  }

  if (STRICT_ACK) {
    throw new Error(
      `Timed out waiting for ACK >= ${minAck} (last ACK: ${lastAck ?? 'unknown'})`
    );
  }

  return { status: 'timeout', lastAck };
}

function initClientIfNeeded() {
  if (clientInstance) {
    if (isClientReadyForSend()) {
      setAuthState('authenticated', 'WhatsApp is ready.');
    } else {
      setAuthState(
        'authenticated',
        `WhatsApp is connecting${formatInterfaceLabel() ? ` (${formatInterfaceLabel()})` : ''}. Please wait...`
      );
    }
    return;
  }

  if (initPromise) {
    return;
  }

  setAuthState('initializing', 'Starting WhatsApp client...');
  clearInterfaceState();

  const createOptions = {
      session: SESSION_NAME,
      headless: true,
      logQR: false,
      folderNameToken: TOKEN_BASE_DIR,
      autoClose: AUTO_CLOSE_MS,
      catchQR: (base64Qrimg, _asciiQR, attempts) => {
        setAuthState(
          'qr',
          `Scan this QR code with WhatsApp (attempt ${attempts}).`,
          normalizeQrCode(base64Qrimg)
        );
      },
      statusFind: (statusSession, session) => {
        console.log(`Session "${session}" status: ${statusSession}`);

        const status = String(statusSession || '').toLowerCase();
        if (status.includes('qr')) {
          if (authState.qrCode) {
            setAuthState('qr', authState.message, authState.qrCode);
          } else {
            setAuthState('initializing', 'QR code is being generated...');
          }
        } else if (status.includes('notlogged')) {
          if (authState.qrCode) {
            setAuthState(
              'qr',
              'Scan this QR code with WhatsApp.',
              authState.qrCode
            );
          } else {
            setAuthState('initializing', 'Waiting for QR scan...');
          }
        } else if (status.includes('logged') || status.includes('chat')) {
          setAuthState(
            'authenticated',
            'WhatsApp login confirmed. Waiting for WhatsApp Web to finish syncing...'
          );
        }
      },
      puppeteerOptions: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      },
    };

  const createClientWithRecovery = async () => {
    try {
      return await wppconnect.create(createOptions);
    } catch (err) {
      if (!isBrowserProfileLockedError(err)) {
        throw err;
      }

      console.warn(
        'Detected locked browser profile. Attempting one automatic recovery.'
      );
      setAuthState(
        'initializing',
        'Detected a locked browser profile. Recovering and retrying...'
      );

      const killedCount = await recoverFromLockedBrowserProfile();
      console.log(
        `Recovery cleanup finished (terminated ${killedCount} stale browser process(es)). Retrying startup.`
      );
      return wppconnect.create(createOptions);
    }
  };

  initPromise = createClientWithRecovery()
    .then((client) => {
      clientInstance = client;
      setAuthState(
        'authenticated',
        'WhatsApp login confirmed. Waiting for WhatsApp Web to finish syncing...'
      );
      console.log('WhatsApp client created');

      client.onMessage((message) => {
        console.log('Incoming message from', message.from);
      });

      if (typeof client.onInterfaceChange === 'function') {
        client.onInterfaceChange((state) => {
          setInterfaceState(state?.displayInfo, state?.mode);
          if (isClientReadyForSend()) {
            setAuthState('authenticated', 'WhatsApp is ready.');
          } else {
            setAuthState(
              'authenticated',
              `WhatsApp is connecting (${formatInterfaceLabel() || 'starting'}). Please wait...`
            );
          }
        });
      }

      if (typeof client.onStateChange === 'function') {
        client.onStateChange((state) => {
          console.log('Client state changed:', state);

          const normalized = String(state || '').toUpperCase();
          if (
            normalized.includes('UNPAIRED') ||
            normalized.includes('DISCONNECTED')
          ) {
            clientInstance = null;
            clearInterfaceState();
            setAuthState(
              'idle',
              'Session disconnected. Press Send to generate a new QR code.'
            );
          }
        });
      }
    })
    .catch((err) => {
      clientInstance = null;
      setAuthState('error', err.toString(), null);
      console.error('WPPConnect init error:', err);
    })
    .finally(() => {
      initPromise = null;
    });
}

async function logoutAndReset() {
  if (clientInstance) {
    try {
      await withTimeout(
        clientInstance.logout(),
        LOGOUT_STEP_TIMEOUT_MS,
        'logout'
      );
    } catch (err) {
      console.warn('Logout warning:', err.toString());
    }

    try {
      await withTimeout(
        clientInstance.close(),
        LOGOUT_STEP_TIMEOUT_MS,
        'close'
      );
    } catch (err) {
      console.warn('Close warning:', err.toString());
    }
  }

  clientInstance = null;
  clearInterfaceState();

  try {
    await killStaleSessionBrowsers();
  } catch (_err) {
    // Best effort.
  }
  cleanupSessionLockFiles();
  cleanupSessionTokens();
  setAuthState(
    'idle',
    'Logged out. Press Send to generate a new QR code.',
    null
  );
}

async function closeClientForShutdown() {
  if (initPromise) {
    try {
      await withTimeout(
        initPromise.catch(() => null),
        SHUTDOWN_WAIT_TIMEOUT_MS,
        'initPromise'
      );
    } catch (err) {
      console.warn(
        'Init wait warning during shutdown:',
        err && err.toString ? err.toString() : String(err)
      );
    }
  }

  if (clientInstance) {
    try {
      await withTimeout(
        clientInstance.close(),
        LOGOUT_STEP_TIMEOUT_MS,
        'close'
      );
    } catch (err) {
      console.warn(
        'Close warning during shutdown:',
        err && err.toString ? err.toString() : String(err)
      );
    }
  }

  clientInstance = null;
  clearInterfaceState();
}

async function closeHttpServer() {
  if (!httpServer) {
    return;
  }

  await withTimeout(
    new Promise((resolve) => {
      httpServer.close(() => resolve());
    }),
    SHUTDOWN_WAIT_TIMEOUT_MS,
    'httpServer.close'
  ).catch((err) => {
    console.warn(
      'HTTP close warning during shutdown:',
      err && err.toString ? err.toString() : String(err)
    );
  });
}

async function shutdownGracefully(reason = 'unknown') {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownRequested = true;
  shutdownPromise = (async () => {
    console.log(`Shutting down Node API (${reason})...`);
    setAuthState('idle', 'Node API is shutting down.');

    await closeClientForShutdown();
    cleanupSessionLockFiles();
    await closeHttpServer();
  })().catch((err) => {
    console.error('Shutdown error:', err);
  });

  return shutdownPromise;
}

function triggerProcessExit(reason, exitCode = 0) {
  shutdownGracefully(reason).finally(() => {
    process.exit(exitCode);
  });
}

function registerSignalHandler(signalName) {
  process.on(signalName, () => {
    triggerProcessExit(`signal:${signalName}`);
  });
}

// Small middleware to be sure client is ready
function ensureClient(req, res, next) {
  if (!clientInstance) {
    return res.status(503).json({
      ok: false,
      error: 'WhatsApp client is not ready. Please scan the QR code first.',
    });
  }
  next();
}

function ensureClientReady(req, res, next) {
  if (!clientInstance) {
    return res.status(503).json({
      ok: false,
      error: 'WhatsApp client is not ready. Please scan the QR code first.',
    });
  }

  if (!isClientReadyForSend()) {
    const label = formatInterfaceLabel();
    return res.status(503).json({
      ok: false,
      error: `WhatsApp is still connecting (${label || 'starting'}). Please wait a few seconds and try again.`,
    });
  }

  next();
}

// ============================
// Auth helper endpoints
// ============================
app.post('/auth/start', (_req, res) => {
  initClientIfNeeded();
  return res.json({
    ok: true,
    ...getAuthSnapshot(),
  });
});

app.get('/auth/status', (_req, res) => {
  if (!clientInstance && !initPromise && authState.status === 'authenticated') {
    setAuthState(
      'idle',
      'Session is not active. Press Send to generate a new QR code.'
    );
  }

  return res.json({
    ok: true,
    ...getAuthSnapshot(),
  });
});

// ============================
// 1) Send TEXT endpoint
// ============================
app.post('/send-text', ensureClientReady, async (req, res) => {
  const { to, message, keepSession } = req.body;
  const keepSessionEnabled = asBoolean(keepSession);

  if (!to || !message) {
    return res.status(400).json({
      ok: false,
      error: 'Missing "to" or "message"',
    });
  }

  try {
    const sent = await clientInstance.sendText(to, message);
    let ackResult = { status: 'skipped_keep_session' };

    if (!keepSessionEnabled) {
      ackResult = await waitForMessageAck(sent?.id, MIN_ACK_TO_LOGOUT, to);
      if (ackResult.status !== 'ack') {
        throw buildAckTimeoutError(MIN_ACK_TO_LOGOUT, ackResult.lastAck);
      }
    }
    console.log(`Text sent to ${to}: ${message}`);
    res.json({ ok: true, ackStatus: ackResult.status });
  } catch (e) {
    console.error('Error sending text:', e);
    if (isWppMissingError(e)) {
      await recoverFromWppMissing();
      return res.status(503).json({
        ok: false,
        error:
          'WhatsApp Web failed to initialize ("WPP is not defined"). The session is recovering; please wait 5-10 seconds and retry.',
      });
    }
    res.status(statusCodeForSendError(e)).json({ ok: false, error: e.toString() });
  }
});

// ============================
// 2) Send MEDIA endpoint
// ============================
// Expect: { to, filename, caption, base64 }
// base64 MUST look like: "data:video/mp4;base64,AAAA..."
app.post('/send-media', ensureClientReady, async (req, res) => {
  const { to, filename, caption, base64, keepSession } = req.body;
  const keepSessionEnabled = asBoolean(keepSession);

  if (!to || !base64) {
    return res.status(400).json({
      ok: false,
      error: 'Missing "to" or "base64"',
    });
  }

  try {
    const sent = await clientInstance.sendFile(
      to,
      base64,
      {
        filename: filename || 'file',
        caption: caption || '',
        type: 'auto-detect',
        waitForAck: true,
      }
    );
    let ackResult = { status: 'skipped_keep_session' };

    if (!keepSessionEnabled) {
      ackResult = await waitForMessageAck(sent?.id, MIN_ACK_TO_LOGOUT, to);
      if (ackResult.status !== 'ack') {
        throw buildAckTimeoutError(MIN_ACK_TO_LOGOUT, ackResult.lastAck);
      }
    }
    console.log(`Media sent to ${to}: ${filename || 'file'}`);
    res.json({ ok: true, ackStatus: ackResult.status });
  } catch (e) {
    console.error('Error sending media:', e);
    if (isWppMissingError(e)) {
      await recoverFromWppMissing();
      return res.status(503).json({
        ok: false,
        error:
          'WhatsApp Web failed to initialize ("WPP is not defined"). The session is recovering; please wait 5-10 seconds and retry.',
      });
    }
    res.status(statusCodeForSendError(e)).json({ ok: false, error: e.toString() });
  }
});

app.post('/session/logout', async (_req, res) => {
  try {
    await logoutAndReset();
    return res.json({ ok: true });
  } catch (e) {
    console.error('Error in session logout:', e);
    return res.status(500).json({ ok: false, error: e.toString() });
  }
});

app.post('/system/shutdown', (_req, res) => {
  res.json({ ok: true, message: 'Shutdown requested.' });
  setImmediate(() => {
    triggerProcessExit('api:/system/shutdown');
  });
});

const HOST = process.env.API_HOST || '127.0.0.1';
const PORT = Number(process.env.API_PORT || 3000);
httpServer = app.listen(PORT, HOST, () => {
  console.log(`HTTP API listening on http://${HOST}:${PORT}`);
});

registerSignalHandler('SIGINT');
registerSignalHandler('SIGTERM');
if (process.platform === 'win32') {
  registerSignalHandler('SIGBREAK');
}
