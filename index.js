const fs = require('fs');
const path = require('path');
const wppconnect = require('@wppconnect-team/wppconnect');
const express = require('express');

const app = express();

// Allow big JSON bodies for base64 media
app.use(express.json({ limit: '50mb' }));

const SESSION_NAME = 'my-session';
const TOKEN_BASE_DIR = path.join(__dirname, 'tokens');

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
      await clientInstance.logout();
    } catch (err) {
      console.warn('Logout warning:', err.toString());
    }

    try {
      await clientInstance.close();
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
  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({
      ok: false,
      error: 'Missing "to" or "message"',
    });
  }

  try {
    await clientInstance.sendText(to, message);
    await logoutAndReset();
    console.log(`Text sent to ${to}: ${message}`);
    res.json({ ok: true });
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
  const { to, filename, caption, base64 } = req.body;

  if (!to || !base64) {
    return res.status(400).json({
      ok: false,
      error: 'Missing "to" or "base64"',
    });
  }

  try {
    await clientInstance.sendFile(
      to,
      base64,
      filename || 'file',
      caption || ''
    );
    await logoutAndReset();
    console.log(`Media sent to ${to}: ${filename || 'file'}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error sending media:', e);
    res.status(500).json({ ok: false, error: e.toString() });
  }
});

const HOST = process.env.API_HOST || '127.0.0.1';
const PORT = Number(process.env.API_PORT || 3000);
app.listen(PORT, HOST, () => {
  console.log(`HTTP API listening on http://${HOST}:${PORT}`);
});
