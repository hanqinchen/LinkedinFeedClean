(async function() {
  'use strict';

  const settings = await Storage.getSettings();

  document.getElementById('api-key').value = settings.claudeApiKey || '';
  document.getElementById('filter-mode').value = settings.filterMode || 'hide';

  document.getElementById('btn-save-key').addEventListener('click', async () => {
    const key = document.getElementById('api-key').value.trim();
    await Storage.saveSettings({ ...settings, claudeApiKey: key });
    settings.claudeApiKey = key;
    showToast('API Key saved');
  });

  document.getElementById('filter-mode').addEventListener('change', async (e) => {
    const mode = e.target.value;
    await Storage.saveSettings({ ...settings, filterMode: mode });
    settings.filterMode = mode;
    showToast('Filter mode updated');
  });

  document.getElementById('btn-export').addEventListener('click', async () => {
    const categories = await Storage.getCategories();
    const blob = new Blob([JSON.stringify({ categories, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'linkedin-feed-categorizer-backup.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Data exported');
  });

  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('file-import').click();
  });

  document.getElementById('file-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!Array.isArray(data.categories)) {
        showToast('Invalid file format');
        return;
      }

      await Storage.saveCategories(data.categories);
      showToast(`Imported ${data.categories.length} categories`);
    } catch {
      showToast('Import failed: file parse error');
    }

    e.target.value = '';
  });

  function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  }
})();
