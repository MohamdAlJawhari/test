(function initContactDetailsPage() {
  const root = document.getElementById('contact-details-root');
  if (!root) {
    return;
  }

  const fileName = (root.dataset.fileName || '').trim();
  const statusBox = document.getElementById('details-status');
  const saveMetaButton = document.getElementById('save-meta-btn');
  const saveContentButton = document.getElementById('save-content-btn');
  const addRowButton = document.getElementById('add-row-btn');
  const addColButton = document.getElementById('add-col-btn');
  const displayNameInput = document.getElementById('display-name');
  const descriptionInput = document.getElementById('description');
  const headerRow = document.getElementById('editable-head-row');
  const body = document.getElementById('editable-body');

  if (
    !fileName ||
    !statusBox ||
    !displayNameInput ||
    !descriptionInput ||
    !headerRow ||
    !body
  ) {
    return;
  }

  function setStatus(ok, message) {
    statusBox.style.display = 'block';
    statusBox.className = `status ${ok ? 'ok' : 'error'}`;
    statusBox.textContent = message;
  }

  function getHeaderInputs() {
    return Array.from(headerRow.querySelectorAll('input.header-input'));
  }

  function getColumnCount() {
    return getHeaderInputs().length;
  }

  function createHeaderCell(value = '', locked = false) {
    const th = document.createElement('th');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'table-input header-input';
    input.value = value;
    if (locked) {
      input.dataset.locked = '1';
      input.readOnly = true;
      input.value = 'NUMBERS';
    }
    th.appendChild(input);
    return th;
  }

  function createBodyCell(value = '') {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'table-input cell-input';
    input.value = value;
    td.appendChild(input);
    return td;
  }

  function rebuildTableFromPreview(preview) {
    const headers = Array.isArray(preview?.headers) ? preview.headers : [];
    const rows = Array.isArray(preview?.rows) ? preview.rows : [];

    headerRow.innerHTML = '';
    body.innerHTML = '';

    for (const header of headers) {
      const normalized = String(header || '').trim().toUpperCase();
      headerRow.appendChild(createHeaderCell(header, normalized === 'NUMBERS'));
    }

    for (const rowValues of rows) {
      addRow(Array.isArray(rowValues) ? rowValues : []);
    }
  }

  function addRow(initialValues = []) {
    const cols = getColumnCount();
    if (cols === 0) {
      setStatus(false, 'Add at least one column first.');
      return;
    }

    const tr = document.createElement('tr');
    for (let col = 0; col < cols; col += 1) {
      tr.appendChild(createBodyCell(initialValues[col] || ''));
    }
    body.appendChild(tr);
  }

  function addColumn(initialHeader = '') {
    const nextColNumber = getColumnCount() + 1;
    const headerText = initialHeader || `Column ${nextColNumber}`;
    headerRow.appendChild(createHeaderCell(headerText, false));

    const rows = Array.from(body.querySelectorAll('tr'));
    for (const row of rows) {
      row.appendChild(createBodyCell(''));
    }
  }

  function collectTableData() {
    const headerInputs = getHeaderInputs();
    const headers = headerInputs.map((input) => input.value.trim());
    const rows = Array.from(body.querySelectorAll('tr')).map((rowEl) =>
      Array.from(rowEl.querySelectorAll('input.cell-input')).map((input) =>
        input.value
      )
    );
    return { headers, rows };
  }

  function validateHeaders(headers) {
    if (!headers.length) {
      return 'Contacts file must have at least one column.';
    }

    const normalized = headers.map((item) => item.trim().toUpperCase());
    const numbersHeaders = normalized.filter((item) => item === 'NUMBERS');
    if (numbersHeaders.length !== 1) {
      return 'You must keep exactly one "NUMBERS" column.';
    }

    const unique = new Set(normalized);
    if (unique.size !== normalized.length) {
      return 'Column names must be unique.';
    }

    const lockedHeaderInput = getHeaderInputs().find(
      (input) => input.dataset.locked === '1'
    );
    if (lockedHeaderInput && lockedHeaderInput.value.trim().toUpperCase() !== 'NUMBERS') {
      return 'The main column name must remain "NUMBERS".';
    }

    return '';
  }

  async function saveMetadata() {
    const displayName = displayNameInput.value.trim();
    const description = descriptionInput.value.trim();

    if (!displayName) {
      setStatus(false, 'Contacts file name cannot be empty.');
      return;
    }

    if (!saveMetaButton) {
      return;
    }

    saveMetaButton.disabled = true;
    try {
      const response = await fetch(
        `/api/contacts/${encodeURIComponent(fileName)}/metadata`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            display_name: displayName,
            description,
          }),
        }
      );

      let data = {};
      try {
        data = await response.json();
      } catch (_err) {
        throw new Error('Could not save file details.');
      }

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Could not save file details.');
      }

      setStatus(true, 'File details saved.');
    } catch (err) {
      setStatus(false, err && err.message ? err.message : 'Could not save file details.');
    } finally {
      saveMetaButton.disabled = false;
    }
  }

  async function saveContent() {
    const { headers, rows } = collectTableData();
    const validationError = validateHeaders(headers);
    if (validationError) {
      setStatus(false, validationError);
      return;
    }

    if (!saveContentButton) {
      return;
    }

    saveContentButton.disabled = true;
    try {
      const response = await fetch(
        `/api/contacts/${encodeURIComponent(fileName)}/content`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            headers,
            rows,
          }),
        }
      );

      let data = {};
      try {
        data = await response.json();
      } catch (_err) {
        throw new Error('Could not save contacts file content.');
      }

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Could not save contacts file content.');
      }

      if (data.preview) {
        rebuildTableFromPreview(data.preview);
      }

      setStatus(
        true,
        `Content saved (${data.summary?.rows ?? 0} rows, ${data.summary?.columns ?? 0} columns).`
      );
    } catch (err) {
      setStatus(
        false,
        err && err.message ? err.message : 'Could not save contacts file content.'
      );
    } finally {
      saveContentButton.disabled = false;
    }
  }

  if (saveMetaButton) {
    saveMetaButton.addEventListener('click', saveMetadata);
  }

  if (saveContentButton) {
    saveContentButton.addEventListener('click', saveContent);
  }

  if (addRowButton) {
    addRowButton.addEventListener('click', () => addRow());
  }

  if (addColButton) {
    addColButton.addEventListener('click', () => addColumn());
  }
})();
