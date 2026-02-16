(function runtimeKeepalive() {
  const HEARTBEAT_INTERVAL_MS = 5000;
  const HEARTBEAT_URL = '/api/runtime/heartbeat';
  const CLOSED_URL = '/api/runtime/browser-closed';
  const tabId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  let stopped = false;
  let heartbeatTimer = null;

  function postJson(url, payload, keepalive = false) {
    const body = JSON.stringify(payload);
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body,
      keepalive,
    }).catch(() => {});
  }

  function sendHeartbeat() {
    if (stopped) {
      return;
    }
    postJson(HEARTBEAT_URL, { tabId, at: Date.now() }, true);
  }

  function notifyClosed() {
    const payload = JSON.stringify({ tabId, at: Date.now() });
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function'
    ) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(CLOSED_URL, blob);
      return;
    }
    postJson(CLOSED_URL, { tabId, at: Date.now() }, true);
  }

  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  sendHeartbeat();

  window.addEventListener('focus', sendHeartbeat);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      sendHeartbeat();
    }
  });

  window.addEventListener('pagehide', () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    notifyClosed();
  });

  window.addEventListener('beforeunload', notifyClosed);
})();
