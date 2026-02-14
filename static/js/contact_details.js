(function initContactDetailsPage() {
  const root = document.getElementById('contact-details-root');
  if (!root) {
    return;
  }

  const fileName = (root.dataset.fileName || '').trim();
  const statusBox = document.getElementById('details-status');
  const saveMetaButton = document.getElementById('save-meta-btn');
  const saveContentButton = document.getElementById('save-content-btn');
  const deleteFileButton = document.getElementById('delete-file-btn');
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

  function getDataHeaderCells() {
    return Array.from(headerRow.querySelectorAll('th.data-header-cell'));
  }

  function getHeaderInputs() {
    return getDataHeaderCells()
      .map((th) => th.querySelector('input.header-input'))
      .filter(Boolean);
  }

  function getColumnCount() {
    return getHeaderInputs().length;
  }

  function nextColumnLabel() {
    const usedNames = new Set(
      getHeaderInputs().map((input) => input.value.trim().toUpperCase())
    );
    let index = getColumnCount() + 1;
    let label = `Column ${index}`;
    while (usedNames.has(label.toUpperCase())) {
      index += 1;
      label = `Column ${index}`;
    }
    return label;
  }

  function createMiniButton(type, action, text, title) {
    const button = document.createElement('button');
    button.type = 'button';
    const normalizedText = String(text || '').trim();
    const normalizedAction = String(action || '').toLowerCase();
    const isPlus = normalizedText === '+' || normalizedAction.includes('insert');
    const isMinus = normalizedText === '-' || normalizedAction.includes('remove');
    button.className = `mini-btn ${type} ${isPlus ? 'mini-plus' : ''} ${isMinus ? 'mini-minus' : ''}`.trim();
    button.dataset.action = action;
    button.textContent = text;
    button.title = title;
    return button;
  }

  function createHeaderCell(value = '', locked = false) {
    const th = document.createElement('th');
    th.className = 'data-header-cell';

    const controls = document.createElement('div');
    controls.className = 'cell-controls col-controls';
    controls.appendChild(createMiniButton('col-action', 'remove-col', '-', 'Remove this column'));
    controls.appendChild(createMiniButton('col-action', 'insert-col', '+', 'Insert column to the right'));

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'table-input header-input';
    input.value = value;
    if (locked) {
      input.dataset.locked = '1';
      input.readOnly = true;
      input.value = 'NUMBERS';
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'header-cell-wrap';
    wrapper.appendChild(controls);
    wrapper.appendChild(input);

    th.appendChild(wrapper);
    return th;
  }

  function createRowActionsCell() {
    const td = document.createElement('td');
    td.className = 'row-actions-cell';

    const controls = document.createElement('div');
    controls.className = 'cell-controls row-controls';
    controls.appendChild(createMiniButton('row-action', 'remove-row', '-', 'Remove this row'));
    controls.appendChild(createMiniButton('row-action', 'insert-row', '+', 'Insert row below'));

    td.appendChild(controls);
    return td;
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

  function refreshControlIndices() {
    getDataHeaderCells().forEach((th, index) => {
      th.dataset.colIndex = String(index);
    });
    Array.from(body.querySelectorAll('tr')).forEach((tr, index) => {
      tr.dataset.rowIndex = String(index);
    });
  }

  function addRowAt(index, initialValues = []) {
    const cols = getColumnCount();
    if (cols === 0) {
      setStatus(false, 'Add at least one column first.');
      return false;
    }

    const tr = document.createElement('tr');
    tr.appendChild(createRowActionsCell());
    for (let col = 0; col < cols; col += 1) {
      tr.appendChild(createBodyCell(initialValues[col] || ''));
    }

    const rows = Array.from(body.querySelectorAll('tr'));
    const boundedIndex = Math.max(0, Math.min(index, rows.length));
    if (boundedIndex >= rows.length) {
      body.appendChild(tr);
    } else {
      body.insertBefore(tr, rows[boundedIndex]);
    }

    refreshControlIndices();
    return true;
  }

  function removeRowAt(index) {
    const rows = Array.from(body.querySelectorAll('tr'));
    if (!rows.length || index < 0 || index >= rows.length) {
      return;
    }

    if (rows.length <= 1) {
      setStatus(false, 'At least one row should remain. Clear its values if needed.');
      return;
    }

    rows[index].remove();
    refreshControlIndices();
  }

  function addColumnAt(index, initialHeader = '', locked = false) {
    const dataHeaderCells = getDataHeaderCells();
    const boundedIndex = Math.max(0, Math.min(index, dataHeaderCells.length));
    const headerText = initialHeader || nextColumnLabel();
    const normalized = String(headerText).trim().toUpperCase();
    const headerCell = createHeaderCell(headerText, locked || normalized === 'NUMBERS');

    if (boundedIndex >= dataHeaderCells.length) {
      headerRow.appendChild(headerCell);
    } else {
      headerRow.insertBefore(headerCell, dataHeaderCells[boundedIndex]);
    }

    Array.from(body.querySelectorAll('tr')).forEach((row) => {
      const cell = createBodyCell('');
      const insertBeforeCell = row.children[boundedIndex + 1] || null;
      row.insertBefore(cell, insertBeforeCell);
    });

    refreshControlIndices();
  }

  function removeColumnAt(index) {
    const dataHeaderCells = getDataHeaderCells();
    if (!dataHeaderCells.length || index < 0 || index >= dataHeaderCells.length) {
      return;
    }

    if (dataHeaderCells.length <= 1) {
      setStatus(false, 'At least one column should remain.');
      return;
    }

    const targetHeader = dataHeaderCells[index];
    const input = targetHeader.querySelector('input.header-input');
    if (input && input.dataset.locked === '1') {
      setStatus(false, 'The "NUMBERS" column cannot be removed.');
      return;
    }

    targetHeader.remove();
    Array.from(body.querySelectorAll('tr')).forEach((row) => {
      const targetCell = row.children[index + 1];
      if (targetCell) {
        targetCell.remove();
      }
    });

    refreshControlIndices();
  }

  function collectTableData() {
    const headerInputs = getHeaderInputs();
    const headers = headerInputs.map((input) => input.value.trim());
    const rows = Array.from(body.querySelectorAll('tr')).map((rowEl) =>
      Array.from(rowEl.querySelectorAll('input.cell-input')).map((input) => input.value)
    );
    return { headers, rows };
  }

  function readPreviewFromDom() {
    const headers = Array.from(headerRow.querySelectorAll('input.header-input')).map(
      (input) => input.value
    );
    const rows = Array.from(body.querySelectorAll('tr')).map((rowEl) =>
      Array.from(rowEl.querySelectorAll('input.cell-input')).map((input) => input.value)
    );
    return { headers, rows };
  }

  function rebuildTableFromPreview(preview) {
    const sourceHeaders = Array.isArray(preview?.headers) ? preview.headers : [];
    const sourceRows = Array.isArray(preview?.rows) ? preview.rows : [];
    const headers = sourceHeaders.length ? sourceHeaders : ['NUMBERS'];
    const rows = sourceRows.length ? sourceRows : [new Array(headers.length).fill('')];

    headerRow.innerHTML = '';
    body.innerHTML = '';

    const rowActionsHeader = document.createElement('th');
    rowActionsHeader.className = 'row-actions-head';
    rowActionsHeader.textContent = 'Row';
    headerRow.appendChild(rowActionsHeader);

    headers.forEach((headerText) => {
      const normalized = String(headerText || '').trim().toUpperCase();
      headerRow.appendChild(createHeaderCell(headerText, normalized === 'NUMBERS'));
    });

    rows.forEach((rowValues) => {
      const tr = document.createElement('tr');
      tr.appendChild(createRowActionsCell());
      for (let col = 0; col < headers.length; col += 1) {
        const value = Array.isArray(rowValues) ? rowValues[col] || '' : '';
        tr.appendChild(createBodyCell(value));
      }
      body.appendChild(tr);
    });

    refreshControlIndices();
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

  async function deleteFile() {
    const label = displayNameInput.value.trim() || fileName;
    const confirmed = window.confirm(
      `Delete "${label}"?\nThis action cannot be undone.`
    );
    if (!confirmed) {
      return;
    }

    if (!deleteFileButton) {
      return;
    }

    deleteFileButton.disabled = true;
    try {
      const response = await fetch(`/api/contacts/${encodeURIComponent(fileName)}`, {
        method: 'DELETE',
      });

      let data = {};
      try {
        data = await response.json();
      } catch (_err) {
        throw new Error('Could not delete contacts file.');
      }

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Could not delete contacts file.');
      }

      setStatus(true, 'Contacts file deleted. Redirecting to sender...');
      setTimeout(() => {
        window.location.href = '/';
      }, 500);
    } catch (err) {
      setStatus(
        false,
        err && err.message ? err.message : 'Could not delete contacts file.'
      );
      deleteFileButton.disabled = false;
    }
  }

  headerRow.addEventListener('click', (event) => {
    const button = event.target.closest('button.col-action');
    if (!button) {
      return;
    }

    const headerCell = button.closest('th.data-header-cell');
    if (!headerCell) {
      return;
    }

    const colIndex = Number(headerCell.dataset.colIndex);
    if (!Number.isInteger(colIndex)) {
      return;
    }

    if (button.dataset.action === 'insert-col') {
      addColumnAt(colIndex + 1);
      return;
    }

    if (button.dataset.action === 'remove-col') {
      removeColumnAt(colIndex);
    }
  });

  body.addEventListener('click', (event) => {
    const button = event.target.closest('button.row-action');
    if (!button) {
      return;
    }

    const row = button.closest('tr');
    if (!row) {
      return;
    }

    const rowIndex = Number(row.dataset.rowIndex);
    if (!Number.isInteger(rowIndex)) {
      return;
    }

    if (button.dataset.action === 'insert-row') {
      addRowAt(rowIndex + 1);
      return;
    }

    if (button.dataset.action === 'remove-row') {
      removeRowAt(rowIndex);
    }
  });

  rebuildTableFromPreview(readPreviewFromDom());

  if (saveMetaButton) {
    saveMetaButton.addEventListener('click', saveMetadata);
  }

  if (saveContentButton) {
    saveContentButton.addEventListener('click', saveContent);
  }

  if (deleteFileButton) {
    deleteFileButton.addEventListener('click', deleteFile);
  }
})();
