(function() {
  'use strict';

  const COLORS = ['#007AFF', '#5856D6', '#FF2D55', '#34C759', '#FF9500', '#5AC8FA', '#AF52DE', '#FF3B30'];
  const DEFAULT_ICONS = ['🤖', '🚀', '💰', '🎨', '📚', '💡', '🎯', '🌟'];

  let categories = [];
  let editingCategoryId = null;
  let currentView = 'categories';
  let aiSuggestions = null;
  let detectedProfile = null;

  const views = {
    categories: document.getElementById('view-categories'),
    editCategory: document.getElementById('view-edit-category'),
    categoryDetail: document.getElementById('view-category-detail'),
    aiReview: document.getElementById('view-ai-review'),
    quickAdd: document.getElementById('view-quick-add')
  };

  function parseProfilePath(input) {
    const match = input.match(/\/(in|company|school|showcase)\/([^/?#]+)/);
    if (match) return `/${match[1]}/${match[2]}`;
    return null;
  }

  // 统一成员匹配函数：以 LinkedIn URN 为唯一稳定标识
  // 匹配优先级（从最可靠到兜底）：
  // 1. linkedinId 精确匹配（最可靠）
  // 2. profilePath 精确匹配
  // 3. 从 profilePath 提取 URN 进行匹配（解决两种 URL 格式兼容问题）
  function memberMatches(member, profilePath, linkedinId) {
    // 1. 最高优先级：linkedinId 精确匹配（URN 永远不变）
    if (linkedinId && member.linkedinId === linkedinId) return true;
    // 2. 次高优先级：profilePath 精确匹配
    if (member.profilePath === profilePath) return true;
    // 🔑 3. 兜底：从两种 profilePath 中提取 URN 进行比较
    //    解决 LinkedIn 两种 URL 格式不兼容问题
    if (linkedinId && member.profilePath) {
      const memberUrn = member.profilePath.split('/').pop();
      if (memberUrn && (memberUrn === linkedinId || linkedinId.includes(memberUrn))) {
        return true;
      }
    }
    return false;
  }

  // 把 profilePath 格式转换为友好名称
  function cleanMemberName(name) {
    if (!name) return '';

    // 处理纯 LinkedIn ID 格式（ACo 开头或长度 > 30 的无空格字符串）
    if (name.startsWith('ACo') || (name.length > 30 && !name.includes(' '))) {
      const words = name.split(/-|_/).filter(w => w.length > 1 && w.length < 15);
      if (words.length > 0) {
        return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }
      return name.slice(0, 15) + '...';
    }

    // 如果是 URL 路径格式
    if (name.startsWith('/in/') || name.startsWith('/company/') || name.startsWith('/school/')) {
      const parts = name.split('/').filter(Boolean);
      if (parts.length >= 2) {
        let slug = parts[1];
        // 处理 LinkedIn ID 格式（通常是 ACo 开头的长字符串）
        if (slug.startsWith('ACo') || slug.length > 30) {
          // 提取第一个短单词或截断显示
          const words = slug.split(/-|_/).filter(w => w.length > 1 && w.length < 15);
          if (words.length > 0) {
            return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
          }
          return slug.slice(0, 15) + '...';
        }
        // 普通 slug 转成首字母大写的空格分隔
        return slug.split(/-|_/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }
    }
    return name;
  }

  // 检测扩展上下文是否有效
  function isExtensionContextValid() {
    try {
      return typeof chrome !== 'undefined' && chrome.storage && chrome.runtime && !chrome.runtime.lastError;
    } catch {
      return false;
    }
  }

  async function init() {
    bindEvents();

    // 第一步：检测扩展上下文是否有效
    if (!isExtensionContextValid()) {
      document.getElementById('context-invalid').classList.remove('hidden');
      // 即使 chrome API 失效，localStorage 还在，提示用户如何恢复
      try {
        const backup = localStorage.getItem('linkedin_feed_categorizer_data_cats');
        if (backup && backup !== '[]') {
          const backupData = JSON.parse(backup);
          const hint = document.createElement('p');
          hint.style.cssText = 'margin-top: 10px; font-size: 12px; color: #856404;';
          hint.textContent = `✅ 检测到 ${backupData.length} 个分类的备份数据，重新加载扩展后可一键恢复`;
          document.getElementById('context-invalid').appendChild(hint);
        }
      } catch {}
      return;
    }

    try {
      categories = await Storage.getCategories();
    } catch (err) {
      console.warn('读取分类数据失败:', err);
      categories = [];
    }

    // 确保每个分类的 members 都是数组
    let needsSave = false;
    categories.forEach(cat => {
      if (!Array.isArray(cat.members)) {
        cat.members = [];
      }
      // 自动修正 name 为 profilePath 的情况
      cat.members.forEach(member => {
        if (member.name === member.profilePath ||
            member.name?.startsWith('/in/') ||
            member.name?.startsWith('/company/') ||
            member.name?.startsWith('/school/')) {
          member.name = cleanMemberName(member.name || member.profilePath);
          needsSave = true;
        }
      });
    });
    // 有修正就保存
    if (needsSave) {
      try {
        await Storage.saveCategories(categories);
      } catch (err) {
        console.warn('保存分类数据失败:', err);
      }
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const profilePath = tab?.url ? parseProfilePath(tab.url) : null;

    if (profilePath) {
      let profileName = profilePath;
      try {
        const info = await chrome.tabs.sendMessage(tab.id, { type: 'getPageProfileInfo' });
        if (info?.name) profileName = info.name;
      } catch {}
      detectedProfile = { name: profileName, profilePath };
      renderQuickAdd();
    } else {
      renderCategoryList();
    }

    // 监听 storage 变化，实时同步数据（解决与 Content Script 不同步问题）
    chrome.storage.onChanged.addListener(async (changes) => {
      if (changes.categories) {
        categories = await Storage.getCategories();
        refreshCurrentView();
      }
    });
  }

  // 根据当前视图刷新 UI（storage 变化时调用）
  function refreshCurrentView() {
    switch (currentView) {
      case 'categories':
        renderCategoryList();
        break;
      case 'categoryDetail':
        const cat = categories.find(c => c.id === editingCategoryId);
        if (cat) renderMemberList(cat);
        break;
      case 'quickAdd':
        renderQuickAdd();
        break;
      // editCategory, aiReview 等编辑视图不刷新，避免打断用户操作
    }
  }

  function showView(name) {
    Object.values(views).forEach(v => v.classList.add('hidden'));
    views[name].classList.remove('hidden');
    currentView = name;
  }

  function bindEvents() {
    document.getElementById('btn-add-category').addEventListener('click', () => {
      editingCategoryId = null;
      document.getElementById('edit-category-title').textContent = '新建分类';
      document.getElementById('input-category-name').value = '';
      document.getElementById('btn-delete-category').classList.add('hidden');
      renderColorPicker();
      showView('editCategory');
    });

    document.getElementById('btn-save-category').addEventListener('click', saveCategory);
    document.getElementById('btn-delete-category').addEventListener('click', deleteCategory);
    document.getElementById('btn-ai-suggest').addEventListener('click', startAISuggestion);
    document.getElementById('btn-confirm-ai').addEventListener('click', confirmAISuggestions);

    document.getElementById('btn-edit-from-detail').addEventListener('click', () => {
      openEditCategory(editingCategoryId);
    });

    document.querySelectorAll('.btn-back').forEach(btn => {
      btn.addEventListener('click', () => {
        if (detectedProfile && (currentView === 'editCategory' || currentView === 'categoryDetail')) {
          renderQuickAdd();
        } else if (currentView === 'categoryDetail') {
          showView('categories');
          renderCategoryList();
        } else {
          showView('categories');
        }
      });
    });
  }

  // --- Category List ---
  function renderCategoryList() {
    const list = document.getElementById('category-list');
    list.innerHTML = '';

    if (categories.length === 0) {
      list.innerHTML = '<p class="empty-hint">还没有分类，点击"+ 新建"创建第一个分类</p>';
      return;
    }

    categories.sort((a, b) => a.order - b.order).forEach(cat => {
      const item = document.createElement('div');
      item.className = 'category-item';

      // 统计个人和公司数量
      const personCount = cat.members.filter(m => m.profilePath?.startsWith('/in/')).length;
      const orgCount = cat.members.filter(m =>
        m.profilePath?.startsWith('/company/') || m.profilePath?.startsWith('/school/')
      ).length;

      let countText = '';
      if (orgCount === 0) {
        countText = `${personCount} 人`;
      } else if (personCount === 0) {
        countText = `${orgCount} 公司`;
      } else {
        countText = `${orgCount} 公司 · ${personCount} 人`;
      }

      const icon = cat.icon || DEFAULT_ICONS[categories.indexOf(cat) % DEFAULT_ICONS.length];
      const totalCount = cat.members.length;

      item.innerHTML = `
        <div class="category-icon" style="background: linear-gradient(135deg, ${cat.color}20, ${cat.color}10)">${icon}</div>
        <div class="category-info">
          <span class="category-name">${cat.name}</span>
          <span class="member-count">${countText}</span>
        </div>
        <span class="category-badge">${totalCount}</span>
      `;
      item.addEventListener('click', () => openCategoryDetail(cat.id));
      list.appendChild(item);
    });
  }

  // --- Edit Category ---
  function openEditCategory(catId) {
    const cat = categories.find(c => c.id === catId);
    editingCategoryId = catId;
    document.getElementById('edit-category-title').textContent = cat ? '编辑分类' : '新建分类';
    document.getElementById('input-category-name').value = cat ? cat.name : '';
    document.getElementById('input-category-icon').value = cat ? (cat.icon || '') : '';
    document.getElementById('btn-delete-category').classList.toggle('hidden', !cat);
    renderColorPicker(cat ? cat.color : null);
    showView('editCategory');
  }

  function renderColorPicker(selectedColor) {
    const picker = document.getElementById('color-picker');
    picker.innerHTML = '';
    COLORS.forEach(color => {
      const swatch = document.createElement('div');
      swatch.className = 'color-swatch' + (color === selectedColor ? ' selected' : '');
      swatch.style.background = color;
      swatch.dataset.color = color;
      swatch.addEventListener('click', () => {
        picker.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
        swatch.classList.add('selected');
      });
      picker.appendChild(swatch);
    });
    if (!selectedColor) {
      picker.querySelector('.color-swatch').classList.add('selected');
    }
  }

  async function saveCategory() {
    const name = document.getElementById('input-category-name').value.trim();
    const icon = document.getElementById('input-category-icon').value.trim() || DEFAULT_ICONS[categories.length % DEFAULT_ICONS.length];
    if (!name) return;

    const selectedColor = document.querySelector('#color-picker .color-swatch.selected');
    const color = selectedColor ? selectedColor.dataset.color : COLORS[0];

    if (editingCategoryId) {
      const cat = categories.find(c => c.id === editingCategoryId);
      if (cat) {
        cat.name = name;
        cat.color = color;
        cat.icon = icon;
      }
    } else {
      categories.push({
        id: Storage.generateId(),
        name,
        color,
        icon,
        order: categories.length,
        members: []
      });
    }

    await Storage.saveCategories(categories);

    if (detectedProfile && !editingCategoryId) {
      const newCat = categories[categories.length - 1];
      newCat.members.push({ name: detectedProfile.name, profilePath: detectedProfile.profilePath, title: '' });
      await Storage.saveCategories(categories);
      renderQuickAdd();
    } else {
      showView('categories');
      renderCategoryList();
    }
  }

  async function deleteCategory() {
    if (!editingCategoryId) return;
    categories = categories.filter(c => c.id !== editingCategoryId);
    await Storage.saveCategories(categories);
    editingCategoryId = null;
    showView('categories');
    renderCategoryList();
  }

  // --- Category Detail / Members ---
  function openCategoryDetail(catId) {
    const cat = categories.find(c => c.id === catId);
    if (!cat) return;
    editingCategoryId = catId;
    document.getElementById('detail-category-name').textContent = cat.name;
    renderMemberList(cat);
    showView('categoryDetail');
  }

  function renderMemberList(cat) {
    const list = document.getElementById('member-list');
    list.innerHTML = '';

    if (cat.members.length === 0) {
      list.innerHTML = '<p class="empty-hint">暂无成员</p>';
      return;
    }

    cat.members.forEach((member, idx) => {
      const isOrg = member.profilePath?.startsWith('/company/') || member.profilePath?.startsWith('/school/');
      const displayName = (
          member.name === member.profilePath ||
          member.name?.startsWith('/in/') ||
          member.name?.startsWith('/company/') ||
          member.name?.startsWith('ACo') ||
          (member.name?.length > 30 && !member.name?.includes(' '))
        )
        ? cleanMemberName(member.name || member.profilePath)
        : member.name;

      const initial = (displayName || '?').charAt(0).toUpperCase();
      const avatarColor = isOrg ? '#34C759' : '#007AFF';
      const profileUrl = `https://www.linkedin.com${member.profilePath}`;
      // 提取链接缩写（只显示最后一段）
      const shortLink = member.profilePath ? member.profilePath.split('/').pop() : '';

      const item = document.createElement('div');
      item.className = 'member-item';

      // 头像渲染：优先使用存储的真实头像，兜底为首字母
      const avatarHtml = member.avatar
        ? `<img class="member-avatar-img" src="${member.avatar}" alt="${displayName}" />`
        : `<div class="member-avatar" style="background: ${avatarColor}">${initial}</div>`;

      item.innerHTML = `
        ${avatarHtml}
        <div class="member-info">
          <span class="member-name">${displayName}</span>
          <a class="member-profile-link" href="${profileUrl}" target="_blank" rel="noopener">${shortLink}</a>
        </div>
        <button class="btn btn-text btn-remove" data-idx="${idx}">移除</button>
      `;
      item.querySelector('.btn-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        removeMember(cat.id, idx);
      });
      item.querySelector('.member-profile-link').addEventListener('click', (e) => {
        e.stopPropagation();
      });
      list.appendChild(item);
    });
  }

  async function addMember() {
    const name = document.getElementById('input-member-name').value.trim();
    const rawPath = document.getElementById('input-member-path').value.trim();
    if (!name || !rawPath) return;

    const path = parseProfilePath(rawPath);
    if (!path) {
      document.getElementById('input-member-path').style.borderColor = '#cc1016';
      setTimeout(() => { document.getElementById('input-member-path').style.borderColor = ''; }, 1500);
      return;
    }

    const cat = categories.find(c => c.id === editingCategoryId);
    if (!cat) return;

    // 使用统一匹配函数检测重复（用户手动输入时没有 linkedinId，只匹配 profilePath）
    if (cat.members.some(m => memberMatches(m, path, null))) return;

    cat.members.push({ name, profilePath: path, title: '' });
    await Storage.saveCategories(categories);

    document.getElementById('input-member-name').value = '';
    document.getElementById('input-member-path').value = '';
    renderMemberList(cat);
  }

  async function removeMember(catId, idx) {
    const cat = categories.find(c => c.id === catId);
    if (!cat) return;
    cat.members.splice(idx, 1);
    await Storage.saveCategories(categories);
    renderMemberList(cat);
  }

  // --- AI Suggestion ---
  async function startAISuggestion() {
    showView('aiReview');
    const statusEl = document.getElementById('ai-status');
    const statusText = document.getElementById('ai-status-text');
    const suggestionsEl = document.getElementById('ai-suggestions');
    const confirmBtn = document.getElementById('btn-confirm-ai');

    statusEl.classList.remove('hidden');
    suggestionsEl.innerHTML = '';
    confirmBtn.classList.add('hidden');
    statusText.textContent = '正在提取关注列表...';

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await chrome.tabs.sendMessage(tab.id, { type: 'extractFollowing' });

      if (!result || !result.length) {
        statusText.textContent = '未能提取关注列表。请在 LinkedIn 页面上使用。';
        return;
      }

      statusText.textContent = `已提取 ${result.length} 人，正在 AI 分析...`;

      const response = await chrome.runtime.sendMessage({
        type: 'callClaudeAPI',
        data: result
      });

      if (!response || response.error) {
        statusText.textContent = '分析失败：' + (response?.error || '未知错误');
        return;
      }

      statusEl.classList.add('hidden');
      aiSuggestions = response.suggestions;
      renderAISuggestions(aiSuggestions);
      confirmBtn.classList.remove('hidden');
    } catch (err) {
      statusText.textContent = '发生错误：' + err.message;
    }
  }

  function renderAISuggestions(suggestions) {
    const container = document.getElementById('ai-suggestions');
    container.innerHTML = '';

    suggestions.forEach((group, gi) => {
      const section = document.createElement('div');
      section.className = 'ai-group';
      section.innerHTML = `
        <div class="ai-group-header">
          <input type="text" class="ai-group-name" value="${group.name}" data-gi="${gi}" />
          <span class="ai-group-count">${group.members.length} 人</span>
        </div>
      `;

      group.members.forEach((member, mi) => {
        const row = document.createElement('div');
        row.className = 'ai-member-row';
        row.innerHTML = `
          <label>
            <input type="checkbox" checked data-gi="${gi}" data-mi="${mi}" />
            <span>${member.name}</span>
            <span class="member-title">${member.title || ''}</span>
          </label>
        `;
        section.appendChild(row);
      });

      container.appendChild(section);
    });
  }

  async function confirmAISuggestions() {
    if (!aiSuggestions) return;

    const container = document.getElementById('ai-suggestions');

    aiSuggestions.forEach((group, gi) => {
      const nameInput = container.querySelector(`.ai-group-name[data-gi="${gi}"]`);
      const catName = nameInput ? nameInput.value.trim() : group.name;

      const members = [];
      group.members.forEach((member, mi) => {
        const checkbox = container.querySelector(`input[data-gi="${gi}"][data-mi="${mi}"]`);
        if (checkbox && checkbox.checked) {
          members.push(member);
        }
      });

      if (members.length > 0) {
        const existing = categories.find(c => c.name === catName);
        if (existing) {
          members.forEach(m => {
            // 使用统一匹配函数检测重复（支持 linkedinId 和 profilePath 两种匹配）
            if (!existing.members.some(em => memberMatches(em, m.profilePath, m.linkedinId))) {
              existing.members.push(m);
            }
          });
        } else {
          categories.push({
            id: Storage.generateId(),
            name: catName,
            color: COLORS[categories.length % COLORS.length],
            order: categories.length,
            members
          });
        }
      }
    });

    await Storage.saveCategories(categories);
    aiSuggestions = null;
    showView('categories');
    renderCategoryList();
  }

  // --- Quick Add from Profile Page ---
  function renderQuickAdd() {
    if (!detectedProfile) return;
    showView('quickAdd');

    document.getElementById('qa-profile-name').textContent = detectedProfile.name;
    document.getElementById('qa-profile-path').textContent = detectedProfile.profilePath;

    const belongsTo = categories.filter(c => c.members.some(m => m.profilePath === detectedProfile.profilePath));
    const belongsEl = document.getElementById('qa-belongs');
    if (belongsTo.length > 0) {
      belongsEl.classList.remove('hidden');
      belongsEl.querySelector('span').textContent = belongsTo.map(c => c.name).join('、');
    } else {
      belongsEl.classList.add('hidden');
    }

    const list = document.getElementById('qa-category-list');
    list.innerHTML = '';

    categories.sort((a, b) => a.order - b.order).forEach(cat => {
      const isMember = cat.members.some(m => m.profilePath === detectedProfile.profilePath);
      const item = document.createElement('div');
      item.className = 'category-item' + (isMember ? ' qa-added' : '');
      const icon = cat.icon || DEFAULT_ICONS[categories.indexOf(cat) % DEFAULT_ICONS.length];
      item.innerHTML = `
        <div class="category-icon" style="background: linear-gradient(135deg, ${cat.color}20, ${cat.color}10)">${icon}</div>
        <span class="category-name">${cat.name}</span>
        <span class="qa-status">${isMember ? '✓ 已添加' : '+ 添加'}</span>
      `;
      if (!isMember) {
        item.addEventListener('click', async () => {
          // 保存时自动获取ID
          let linkedinId = null;
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const info = await chrome.tabs.sendMessage(tab.id, { type: 'getPageProfileInfo' });
            linkedinId = info?.linkedinId || null;
          } catch {}

          cat.members.push({ name: detectedProfile.name, profilePath: detectedProfile.profilePath, title: '', linkedinId });
          await Storage.saveCategories(categories);
          renderQuickAdd();
        });
      }
      list.appendChild(item);
    });

    const newBtn = document.createElement('div');
    newBtn.className = 'category-item qa-new';
    newBtn.innerHTML = '<span class="category-name">+ 新建分类并添加</span>';
    newBtn.addEventListener('click', () => {
      editingCategoryId = null;
      document.getElementById('edit-category-title').textContent = '新建分类';
      document.getElementById('input-category-name').value = '';
      document.getElementById('btn-delete-category').classList.add('hidden');
      renderColorPicker();
      showView('editCategory');
    });
    list.appendChild(newBtn);
  }

  document.getElementById('qa-skip').addEventListener('click', () => {
    detectedProfile = null;
    showView('categories');
    renderCategoryList();
  });

  init();
})();
