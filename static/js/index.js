(function initSenderPage() {
  const form = document.getElementById('send-form');
  if (!form) {
    return;
  }

  const sendButton = document.getElementById('send-button');
  const statusBox = document.getElementById('status');
  const modal = document.getElementById('qr-modal');
  const qrMessage = document.getElementById('qr-message');
  const qrLoader = document.getElementById('qr-loader');
  const qrImage = document.getElementById('qr-image');
  const closeModalButton = document.getElementById('close-modal');
  const phoneInput = document.getElementById('phone-input');
  const contactsFileInput = document.getElementById('contacts-file-input');
  const existingContactsSelect = document.getElementById('existing-contacts-select');
  const messageInput = document.getElementById('message-input');
  const historyList = document.getElementById('history-list');
  const defaultMessageTemplate = messageInput.value;

  function setBanner(ok, message) {
    statusBox.className = `status ${ok ? 'ok' : 'error'}`;
    statusBox.textContent = message;
    statusBox.classList.remove('hidden');
  }

  function openModal() {
    modal.classList.remove('hidden');
  }

  function closeModal() {
    modal.classList.add('hidden');
  }

  function setLoadingMessage(message) {
    qrMessage.textContent = message;
    qrLoader.classList.remove('hidden');
    qrImage.classList.add('hidden');
    qrImage.removeAttribute('src');
  }

  function setQrMessage(message, qrCode) {
    qrMessage.textContent = message;
    qrLoader.classList.add('hidden');
    qrImage.src = qrCode;
    qrImage.classList.remove('hidden');
  }

  function setResultMessage(message) {
    qrMessage.textContent = message;
    qrLoader.classList.add('hidden');
    qrImage.classList.add('hidden');
    qrImage.removeAttribute('src');
  }

  function createUiError({ code = 'UNKNOWN_ERROR', message = 'Unexpected error.', status = 0, details = '' }) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.details = details;
    return error;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function humanizeApiError(code, fallbackMessage = '') {
    const map = {
      NODE_API_TIMEOUT: 'WhatsApp is taking too long to respond. Your internet may be slow. Please try again.',
      NODE_API_UNREACHABLE: 'Cannot reach WhatsApp service yet. Wait a few seconds and try again.',
      NODE_API_REQUEST_ERROR: 'Network issue while contacting WhatsApp service. Please check your connection.',
      NODE_API_BAD_RESPONSE: 'WhatsApp service returned an invalid response. Try restarting the app.',
      WHATSAPP_NOT_READY: 'WhatsApp is not ready. Keep the QR code open and scan it again.',
      DELIVERY_TIMEOUT: 'Sending is slower than expected. The message may still arrive. Check WhatsApp and retry if needed.',
      DELIVERY_FAILED: 'Message delivery failed. Verify the phone number and try again.',
      WHATSAPP_API_ERROR: 'WhatsApp service returned an error. Please try again.',
      AUTH_START_FAILED: 'Could not start WhatsApp login. Please retry.',
      AUTH_STATUS_FAILED: 'Could not read WhatsApp login status. Please retry.',
      MEDIA_TOO_LARGE: 'The selected media is too large. Choose a smaller file.',
      MISSING_CONTENT: 'Write a message or choose a media file.',
      MISSING_TARGET: 'Enter a phone number, upload an Excel file, or select an existing Excel file.',
      VALIDATION_ERROR: fallbackMessage || 'Please check your input and try again.',
      INVALID_CONTACTS_FILE: 'Upload a valid Excel file (.xlsx).',
      CONTACTS_SAVE_FAILED: 'Could not save uploaded Excel file. Check disk space and try again.',
      CONTACTS_METADATA_SAVE_FAILED: 'Could not save Excel details. Try again.',
      CONTACT_FILE_NOT_FOUND: 'The selected Excel file was not found.',
      CONTACTS_PREVIEW_FAILED: 'Could not read this Excel file.',
      INVALID_CONTACT_METADATA: 'Excel name cannot be empty.',
      INVALID_CONTACT_REFERENCE: 'Invalid Excel file reference.',
      EXCEL_PARSE_ERROR: 'Could not read the Excel file. Please check the format and try again.',
      EXCEL_EMPTY: 'Excel file is empty.',
      EXCEL_MISSING_NUMBERS: 'Excel file must contain a "NUMBERS" column in the first row.',
      EXCEL_NO_ROWS: 'No valid rows were found in Excel. Make sure NUMBERS has values.',
      MISSING_TEMPLATE_VARIABLE: 'One or more {{variables}} are missing from Excel columns.',
      EMPTY_ROW_MESSAGE: 'A row produced an empty message after replacing variables.',
      BATCH_ROW_FAILED: 'Failed while sending one of the Excel rows. Check your data and try again.',
      LOGOUT_FAILED: 'Message was sent but automatic logout failed. Restart the app before next send.',
      BROWSER_NETWORK_ERROR: 'Cannot reach local app server. Make sure python main.py is still running.',
      INVALID_SERVER_RESPONSE: 'Server returned an invalid response. Try restarting the app.',
      HTTP_413: 'The selected media is too large. Choose a smaller file.',
    };

    return map[code] || fallbackMessage || 'Something went wrong. Please try again.';
  }

  async function fetchWithRetry(url, options = {}) {
    const retryDelaysMs = [300, 900];
    let lastError = null;

    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      try {
        return await fetch(url, options);
      } catch (err) {
        lastError = err;
        if (attempt < retryDelaysMs.length) {
          await sleep(retryDelaysMs[attempt]);
        }
      }
    }

    throw lastError || new Error('Network request failed.');
  }

  async function fetchJson(url, options = {}) {
    let response;
    try {
      response = await fetchWithRetry(url, options);
    } catch (networkErr) {
      throw createUiError({
        code: 'BROWSER_NETWORK_ERROR',
        message: humanizeApiError('BROWSER_NETWORK_ERROR'),
        details: networkErr && networkErr.message ? networkErr.message : '',
      });
    }

    let data;
    try {
      data = await response.json();
    } catch (_err) {
      throw createUiError({
        code: 'INVALID_SERVER_RESPONSE',
        message: humanizeApiError('INVALID_SERVER_RESPONSE'),
        status: response.status,
      });
    }

    if (!response.ok || !data.ok) {
      const code = data.error_code || `HTTP_${response.status}`;
      const message = humanizeApiError(code, data.error || '');
      throw createUiError({
        code,
        message,
        status: response.status,
        details: data.details || data.error || '',
      });
    }

    return data;
  }

  function renderHistoryAndSelect(files) {
    const previousSelection = existingContactsSelect.value;
    existingContactsSelect.innerHTML = '';

    const placeholderOption = document.createElement('option');
    placeholderOption.value = '';
    placeholderOption.textContent = '-- Select saved Excel file --';
    existingContactsSelect.appendChild(placeholderOption);

    historyList.innerHTML = '';

    if (!files || files.length === 0) {
      const emptyItem = document.createElement('li');
      emptyItem.className = 'history-empty';
      emptyItem.textContent = 'No Excel files uploaded yet.';
      historyList.appendChild(emptyItem);
      return;
    }

    for (const file of files) {
      const li = document.createElement('li');
      li.className = 'history-item';

      const name = document.createElement('div');
      name.className = 'history-name';
      name.textContent = file.display_name || file.name || 'contacts.xlsx';

      const desc = document.createElement('div');
      desc.className = 'history-desc';
      desc.textContent = file.description || 'No description yet.';

      const meta = document.createElement('div');
      meta.className = 'history-meta';
      const modifiedAt = file.modified_at || '';
      const sizeLabel = file.size_label || '';
      meta.textContent = [modifiedAt, sizeLabel].filter(Boolean).join(' - ');

      const open = document.createElement('a');
      open.className = 'history-open';
      open.href = `/contacts/${encodeURIComponent(file.name)}`;
      open.textContent = 'Open';

      li.appendChild(name);
      li.appendChild(desc);
      li.appendChild(meta);
      li.appendChild(open);
      historyList.appendChild(li);

      const option = document.createElement('option');
      option.value = file.name;
      option.textContent = `${file.display_name || file.name} (${file.modified_at || ''})`;
      if (previousSelection && previousSelection === file.name) {
        option.selected = true;
      }
      existingContactsSelect.appendChild(option);
    }
  }

  async function refreshContactsHistory() {
    try {
      const result = await fetchJson('/api/contacts/history');
      renderHistoryAndSelect(result.files || []);
    } catch (_err) {
      // History refresh should never block the main flow.
    }
  }

  function updateModalFromStatus(data) {
    if (data.status === 'authenticated') {
      setLoadingMessage('Login confirmed. Sending now...');
      return true;
    }

    if (data.status === 'qr') {
      if (data.qrCode) {
        setQrMessage(data.message || 'Scan this QR code with WhatsApp.', data.qrCode);
      } else {
        setLoadingMessage('QR code is being generated. Please wait...');
      }
      return false;
    }

    if (data.status === 'error') {
      throw new Error(data.message || 'Failed to initialize WhatsApp login.');
    }

    setLoadingMessage(data.message || 'Preparing login...');
    return false;
  }

  async function waitForAuth() {
    const startData = await fetchJson('/api/auth/start', { method: 'POST' });
    if (updateModalFromStatus(startData)) {
      return;
    }

    const maxWaitMs = 180000;
    const pollIntervalMs = 2000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < maxWaitMs) {
      await sleep(pollIntervalMs);
      const statusData = await fetchJson('/api/auth/status');
      if (updateModalFromStatus(statusData)) {
        return;
      }
    }

    throw new Error('Timed out waiting for QR login.');
  }

  async function sendFormData() {
    const formData = new FormData(form);
    return fetchJson('/api/send', {
      method: 'POST',
      body: formData,
    });
  }

  closeModalButton.addEventListener('click', closeModal);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    statusBox.classList.add('hidden');

    const hasPhone = Boolean(phoneInput.value.trim());
    const hasExcelUpload = Boolean(contactsFileInput.files && contactsFileInput.files.length > 0);
    const hasExistingExcel = Boolean(existingContactsSelect.value);
    if (!hasPhone && !hasExcelUpload && !hasExistingExcel) {
      const message = humanizeApiError('MISSING_TARGET');
      setResultMessage(message);
      setBanner(false, message);
      return;
    }

    sendButton.disabled = true;
    openModal();
    setLoadingMessage('Preparing login...');

    try {
      await waitForAuth();
      const result = await sendFormData();
      const message = result.message || 'Sent successfully.';
      setResultMessage(message);
      setBanner(true, message);
      form.reset();
      messageInput.value = defaultMessageTemplate;
      if (hasExcelUpload) {
        await refreshContactsHistory();
      }
    } catch (err) {
      const message = err && err.message ? err.message : 'Unexpected error.';
      setResultMessage(message);
      setBanner(false, message);
    } finally {
      sendButton.disabled = false;
    }
  });

  refreshContactsHistory();
})();
