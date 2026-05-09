(async function() {
  'use strict';

  const settings = await Storage.getSettings();

  document.getElementById('api-key').value = settings.claudeApiKey || '';
  document.getElementById('filter-mode').value = settings.filterMode || 'hide';

  document.getElementById('btn-save-key').addEventListener('click', async () => {
    const key = document.getElementById('api-key').value.trim();
    await Storage.saveSettings({ ...settings, claudeApiKey: key });
    settings.claudeApiKey = key;
    showToast('API Key 已保存');
  });

  document.getElementById('filter-mode').addEventListener('change', async (e) => {
    const mode = e.target.value;
    await Storage.saveSettings({ ...settings, filterMode: mode });
    settings.filterMode = mode;
    showToast('过滤模式已更新');
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
    showToast('数据已导出');
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
        showToast('文件格式无效');
        return;
      }

      await Storage.saveCategories(data.categories);
      showToast(`已导入 ${data.categories.length} 个分类`);
    } catch {
      showToast('导入失败：文件解析错误');
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
