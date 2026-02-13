const fs = require('fs');
const path = require('path');
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
const ACK_UI_WAIT_CAP_MS = Number(process.env.ACK_UI_WAIT_CAP_MS || 8000);
const LOGOUT_STEP_TIMEOUT_MS = Number(process.env.LOGOUT_STEP_TIMEOUT_MS || 8000);

let clientInstance = null;
let initPromise = null;

const authState = {
  status: 'idle',
  message: 'Press Send to start login and generate a QR code.',
  qrCode: null,
  updatedAt: new Date().toISOString(),
};

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
    setAuthState('authenticated', 'WhatsApp is ready.');
    return;
  }

  if (initPromise) {
    return;
  }

  setAuthState('initializing', 'Starting WhatsApp client...');

  initPromise = wppconnect
    .create({
      session: SESSION_NAME,
      headless: true,
      logQR: false,
      folderNameToken: TOKEN_BASE_DIR,
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
          setAuthState('authenticated', 'WhatsApp login confirmed.');
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
    })
    .then((client) => {
      clientInstance = client;
      setAuthState('authenticated', 'WhatsApp client is ready.');
      console.log('WhatsApp client is ready');

      client.onMessage((message) => {
        console.log('Incoming message from', message.from);
      });

      if (typeof client.onStateChange === 'function') {
        client.onStateChange((state) => {
          console.log('Client state changed:', state);

          const normalized = String(state || '').toUpperCase();
          if (
            normalized.includes('UNPAIRED') ||
            normalized.includes('DISCONNECTED')
          ) {
            clientInstance = null;
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
  cleanupSessionTokens();
  setAuthState(
    'idle',
    'Message sent and logged out. Next send will require a new QR code.',
    null
  );
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
app.post('/send-text', ensureClient, async (req, res) => {
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
      const ackController = new AbortController();
      const ackProbe = waitForMessageAck(
        sent?.id,
        MIN_ACK_TO_LOGOUT,
        to,
        { signal: ackController.signal }
      );
      ackResult = { status: 'ui_cap' };

      try {
        ackResult = await Promise.race([
          ackProbe,
          sleep(ACK_UI_WAIT_CAP_MS).then(() => ({ status: 'ui_cap' })),
        ]);
      } catch (err) {
        // Hard ACK errors still fail this request.
        throw err;
      }

      if (ackResult.status === 'ui_cap') {
        ackController.abort();
        console.warn(
          `ACK wait exceeded UI cap (${ACK_UI_WAIT_CAP_MS}ms) for text to ${to}; continuing.`
        );
      } else if (ackResult.status === 'timeout') {
        console.warn(
          `ACK timeout for text to ${to}; continuing logout (last ACK: ${ackResult.lastAck ?? 'unknown'})`
        );
      }

      await logoutAndReset();
    }
    console.log(`Text sent to ${to}: ${message}`);
    res.json({ ok: true, ackStatus: ackResult.status });
  } catch (e) {
    console.error('Error sending text:', e);
    res.status(500).json({ ok: false, error: e.toString() });
  }
});

// ============================
// 2) Send MEDIA endpoint
// ============================
// Expect: { to, filename, caption, base64 }
// base64 MUST look like: "data:video/mp4;base64,AAAA..."
app.post('/send-media', ensureClient, async (req, res) => {
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
      const ackController = new AbortController();
      const ackProbe = waitForMessageAck(
        sent?.id,
        MIN_ACK_TO_LOGOUT,
        to,
        { signal: ackController.signal }
      );
      ackResult = { status: 'ui_cap' };

      try {
        ackResult = await Promise.race([
          ackProbe,
          sleep(ACK_UI_WAIT_CAP_MS).then(() => ({ status: 'ui_cap' })),
        ]);
      } catch (err) {
        // Hard ACK errors still fail this request.
        throw err;
      }

      if (ackResult.status === 'ui_cap') {
        ackController.abort();
        console.warn(
          `ACK wait exceeded UI cap (${ACK_UI_WAIT_CAP_MS}ms) for media to ${to}; continuing.`
        );
      } else if (ackResult.status === 'timeout') {
        console.warn(
          `ACK timeout for media to ${to}; continuing logout (last ACK: ${ackResult.lastAck ?? 'unknown'})`
        );
      }

      await logoutAndReset();
    }
    console.log(`Media sent to ${to}: ${filename || 'file'}`);
    res.json({ ok: true, ackStatus: ackResult.status });
  } catch (e) {
    console.error('Error sending media:', e);
    res.status(500).json({ ok: false, error: e.toString() });
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

const HOST = process.env.API_HOST || '127.0.0.1';
const PORT = Number(process.env.API_PORT || 3000);
app.listen(PORT, HOST, () => {
  console.log(`HTTP API listening on http://${HOST}:${PORT}`);
});
