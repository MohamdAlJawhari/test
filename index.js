const wppconnect = require('@wppconnect-team/wppconnect');
const express = require('express');

const app = express();

// Allow big JSON bodies for base64 media
app.use(express.json({ limit: '50mb' }));

let clientInstance = null;

// Start WPPConnect (WhatsApp Web automation)
wppconnect.create({
  session: 'my-session',
  headless: true,
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
    console.log('✅ WhatsApp client is ready');

    client.onMessage((message) => {
      console.log('📩 Incoming message from', message.from);
    });
  })
  .catch((err) => {
    console.error('❌ WPPConnect init error', err);
  });

// Small middleware to be sure client is ready
function ensureClient(req, res, next) {
  if (!clientInstance) {
    return res.status(503).json({
      ok: false,
      error: 'WhatsApp client not ready yet',
    });
  }
  next();
}

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
    console.log(`✅ Text sent to ${to}: ${message}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ Error sending text', e);
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
    console.log(`✅ Media sent to ${to}: ${filename || 'file'}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ Error sending media', e);
    res.status(500).json({ ok: false, error: e.toString() });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 HTTP API listening on http://localhost:${PORT}`);
});
