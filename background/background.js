importScripts('../lib/storage.js');

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenus();
});

let menuSetupInProgress = false;

async function setupContextMenus() {
  if (menuSetupInProgress) return;
  menuSetupInProgress = true;
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: 'lfc-root',
      title: '添加到分类',
      contexts: ['link'],
      targetUrlPatterns: ['https://www.linkedin.com/in/*', 'https://www.linkedin.com/company/*']
    });

    const categories = await Storage.getCategories();
    categories.forEach(cat => {
      chrome.contextMenus.create({
        id: 'lfc-cat-' + cat.id,
        parentId: 'lfc-root',
        title: cat.name,
        contexts: ['link'],
        targetUrlPatterns: ['https://www.linkedin.com/in/*', 'https://www.linkedin.com/company/*']
      });
    });

    chrome.contextMenus.create({
      id: 'lfc-new-category',
      parentId: 'lfc-root',
      title: '+ 新建分类',
      contexts: ['link'],
      targetUrlPatterns: ['https://www.linkedin.com/in/*', 'https://www.linkedin.com/company/*']
    });
  } catch (err) {
    console.warn('[ContextMenu] setup failed:', err.message);
  } finally {
    menuSetupInProgress = false;
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.categories) {
    setupContextMenus();
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!info.linkUrl || typeof info.linkUrl !== 'string') return;

  const match = info.linkUrl.match(/\/(in|company|school)\/([^/?]+)/);
  if (!match || !match[1] || !match[2]) return;
  const profilePath = `/${match[1]}/${match[2]}`;

  if (info.menuItemId === 'lfc-new-category') {
    try {
      chrome.tabs.sendMessage(tab.id, {
        type: 'promptNewCategory',
        profilePath
      });
    } catch {}
    return;
  }

  if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith('lfc-cat-')) {
    const catId = info.menuItemId.replace('lfc-cat-', '');
    const categories = await Storage.getCategories();
    const cat = categories.find(c => String(c.id) === catId);
    if (!cat) return;

    if (!Array.isArray(cat.members)) cat.members = [];
    if (cat.members.some(m => typeof m.profilePath === 'string' && m.profilePath === profilePath)) return;

    let authorName = profilePath;
    try {
      authorName = await chrome.tabs.sendMessage(tab.id, {
        type: 'getAuthorName',
        profilePath
      }) || profilePath;
    } catch {}

    cat.members.push({
      name: authorName || profilePath,
      profilePath,
      title: ''
    });

    await Storage.saveCategories(categories);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'callClaudeAPI') {
    handleClaudeAPI(message.data).then(sendResponse);
    return true;
  }
  if (message.type === 'ping') {
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'openPopup') {
    chrome.action.openPopup().catch(() => {});
    return false;
  }
});

// Service Worker 激活时重新建立右键菜单
self.addEventListener('activate', () => {
  setupContextMenus();
});

async function handleClaudeAPI(followingData) {
  try {
    const data = await chrome.storage.sync.get('settings');
    const settings = data.settings || {};
    const apiKey = settings.claudeApiKey;

    if (!apiKey) {
      return { error: '请先在设置页面配置 Claude API Key' };
    }

    const prompt = `你是一个帮助用户整理 LinkedIn 关注列表的助手。
根据以下关注列表中每个人的姓名、职位和简介，将他们分入合理的主题类别。

要求：
1. 类别名称简洁明了（2-4个字）
2. 每人至少归入一个类别，可以属于多个类别
3. 建议 3-8 个类别
4. 输出严格 JSON 格式，结构为：
[{"name": "类别名", "members": [{"name": "姓名", "profilePath": "/in/xxx", "title": "职位"}]}]

关注列表：
${JSON.stringify(followingData)}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const result = await response.json();

    if (result.error) {
      return { error: result.error.message };
    }

    const text = result.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return { error: 'AI 返回格式异常' };
    }

    return { suggestions: JSON.parse(jsonMatch[0]) };
  } catch (err) {
    return { error: err.message };
  }
}
