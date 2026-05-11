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
      title: 'Add to Category',
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
      title: '+ New Category',
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

// Recreate context menus when Service Worker activates
self.addEventListener('activate', () => {
  setupContextMenus();
});

async function handleClaudeAPI(followingData) {
  try {
    const data = await chrome.storage.sync.get('settings');
    const settings = data.settings || {};
    const apiKey = settings.claudeApiKey;

    if (!apiKey) {
      return { error: 'Please configure Claude API Key in settings' };
    }

    const prompt = `You are an assistant helping users organize their LinkedIn following list.
Based on the name, position, and bio of each person in the following list, categorize them into appropriate thematic categories.

Requirements:
1. Category names should be concise (2-4 words)
2. Each person must belong to at least one category, can belong to multiple
3. Suggest 3-8 categories
4. Output strictly in JSON format with structure:
[{"name": "CategoryName", "members": [{"name": "PersonName", "profilePath": "/in/xxx", "title": "Position"}]}]

Following list:
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
      return { error: 'AI returned invalid format' };
    }

    return { suggestions: JSON.parse(jsonMatch[0]) };
  } catch (err) {
    return { error: err.message };
  }
}
