(function initContactDetailsPage() {
  const root = document.getElementById('contact-details-root');
  if (!root) {
    return;
  }

  const fileName = (root.dataset.fileName || '').trim();
  const statusBox = document.getElementById('details-status');
  const saveButton = document.getElementById('save-btn');
  const displayNameInput = document.getElementById('display-name');
  const descriptionInput = document.getElementById('description');

  if (!fileName || !statusBox || !saveButton || !displayNameInput || !descriptionInput) {
    return;
  }

  function setStatus(ok, message) {
    statusBox.style.display = 'block';
    statusBox.className = `status ${ok ? 'ok' : 'error'}`;
    statusBox.textContent = message;
  }

  async function saveMetadata() {
    const displayName = displayNameInput.value.trim();
    const description = descriptionInput.value.trim();

    if (!displayName) {
      setStatus(false, 'Excel name cannot be empty.');
      return;
    }

    saveButton.disabled = true;
    try {
      const response = await fetch(`/api/contacts/${encodeURIComponent(fileName)}/metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: displayName,
          description: description,
        }),
      });

      let data = {};
      try {
        data = await response.json();
      } catch (_err) {
        throw new Error('Could not save Excel details.');
      }

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Could not save Excel details.');
      }

      setStatus(true, 'Excel details saved.');
    } catch (err) {
      setStatus(false, err && err.message ? err.message : 'Could not save Excel details.');
    } finally {
      saveButton.disabled = false;
    }
  }

  saveButton.addEventListener('click', saveMetadata);
})();
