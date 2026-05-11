(async function() {
  'use strict';

  const LOG = (...args) => console.log('[LFC]', ...args);
  const DEFAULT_ICONS = ['🤖', '🚀', '💰', '🎨', '📚', '💡', '🎯', '🌟'];

  let categories = [];
  let settings = {};
  let activeCategory = null;
  let filterBar = null;
  let feedContainer = null;
  let feedObserver = null;
  let profileBar = null;

  function isFeedPage() {
    return /^https:\/\/www\.linkedin\.com\/feed\/?(\?.*)?$/.test(location.href);
  }

  function isProfilePage() {
    return /^https:\/\/www\.linkedin\.com\/(in|company|school|showcase)\/[^/?#]+/.test(location.href);
  }

  function getProfilePathFromUrl() {
    const match = location.href.match(/\/(in|company|school|showcase)\/([^/?#]+)/);
    return match ? `/${match[1]}/${match[2]}` : null;
  }

  // 统一成员匹配函数：以 LinkedIn URN 为唯一稳定标识
  // 匹配优先级（从最可靠到兜底）：
  // 1. linkedinId 精确匹配（最可靠）
  // 2. profilePath 精确匹配
  // 3. 从 profilePath 提取 URN 进行匹配（解决两种 URL 格式兼容问题）
  function memberMatches(member, profilePath, linkedinId) {
    // 1. 最高优先级：linkedinId 精确匹配（URN 永远不变）
    if (linkedinId && member.linkedinId === linkedinId) {
      return true;
    }
    // 2. 次高优先级：profilePath 精确匹配
    if (member.profilePath === profilePath) {
      return true;
    }
    // 🔑 3. 兜底：从两种 profilePath 中提取 URN 进行比较
    //    解决 LinkedIn 两种 URL 格式不兼容问题
    if (linkedinId && member.profilePath) {
      // 从成员 profilePath 中提取 URN（最后一段）
      const memberUrn = member.profilePath.split('/').pop();
      // 当前页面的 linkedinId 与成员 URN 相同或互相包含？
      if (memberUrn && (memberUrn === linkedinId || linkedinId.includes(memberUrn))) {
        return true;
      }
    }
    return false;
  }

  // 检查成员是否需要访问 profile 页面（提取 ID 或真实姓名）
  function needsProfileVisit(m) {
    if (m.extracted) return false;
    if (!m.linkedinId) return true;
    if (m.name === m.profilePath ||
        m.name?.startsWith('/in/') ||
        m.name?.startsWith('/company/') ||
        m.name?.startsWith('/school/') ||
        m.name?.startsWith('/showcase/') ||
        m.name?.startsWith('ACo') ||
        (m.name?.length > 30 && !m.name?.includes(' '))) {
      return true;
    }
    return false;
  }

  function findFeedColumn() {
    const main = document.querySelector('main');
    if (!main) return null;

    // 策略1: 旧版 LinkedIn（data-urn）
    const postByUrn = document.querySelector('[data-urn*="activity"], [data-urn*="ugcPost"]');
    if (postByUrn) { debugShow('[find] 策略1命中: data-urn'); return postByUrn.parentElement; }

    // 策略2: 旧版 LinkedIn（feed-shared-update-v2）
    const postByClass = document.querySelector('.feed-shared-update-v2');
    if (postByClass) {
      debugShow('[find] 策略2命中: .feed-shared-update-v2');
      return postByClass.closest('.scaffold-finite-scroll__content') || postByClass.parentElement;
    }

    // 策略3: 新版 LinkedIn — 用 "Sort by" 文本定位（任意标签）
    const allEls = main.querySelectorAll('*');
    let sortEl = null;
    for (const el of allEls) {
      if (el.children.length === 0 && /sort\s*by/i.test(el.textContent)) {
        sortEl = el;
        break;
      }
    }
    if (!sortEl) {
      // 尝试找叶子节点包含 "Sort by" 的
      sortEl = Array.from(main.querySelectorAll('div, span, button')).find(
        el => /^sort\s*by/i.test(el.textContent.trim()) && el.textContent.length < 30
      );
    }

    if (sortEl) {
      // 从 "Sort by" 元素往上找，找到帖子列表的父容器
      // Feed 帖子在 "Sort by" 的后面/下面，在同一个或相邻的容器中
      let container = sortEl;
      while (container && container !== main) {
        const parent = container.parentElement;
        if (!parent) break;

        // 策略3.1: 找到 "Sort by" 所在元素的后续兄弟，看看哪个包含 /in/ 链接（即帖子）
        const nextSibling = container.nextElementSibling;
        if (nextSibling && nextSibling.querySelector('a[href*="/in/"], a[href*="/company/"], a[href*="/school/"]')) {
          debugShow(`[find] 策略3.1命中: sort后的兄弟元素 tag=${nextSibling.tagName} ch=${nextSibling.children.length}`);
          return nextSibling;
        }

        // 策略3.2: 检查 parent 下是否有实际包含多个帖子的子容器
        // 帖子容器通常有很多直接子元素，每个子元素是一个帖子
        for (const child of parent.children) {
          if (child !== container && child.children.length >= 2) {
            // 检查这个子元素下是否有至少 2 个包含作者链接的元素
            const postChildren = Array.from(child.children).filter(
              c => c.querySelector('a[href*="/in/"], a[href*="/company/"], a[href*="/school/"]')
            );
            if (postChildren.length >= 2) {
              debugShow(`[find] 策略3.2命中: sort后的帖子容器 tag=${child.tagName} posts=${postChildren.length}`);
              return child;
            }
          }
        }

        // 策略3.3: 回退到原来的父容器检查
        if (parent.children.length >= 2 && parent.querySelector('a[href*="/in/"], a[href*="/school/"]')) {
          const postChildren = Array.from(parent.children).filter(
            ch => ch !== container && ch.querySelector('a[href*="/in/"], a[href*="/company/"], a[href*="/school/"]')
          );
          if (postChildren.length >= 2) {
            debugShow(`[find] 策略3.3命中: sort的父容器 tag=${parent.tagName} ch=${parent.children.length} posts=${postChildren.length}`);
            return parent;
          }
        }
        container = parent;
      }
      debugShow('[find] 策略3: 找到sort但未定位到feed容器');
    }

    debugShow('[find] 全部未命中');
    return null;
  }

  // === 临时调试面板（暂时隐藏，需要时取消注释恢复） ===
  let debugEl = null;
  function debugShow(msg) {
    // if (!debugEl) {
    //   debugEl = document.createElement('div');
    //   debugEl.id = 'lfc-debug';
    //   debugEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:#222;color:#0f0;font:11px monospace;padding:3px 8px;white-space:pre;max-height:48px;overflow:hidden;opacity:0.9;pointer-events:none;';
    //   document.body.prepend(debugEl);
    // }
    // // 只保留最后3行
    // const lines = debugEl.textContent.split('\n').filter(l => l.trim());
    // lines.push(msg);
    // if (lines.length > 3) lines.splice(0, lines.length - 3);
    // debugEl.textContent = lines.join('\n') + '\n';
    LOG(msg);
  }

  // 从 Profile 页面提取 memberId（支持个人/公司/学校）
  function extractMemberIdFromProfilePage() {
    // 个人页面 ID 提取
    if (location.pathname.startsWith('/in/')) {
      // 方式1: 从 componentkey 提取（最可靠）
      const profileSection = document.querySelector('[componentkey*="ref"][componentkey*="Topcard"]');
      if (profileSection) {
        const match = profileSection.getAttribute('componentkey').match(/\.ref([A-Za-z0-9_-]+)Topcard/);
        if (match) return match[1];
      }

      // 方式2: 从 mutual connections 链接中提取
      const connLink = document.querySelector('[href*="connectionOf="]');
      if (connLink) {
        const match = connLink.getAttribute('href').match(/connectionOf=%5B%22([A-Za-z0-9_-]+)%22%5D/);
        if (match) return match[1];
      }

      // 方式3: 从消息链接提取
      const msgLink = document.querySelector('[href*="profileUrn="]');
      if (msgLink) {
        const match = msgLink.getAttribute('href').match(/profileUrn=urn%3Ali%3Afsd_profile%3A([A-Za-z0-9_-]+)/);
        if (match) return match[1];
      }
    }

    // 公司/学校/Showcase 页面 ID 提取
    if (location.pathname.startsWith('/company/') || location.pathname.startsWith('/school/') || location.pathname.startsWith('/showcase/')) {
      // 方式1: 从 componentkey 提取公司URN
      const orgSection = document.querySelector('[componentkey*="company"]');
      if (orgSection) {
        const match = orgSection.getAttribute('componentkey').match(/urn:li:fsd_company:(\d+)/);
        if (match) return match[1];
      }

      // 方式2: 从任意元素的 componentkey 属性中查找
      const allWithComponentkey = document.querySelectorAll('[componentkey]');
      for (const el of allWithComponentkey) {
        const key = el.getAttribute('componentkey');
        const match = key.match(/urn:li:fsd_company:(\d+)/);
        if (match) return match[1];
      }

      // 方式3: 从页面内嵌 code/script 标签中提取
      const allScripts = document.querySelectorAll('code, script[type="application/json"]');
      for (const el of allScripts) {
        const content = el.textContent || el.innerText;
        if (!content) continue;
        const match = content.match(/urn:li:fsd_company:(\d+)/);
        if (match) return match[1];
      }
    }

    return null;
  }

  // Profile 页面初始化：自动提取并存储 memberId，支持批量提取
  async function initProfilePageIdExtraction() {
    if (!isProfilePage()) return;

    setTimeout(async () => {
      const memberId = extractMemberIdFromProfilePage();
      const profilePath = getProfilePathFromUrl();
      if (!profilePath) return;

      // 提取头像 URL + 姓名：使用 aria-label 精确定位，100% 不会匹配到其他头像
      let avatarUrl = null;
      let extractedName = null;
      try {
        // 策略1：个人 profile 头像（最精确，LinkedIn 官方无障碍属性）
        const profilePhotoContainer = document.querySelector('[aria-label="Profile photo"]');
        if (profilePhotoContainer) {
          const img = profilePhotoContainer.querySelector('img');
          if (img) avatarUrl = img.src;

          // 找头像附近的标题（姓名总在头像旁边）
          let container = profilePhotoContainer.parentElement;
          for (let i = 0; i < 5 && container && !extractedName; i++) {
            const headings = container.querySelectorAll('h1, h2');
            for (const h of headings) {
              const text = h.textContent.trim();
              if (text.length > 2 && text.length < 100) {
                extractedName = text;
                break;
              }
            }
            container = container.parentElement;
          }
        }

        // 策略2：公司 logo 兜底
        if (!avatarUrl) {
          const companyLogo = document.querySelector('[aria-label*="logo"], .org-top-card-primary-content__logo');
          if (companyLogo) {
            const img = companyLogo.tagName === 'IMG' ? companyLogo : companyLogo.querySelector('img');
            if (img) avatarUrl = img.src;
          }
        }

        // 策略3：标题兜底
        if (!extractedName) {
          const h1 = document.querySelector('h1');
          const h2 = document.querySelector('h2');
          const heading = h1 || h2;
          if (heading) extractedName = heading.textContent.trim();
        }

        // 策略4：URL 模式兜底（兼容旧页面）
        if (!avatarUrl) {
          const fallback = document.querySelector('img[src*="profile-displayphoto-shrink"], img[src*="company-logo_"]');
          if (fallback) avatarUrl = fallback.src;
        }
      } catch {}

      // 尽力提取 ID 和名称（遍历所有分类中所有匹配的成员，含重复条目）
      let updated = false;
      const nameEl = extractedName ? { textContent: extractedName } : null;
      categories.forEach(cat => {
        cat.members.forEach(member => {
          // 使用统一匹配函数：支持 linkedinId 或 profilePath 匹配
          if (!memberMatches(member, profilePath, memberId)) return;
          // 匹配成功后，统一更新 profilePath 为当前页面格式（确保一致性）
          member.profilePath = profilePath;
          updated = true;
          if (memberId && !member.linkedinId) {
            member.linkedinId = memberId;
            updated = true;
          }
          if (nameEl && (member.name === member.profilePath ||
              member.name?.startsWith('/in/') ||
              member.name?.startsWith('/company/') ||
              member.name?.startsWith('/school/') ||
              member.name?.startsWith('/showcase/') ||
              member.name?.startsWith('ACo') ||
              (member.name?.length > 30 && !member.name?.includes(' ')))) {
            member.name = nameEl.textContent.trim();
            updated = true;
          }
          // 提取/更新头像 URL（有新头像就更新，覆盖错误的旧头像）
          if (avatarUrl) {
            member.avatar = avatarUrl;
            updated = true;
          }
          if (!member.extracted) {
            member.extracted = true;
            updated = true;
          }
        });
      });

      if (updated) {
        try {
          // 批量提取时使用防抖保存，减少频繁写入
          await Storage.saveCategoriesDebounced(categories, 500);
          debugShow(`[ID提取] 已处理 ${profilePath}${memberId ? ' id=' + memberId : ' (无ID)'}`);
        } catch {
          debugShow('[ID提取] 保存失败，停止批量提取');
          return;
        }
      }

      // 检查是否有待处理的批量提取任务
      if (settings.pendingCategoryId) {
        const elapsed = Date.now() - (settings.pendingStartTime || 0);
        if (elapsed > 5 * 60 * 1000) {
          debugShow('[信息补全] pending 任务超时，自动清除');
          Storage.saveSettings({ ...settings, pendingCategoryId: null, pendingStartTime: null }).catch(() => {});
          return;
        }

        const cat = categories.find(c => String(c.id) === String(settings.pendingCategoryId));
        if (cat) {
          const membersWithoutId = cat.members.filter(m => needsProfileVisit(m));

          if (membersWithoutId.length > 0) {
            debugShow(`[信息补全] 剩余 ${membersWithoutId.length} 个成员待处理`);
            const nextMember = membersWithoutId[0];
            setTimeout(() => {
              window.location.href = `https://www.linkedin.com${nextMember.profilePath}`;
            }, 1500);
          } else {
            debugShow(`[信息补全] 全部完成，跳转到搜索页`);
            const urls = buildCategorySearchUrls(cat);
            await Storage.saveSettings({ ...settings, pendingCategoryId: null, pendingStartTime: null, pendingExtractIndex: null });
            if (urls.length > 0) {
              setTimeout(() => {
                window.location.href = urls[0];
                if (urls.length > 1) {
                  window.open(urls[1], '_blank');
                }
              }, 500);
            }
          }
        }
      }
    }, 3000);
  }

  async function init() {
    try {
      categories = await Storage.getCategories();
      settings = await Storage.getSettings();
    } catch (err) {
      // 扩展上下文失效（如重新加载扩展），静默退出
      console.warn('[init] Extension context invalidated, exiting');
      return;
    }
    // 确保 activeCategory 是有效的（字符串或 null）
    activeCategory = (typeof settings.activeCategory === 'string' || settings.activeCategory === null)
      ? settings.activeCategory
      : null;
    debugShow(`[init] cats=${categories.length} active=${activeCategory} isFeed=${isFeedPage()} isProfile=${isProfilePage()} url=${location.href}`);

    // 超时自动清除 pending 状态（防止无限循环）
    if (settings.pendingCategoryId) {
      const elapsed = Date.now() - (settings.pendingStartTime || 0);
      if (elapsed > 5 * 60 * 1000) {
        debugShow('[init] pending 任务超时(>5min)，自动清除');
        settings.pendingCategoryId = null;
        settings.pendingStartTime = null;
        Storage.saveSettings(settings).catch(() => {});
      }
    }

    // Profile 页面自动提取 memberId
    initProfilePageIdExtraction();

    // 检查并处理：从 feed 页面新建分类后跳转到 profile 的添加任务
    if (isProfilePage() && settings.pendingAddToCategory) {
      const elapsed = Date.now() - (settings.pendingAddStartTime || 0);
      if (elapsed < 60000) { // 1分钟内有效
        const currentProfilePath = getProfilePathFromUrl();
        if (currentProfilePath === settings.pendingAddProfilePath) {
          debugShow(`[新建分类] 检测到待添加任务，处理中...`);
          // 等待页面加载后处理（确保能提取到完整信息）
          setTimeout(async () => {
            const memberId = extractMemberIdFromProfilePage();
            let avatarUrl = null;
            let fullName = null;

            // 提取头像
            const profilePhotoContainer = document.querySelector('[aria-label="Profile photo"]');
            if (profilePhotoContainer) {
              const img = profilePhotoContainer.querySelector('img');
              if (img) avatarUrl = img.src;

              // 提取姓名
              let container = profilePhotoContainer.parentElement;
              for (let i = 0; i < 5 && container && !fullName; i++) {
                const headings = container.querySelectorAll('h1, h2');
                for (const h of headings) {
                  const text = h.textContent.trim();
                  if (text.length > 2 && text.length < 100) {
                    fullName = text;
                    break;
                  }
                }
                container = container.parentElement;
              }
            }

            // 兜底姓名提取
            if (!fullName) {
              const h1 = document.querySelector('h1') || document.querySelector('h2');
              if (h1) fullName = h1.textContent.trim();
            }

            // 添加到分类
            const cat = categories.find(c => String(c.id) === String(settings.pendingAddToCategory));
            if (cat) {
              if (!Array.isArray(cat.members)) cat.members = [];
              const newMember = {
                name: fullName || currentProfilePath,
                profilePath: currentProfilePath,
                title: '',
                addedAt: Date.now()
              };
              if (memberId) newMember.linkedinId = memberId;
              if (avatarUrl) newMember.avatar = avatarUrl;

              cat.members.push(newMember);
              await Storage.saveCategories(categories);
              debugShow(`[新建分类] 已添加 ${newMember.name} 到 ${cat.name}`);
            }

            // 清除任务状态
            const newSettings = { ...settings };
            delete newSettings.pendingAddToCategory;
            delete newSettings.pendingAddProfilePath;
            delete newSettings.pendingAddStartTime;
            await Storage.saveSettings(newSettings);

            // 提示成功，用户可关闭此标签页继续阅读原 Feed
            alert(`✅ 已成功加入「${cat?.name || '新分类'}」！\n\n可以关闭此标签页，回到原 Feed 页面继续浏览。`);
          }, 2000);
        }
      } else {
        // 超时清除
        const newSettings = { ...settings };
        delete newSettings.pendingAddToCategory;
        delete newSettings.pendingAddProfilePath;
        delete newSettings.pendingAddStartTime;
        Storage.saveSettings(newSettings).catch(() => {});
      }
    }

    if (isFeedPage()) {
      startFeedMode();
      // 如果有待处理的批量任务，跳转到第一个成员的 profile 页面
      if (settings.pendingCategoryId) {
        const cat = categories.find(c => String(c.id) === String(settings.pendingCategoryId));
        if (cat) {
          const nextMember = cat.members.find(m => needsProfileVisit(m));
          if (nextMember) {
            debugShow(`[信息补全] 检测到待处理任务，跳转到: ${nextMember.profilePath}`);
            setTimeout(() => {
              window.location.href = `https://www.linkedin.com${nextMember.profilePath}`;
            }, 1000);
          }
        }
      }
    } else if (isProfilePage()) {
      startProfileMode();
    }

    setupUrlWatcher();
    setupStorageListener();

    // 定期检测扩展上下文是否失效（扩展重新加载后会失效）
    setInterval(async () => {
      try {
        // 测试扩展上下文是否仍然有效
        await chrome.runtime.sendMessage({ type: 'ping' });
      } catch {
        // 上下文失效，提示用户刷新页面
        showContextInvalidatedBanner();
      }
    }, 10000);  // 每 10 秒检测一次
  }

  // 显示扩展上下文失效提示横幅
  function showContextInvalidatedBanner() {
    if (document.getElementById('lfc-context-error')) return;

    const banner = document.createElement('div');
    banner.id = 'lfc-context-error';
    banner.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 999999;
      background: linear-gradient(135deg, #ff6b6b, #ee5a5a);
      color: white;
      padding: 10px 16px;
      text-align: center;
      font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 2px 12px rgba(0,0,0,0.15);
    `;
    banner.innerHTML = `
      <strong>LinkedIn Feed Categorizer</strong>: 扩展已更新，请
      <a href="#" onclick="location.reload(); return false;" style="color:white;text-decoration:underline;margin:0 6px;font-weight:600;">刷新页面</a>
      恢复功能
    `;
    document.body.prepend(banner);
  }

  function setupStorageListener() {
    try {
      chrome.storage.onChanged.addListener(async (changes) => {
      if (changes.categories) {
        categories = await Storage.getCategories();
        if (filterBar) {
          renderTabs();
          applyFilter();
        }
        // 同时更新 profileBar
        if (profileBar && updateProfileBar) {
          updateProfileBar();
        }
      }
      if (changes.settings) {
        settings = await Storage.getSettings();
        // 同步更新 activeCategory
        if (typeof settings.activeCategory === 'string' || settings.activeCategory === null) {
          activeCategory = settings.activeCategory;
        } else {
          activeCategory = null;
        }
        if (filterBar) {
          renderTabs();
          applyFilter();
        }
      }
    });
    } catch (err) {
      console.warn('[Storage] Cannot attach listener:', err.message);
      showContextInvalidatedBanner();
    }
  }

  function setupUrlWatcher() {
    let lastUrl = location.href;
    const check = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        const nowFeed = isFeedPage();
        const nowProfile = isProfilePage();
        LOG('URL changed', { nowFeed, nowProfile, url: location.href });

        stopFeedMode();
        stopProfileMode();

        if (nowFeed) {
          startFeedMode();
        } else if (nowProfile) {
          startProfileMode();
        }
      }
    };
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
  }

  function startFeedMode() {
    LOG('startFeedMode');
    // 先尝试快速找到 sortBy 并插入过滤栏，不等待 feedContainer
    let injected = false;
    const tryQuickInject = (attempt) => {
      if (injected || attempt > 10) return;
      const main = document.querySelector('main');
      if (!main) { setTimeout(() => tryQuickInject(attempt + 1), 500); return; }

      // 找 "Sort by" 元素
      const allEls = main.querySelectorAll('*');
      let sortEl = null;
      for (const el of allEls) {
        if (el.children.length === 0 && /sort\s*by/i.test(el.textContent)) {
          sortEl = el; break;
        }
      }
      if (!sortEl) {
        sortEl = Array.from(main.querySelectorAll('div, span, button')).find(
          el => /^sort\s*by/i.test(el.textContent.trim()) && el.textContent.length < 30
        );
      }

      if (sortEl) {
        debugShow('[inject] 找到Sort by! 直接插入过滤栏...');
        // 在 sortEl 的祖先元素中找合适位置插入
        let injectTarget = sortEl;
        for (let d = 0; d < 8 && injectTarget; d++) {
          // 找有明显兄弟元素的容器插入
          if (injectTarget.previousElementSibling || injectTarget.parentElement?.children?.length >= 2) {
            // 在这个元素前面插入过滤栏
            if (injectTarget.parentElement) {
              filterBar = document.createElement('div');
              filterBar.id = 'lfc-filter-bar';
              renderTabs();
              injectTarget.parentElement.insertBefore(filterBar, injectTarget);
              debugShow('[inject] 过滤栏已插入!');
              injected = true;
              // 关键修复：快速注入成功后也要调用过滤
              applyFilter();
              observeFeed();
              return;
            }
          }
          injectTarget = injectTarget.parentElement;
        }
      }
      setTimeout(() => tryQuickInject(attempt + 1), 500);
    };
    tryQuickInject(0);

    // 保留原有逻辑兜底
    waitForFeed(() => {
      if (!injected) {
        debugShow('[inject] 使用常规feed容器注入...');
        injectFilterBar();
        applyFilter();
        observeFeed();
      }
    });
  }

  function stopFeedMode() {
    LOG('stopFeedMode');
    if (filterBar) {
      filterBar.remove();
      filterBar = null;
    }
    if (feedObserver) {
      feedObserver.disconnect();
      feedObserver = null;
    }
    feedContainer = null;
  }

  function startProfileMode() {
    LOG('startProfileMode');
    const profilePath = getProfilePathFromUrl();
    if (!profilePath) return;
    waitForProfileHeader(() => renderProfileBar(profilePath));
  }

  function stopProfileMode() {
    if (profileBar) {
      profileBar.remove();
      profileBar = null;
    }
  }

  function waitForProfileHeader(callback) {
    let attempts = 0;
    const check = () => {
      const header = document.querySelector('main section, main .pv-top-card, main .org-top-card');
      if (header) {
        callback();
      } else if (attempts < 20) {
        attempts++;
        setTimeout(check, 500);
      }
    };
    check();
  }

  // 暴露到外部的更新函数
  let updateProfileBar = null;

  function renderProfileBar(profilePath) {
    // 清除旧的 profileBar
    if (profileBar) {
      profileBar.remove();
    }

    // 提取当前页面的 memberId（用于更可靠的匹配）
    const memberId = extractMemberIdFromProfilePage();

    // 策略1：优先找头像容器附近的标题（LinkedIn 结构稳定，姓名总在头像旁边）
    let profileName = profilePath;
    let avatarUrl = null;
    try {
      const profilePhotoContainer = document.querySelector('[aria-label="Profile photo"]');
      if (profilePhotoContainer) {
        // 提取头像
        const img = profilePhotoContainer.querySelector('img');
        if (img) avatarUrl = img.src;

        // 找头像附近的标题（向上遍历几层，然后找 h1/h2）
        let container = profilePhotoContainer.parentElement;
        let foundName = null;
        for (let i = 0; i < 5 && container && !foundName; i++) {
          const headings = container.querySelectorAll('h1, h2');
          for (const h of headings) {
            const text = h.textContent.trim();
            if (text.length > 2 && text.length < 100) {
              foundName = text;
              break;
            }
          }
          container = container.parentElement;
        }
        if (foundName) profileName = foundName;
      }

      // 策略2：公司 logo 兜底
      if (!avatarUrl) {
        const companyLogo = document.querySelector('[aria-label*="logo"], .org-top-card-primary-content__logo');
        if (companyLogo) {
          const img = companyLogo.tagName === 'IMG' ? companyLogo : companyLogo.querySelector('img');
          if (img) avatarUrl = img.src;
        }
      }

      // 策略3：兜底直接找标题
      if (profileName === profilePath) {
        const h1 = document.querySelector('h1');
        const h2 = document.querySelector('h2');
        const heading = h1 || h2;
        if (heading) profileName = heading.textContent.trim();
      }

      // 策略4：URL 模式兜底（兼容旧页面）
      if (!avatarUrl) {
        const fallback = document.querySelector('img[src*="profile-displayphoto-shrink"], img[src*="company-logo_"]');
        if (fallback) avatarUrl = fallback.src;
      }
    } catch {}

    profileBar = document.createElement('div');
    profileBar.id = 'lfc-profile-bar';

    // 保存更新函数引用到外部作用域
    updateProfileBar = () => {
      profileBar.innerHTML = '';

      // 从所有分类中移除此 profile 的辅助函数（使用统一匹配逻辑）
      function removeFromAll() {
        categories.forEach(c => {
          c.members = c.members.filter(m => !memberMatches(m, profilePath, memberId));
        });
      }

      categories.sort((a, b) => a.order - b.order).forEach(cat => {
        const isMember = cat.members.some(m => memberMatches(m, profilePath, memberId));
        const btn = document.createElement('button');
        btn.className = 'lfc-profile-cat' + (isMember ? ' lfc-profile-cat-active' : '');
        btn.textContent = isMember ? '✓ ' + cat.name : cat.name;
        if (cat.color && isMember) {
          btn.style.borderColor = cat.color;
          btn.style.color = cat.color;
        }
        btn.addEventListener('click', async () => {
          if (isMember) {
            // 宁滥勿缺：移除所有匹配的成员变体（彻底清理旧格式数据）
            cat.members = cat.members.filter(m => !memberMatches(m, profilePath, memberId));
          } else {
            removeFromAll();
            // 添加前检查是否已有匹配的成员
            const existingMember = cat.members.find(m => memberMatches(m, profilePath, memberId));
            if (!existingMember) {
              // 新成员：以标准格式添加（包含 linkedinId 和 avatar）
              const newMember = { name: profileName, profilePath, title: '' };
              if (memberId) newMember.linkedinId = memberId;
              if (avatarUrl) newMember.avatar = avatarUrl;
              cat.members.push(newMember);
            } else {
              // 已有成员（兜底匹配到）：强制标准化数据格式
              existingMember.profilePath = profilePath;
              existingMember.name = profileName;
              if (memberId) existingMember.linkedinId = memberId;
              if (avatarUrl) existingMember.avatar = avatarUrl;
            }
          }
          await Storage.saveCategories(categories);
          categories = await Storage.getCategories();
          updateProfileBar();
        });
        profileBar.appendChild(btn);
      });

      const newBtn = document.createElement('button');
      newBtn.className = 'lfc-profile-cat lfc-profile-cat-new';
      newBtn.textContent = '+ 新建';
      newBtn.addEventListener('click', async () => {
        const name = prompt('输入新分类名称：');
        if (!name) return;
        removeFromAll();
        const newMember = { name: profileName, profilePath, title: '' };
        if (memberId) newMember.linkedinId = memberId;
        if (avatarUrl) newMember.avatar = avatarUrl;
        const newCat = {
          id: Storage.generateId(),
          name,
          color: '#4A90D9',
          order: categories.length,
          members: [newMember]
        };
        categories.push(newCat);
        await Storage.saveCategories(categories);
        categories = await Storage.getCategories();
        updateProfileBar();
      });
      profileBar.appendChild(newBtn);

      const closeBtn = document.createElement('button');
      closeBtn.className = 'lfc-profile-close';
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', () => stopProfileMode());
      profileBar.appendChild(closeBtn);
    };

    updateProfileBar();

    const main = document.querySelector('main');
    if (main) {
      main.insertBefore(profileBar, main.firstChild);
      LOG('profile bar injected');
    }
  }

  function waitForFeed(callback) {
    let attempts = 0;
    const check = () => {
      feedContainer = findFeedColumn();
      if (feedContainer) {
        debugShow(`[wait] 找到feed! tag=${feedContainer.tagName} class=${feedContainer.className?.substring(0, 60)}`);
        callback();
      } else if (attempts < 30) {
        attempts++;
        if (attempts % 5 === 0) {
          // 每5次输出详细诊断
          const main = document.querySelector('main');
          const inLinks = main ? main.querySelectorAll('a[href*="/in/"]').length : 0;
          const compLinks = main ? main.querySelectorAll('a[href*="/company/"]').length : 0;
          const allBtns = main ? Array.from(main.querySelectorAll('button')).slice(0, 5).map(b => b.textContent.trim().substring(0, 20)) : [];
          const sortText = main ? (main.textContent.match(/sort\s*by[^<]*/i) || ['none'])[0].substring(0, 30) : 'no main';
          debugShow(`[wait] ${attempts}/30 inLinks=${inLinks} compLinks=${compLinks} sortText="${sortText}" btns=[${allBtns.join('|')}]`);
        }
        setTimeout(check, 1000);
      } else {
        debugShow('[wait] 30s超时，未找到feed容器');
      }
    };
    check();
  }

  function injectFilterBar() {
    if (document.getElementById('lfc-filter-bar')) return;
    if (!feedContainer) return;

    filterBar = document.createElement('div');
    filterBar.id = 'lfc-filter-bar';
    renderTabs();

    // 优先插入到 feed 容器之前；如果 feedContainer 没有 parentElement（如 main 自身），则插入为第一个子元素
    if (feedContainer.parentElement) {
      feedContainer.parentElement.insertBefore(filterBar, feedContainer);
    } else {
      feedContainer.prepend(filterBar);
    }
    LOG('filter bar injected');
  }

  function renderTabs() {
    if (!filterBar) return;
    filterBar.innerHTML = '';

    const allTab = createTab('全部', null, activeCategory === null);
    filterBar.appendChild(allTab);

    categories
      .sort((a, b) => a.order - b.order)
      .forEach((cat, index) => {
        // 确保 id 是字符串
        const catId = typeof cat.id === 'string' ? cat.id : String(cat.id);
        const icon = cat.icon || DEFAULT_ICONS[index % DEFAULT_ICONS.length];
        const tab = createTab(`${icon} ${cat.name}`, catId, activeCategory === catId, cat.color);
        filterBar.appendChild(tab);
      });

    const manageTab = document.createElement('button');
    manageTab.className = 'lfc-tab lfc-tab-manage';
    manageTab.textContent = '⚙ 管理';
    manageTab.addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ type: 'openPopup' }); } catch {}
    });
    filterBar.appendChild(manageTab);
  }

  function createTab(label, catId, isActive, color) {
    const tab = document.createElement('button');
    tab.className = 'lfc-tab' + (isActive ? ' lfc-tab-active' : '');
    tab.textContent = label;
    if (color && !isActive) {
      // 使用颜色作为高亮，但不是背景色
    }
    tab.addEventListener('click', async () => {
      // "全部"分类：保持现有过滤行为
      if (catId === null) {
        activeCategory = null;
        await Storage.saveSettings({ ...settings, activeCategory: null });
        renderTabs();
        applyFilter();
        return;
      }

      // 具体分类：打开搜索结果页
      const cat = categories.find(c => String(c.id) === catId);
      if (!cat) return;

      const personsWithoutId = cat.members.filter(m => m.profilePath?.startsWith('/in/') && needsProfileVisit(m));
      const orgsWithoutId = cat.members.filter(m =>
        (m.profilePath?.startsWith('/company/') || m.profilePath?.startsWith('/school/') || m.profilePath?.startsWith('/showcase/')) && needsProfileVisit(m)
      );
      const membersWithoutId = [...personsWithoutId, ...orgsWithoutId];

      // 如果有成员需要提取信息，先提示并开始批量提取
      if (membersWithoutId.length > 0) {
        debugShow(`[信息补全] 分类 "${cat.name}" 有 ${membersWithoutId.length} 个成员需要提取信息`);
        membersWithoutId.forEach(m => debugShow(`  - ${m.name || m.profilePath}`));

        // 开始逐个打开提取（第一个在当前页，后续新标签）
        let msg = `开始提取 ${membersWithoutId.length} 个成员的信息，请稍候...\n`;
        if (personsWithoutId.length > 0) msg += `• 个人: ${personsWithoutId.length} 个\n`;
        if (orgsWithoutId.length > 0) msg += `• 公司/学校: ${orgsWithoutId.length} 个\n`;
        msg += '\n页面会自动跳转，提取 ID 和真实姓名。完成后请重新点击分类。';
        alert(msg);

        // 保存当前分类 ID 到 storage，提取完后可自动跳转
        await Storage.saveSettings({ ...settings, pendingCategoryId: catId, pendingExtractIndex: 0, pendingStartTime: Date.now() });

        // 跳转到第一个需要提取的成员页面
        const firstMember = membersWithoutId[0];
        window.location.href = `https://www.linkedin.com${firstMember.profilePath}`;
        return;
      }

      // 所有成员都有 ID，直接跳转搜索
      const urls = buildCategorySearchUrls(cat);
      debugShow(`[搜索跳转] 分类: ${cat.name}, 找到 ${urls.length} 个 URL`);
      urls.forEach((url, i) => debugShow(`  URL${i + 1}: ${url}`));

      if (urls.length > 0) {
        window.location.href = urls[0];
        if (urls.length > 1) {
          window.open(urls[1], '_blank');
        }
      }
    });
    return tab;
  }

  // 从帖子元素提取作者的 LinkedIn 内部 ID
  function extractLinkedinIdFromPost(postElement) {
    // 方法 1: 从帖子元素本身的 data-urn（如果是 person URN）
    const urn = postElement.getAttribute('data-urn');
    if (urn) {
      const personMatch = urn.match(/urn:li:person:([A-Za-z0-9_-]+)/);
      if (personMatch) return personMatch[1];
    }

    // 方法 2: 从作者链接的父元素查找 data-urn
    const authorLink = postElement.querySelector('a[href^="/in/"], a[href^="/company/"], a[href^="/school/"]');
    if (authorLink) {
      let el = authorLink.parentElement;
      let depth = 0;
      while (el && depth < 15) {
        const elUrn = el.getAttribute('data-urn');
        if (elUrn) {
          const personMatch = elUrn.match(/urn:li:person:([A-Za-z0-9_-]+)/);
          if (personMatch) return personMatch[1];
        }
        el = el.parentElement;
        depth++;
      }
    }

    return null;
  }

  // 提取 Feed 中所有可见帖子作者的 ID（自动收集）
  async function extractVisiblePostAuthorsId() {
    if (!isFeedPage()) return;

    const posts = findPosts();
    let extractedCount = 0;

    for (const post of posts) {
      const authorPath = getPostAuthorPath(post);
      if (!authorPath) continue;

      // 只提取在分类中的成员
      const isInCategory = categories.some(cat =>
        cat.members.some(m => m.profilePath === authorPath && !m.linkedinId)
      );
      if (!isInCategory) continue;

      const linkedinId = extractLinkedinIdFromPost(post);
      if (linkedinId) {
        // 更新成员 ID
        let updated = false;
        categories.forEach(cat => {
          const member = cat.members.find(m => m.profilePath === authorPath);
          if (member && !member.linkedinId) {
            member.linkedinId = linkedinId;
            updated = true;
          }
        });
        if (updated) {
          extractedCount++;
          debugShow(`[ID自动收集] ${authorPath} = ${linkedinId}`);
        }
      }
    }

    if (extractedCount > 0) {
      await Storage.saveCategories(categories);
      debugShow(`[ID自动收集] 本次提取 ${extractedCount} 个成员 ID`);
    }
  }

  // 更新指定成员的 LinkedIn ID
  async function updateMemberLinkedinId(profilePath, linkedinId) {
    if (!profilePath || !linkedinId) return;

    let updated = false;
    categories.forEach(cat => {
      // 使用统一匹配函数：支持两种格式匹配
      const member = cat.members.find(m => memberMatches(m, profilePath, linkedinId));
      if (member) {
        // 匹配成功后，统一更新 profilePath 为当前格式（确保一致性）
        member.profilePath = profilePath;
        if (!member.linkedinId) {
          member.linkedinId = linkedinId;
        }
        updated = true;
      }
    });

    if (updated) {
      await Storage.saveCategories(categories);
      debugShow(`[ID提取] 更新 ${profilePath} = ${linkedinId}`);
    }
  }

  // 清理成员名称：如果 name 是 profilePath 格式，转换为更友好的格式
  function cleanMemberName(name) {
    if (!name) return '';
    if (name.startsWith('/in/') || name.startsWith('/company/') || name.startsWith('/school/')) {
      const parts = name.split('/').filter(Boolean);
      if (parts.length >= 2) {
        return parts[1].replace(/-/g, ' ');
      }
    }
    return name;
  }

  // 构建分类搜索 URL（使用 fromMember 参数）
  function buildCategorySearchUrls(category) {
    if (!category.members || category.members.length === 0) {
      return [];
    }

    const personMembers = category.members.filter(m => m.profilePath?.startsWith('/in/'));
    const orgMembers = category.members.filter(m =>
      m.profilePath?.startsWith('/company/') || m.profilePath?.startsWith('/school/')
    );

    const urls = [];

    // 个人搜索 URL
    if (personMembers.length > 0) {
      const withIds = personMembers.filter(m => m.linkedinId);
      const withoutIds = personMembers.filter(m => !m.linkedinId);

      const params = [];

      // 有 ID 的成员使用 fromMember 参数
      if (withIds.length > 0) {
        const idsJson = JSON.stringify(withIds.map(m => m.linkedinId));
        params.push(`fromMember=${encodeURIComponent(idsJson)}`);
      }

      // 无 ID 的成员降级为名称搜索
      if (withoutIds.length > 0) {
        const names = withoutIds.map(m => cleanMemberName(m.name)).filter(Boolean);
        if (names.length > 0) {
          const keywords = names.map(n => `"${n}"`).join(' OR ');
          params.push(`keywords=${encodeURIComponent(keywords)}`);
        }
      }

      // 如果只有没有 ID 的成员，使用关键词搜索
      if (params.length === 0 && withoutIds.length > 0) {
        const names = withoutIds.map(m => cleanMemberName(m.name)).filter(Boolean);
        if (names.length > 0) {
          const keywords = names.map(n => `"${n}"`).join(' OR ');
          params.push(`keywords=${encodeURIComponent(keywords)}`);
        }
      }

      if (params.length > 0) {
        params.push('sortBy=%5B%22date_posted%22%5D');
        urls.push(`https://www.linkedin.com/search/results/content/?${params.join('&')}`);
      }
    }

    // 公司/学校搜索 URL - 使用 fromOrganization 参数
    if (orgMembers.length > 0) {
      const withIds = orgMembers.filter(m => m.linkedinId);
      const withoutIds = orgMembers.filter(m => !m.linkedinId);

      const params = [];

      // 有ID的公司使用 fromOrganization 参数
      if (withIds.length > 0) {
        const idsJson = JSON.stringify(withIds.map(m => m.linkedinId));
        params.push(`fromOrganization=${encodeURIComponent(idsJson)}`);
      }

      // 无ID的公司降级为名称搜索（尽可能避免）
      if (withoutIds.length > 0) {
        const names = withoutIds.map(m => cleanMemberName(m.name)).filter(Boolean);
        if (names.length > 0) {
          const keywords = names.map(n => `"${n}"`).join(' OR ');
          params.push(`keywords=${encodeURIComponent(keywords)}`);
        }
      }

      if (params.length > 0) {
        params.push('sortBy=%5B%22date_posted%22%5D');
        urls.push(`https://www.linkedin.com/search/results/content/?${params.join('&')}`);
      }
    }

    return urls;
  }

  function getPostAuthorPath(post) {
    const links = post.querySelectorAll('a[href*="/in/"], a[href*="/company/"], a[href*="/school/"], a[href*="/showcase/"]');
    for (const link of links) {
      if (link.closest('.comments-comments-list, .comments-comment-item, .social-details-social-counts')) continue;

      // 关键修复：只找真正的帖子发布者（在有 componentkey 的作者信息容器内）
      // 排除 "X likes this"、"X commented on this" 等互动提示区
      let hasComponentKey = false;
      let parent = link;
      for (let i = 0; i < 4; i++) {
        if (parent.parentElement) {
          parent = parent.parentElement;
          if (parent.getAttribute('componentkey')) {
            hasComponentKey = true;
            break;
          }
        }
      }
      if (!hasComponentKey) continue;

      const href = link.getAttribute('href');
      if (!href || typeof href !== 'string') continue;
      const match = href.match(/\/(in|company|school|showcase)\/([^/?#]+)/);
      if (match && match[1] && match[0]) {
        return match[0];
      }
    }
    return null;
  }

  // 全局关闭所有下拉菜单
  function closeAllAddMenus() {
    document.querySelectorAll('.lfc-add-menu').forEach(menu => menu.remove());
  }

  // 全局已处理作者集合（避免跨帖子间重复）
  const processedAuthors = new Set();

  // 辅助：为单个作者插入标签或按钮
  function insertTagForAuthor(authorLink, profilePath) {
    // 关键修复：全局去重，同一个作者只处理一次
    if (processedAuthors.has(profilePath)) return;

    // 最简化：直接在链接的父元素插入（找最近的flex或inline容器
    let insertPoint = authorLink.parentElement;

    // 向上找2层，确保在合适的容器
    for (let i = 0; i < 2 && insertPoint; i++) {
      // 如果已经有标签，直接返回
      if (insertPoint.querySelector('.lfc-post-tag, .lfc-add-btn')) return;
      if (window.getComputedStyle(insertPoint).display.match(/flex|inline/)) break;
      insertPoint = insertPoint.parentElement;
    }
    if (!insertPoint) return;

    // 最终检查：这个容器是否已有标签
    if (insertPoint.querySelector('.lfc-post-tag, .lfc-add-btn')) return;

    // 标记已处理
    processedAuthors.add(profilePath);

    // 查找该作者属于哪个分类（使用统一匹配函数，支持多种匹配）
    const memberCats = categories.filter(cat =>
      cat.members.some(m => memberMatches(m, profilePath, null))
    );

    if (memberCats.length > 0) {
      // 已分类：显示彩色标签
      const cat = memberCats[0];
      const tag = document.createElement('span');
      tag.className = 'lfc-post-tag';
      tag.textContent = (cat.icon || '') + cat.name;
      tag.style.cssText = `
        display: inline-flex !important;
        align-items: center !important;
        padding: 2px 8px !important;
        border-radius: 10px !important;
        font-size: 11px !important;
        font-weight: 600 !important;
        color: white !important;
        margin-left: 8px !important;
        white-space: nowrap !important;
        background: ${cat.color || '#007AFF'} !important;
        z-index: 9999 !important;
        vertical-align: middle !important;
        flex-shrink: 0 !important;
      `;
      insertPoint.appendChild(tag);
    } else {
      // 未分类：显示【+ 分组】按钮
      const addBtn = document.createElement('button');
      addBtn.className = 'lfc-add-btn';
      addBtn.textContent = '+ 分组';
      addBtn.style.cssText = `
        display: inline-flex !important;
        align-items: center !important;
        padding: 2px 8px !important;
        border-radius: 10px !important;
        font-size: 11px !important;
        font-weight: 600 !important;
        color: #007AFF !important;
        background: rgba(0, 122, 255, 0.1) !important;
        border: 1px solid rgba(0, 122, 255, 0.2) !important;
        margin-left: 8px !important;
        white-space: nowrap !important;
        z-index: 99999 !important;
        cursor: pointer !important;
        vertical-align: middle !important;
        flex-shrink: 0 !important;
      `;

      // 点击按钮显示下拉菜单
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();

        document.querySelectorAll('.lfc-add-menu').forEach(m => m.remove());

        const menu = document.createElement('div');
        menu.className = 'lfc-add-menu';
        menu.style.cssText = `
          position: fixed !important;
          background: white !important;
          border-radius: 12px !important;
          box-shadow: 0 8px 32px rgba(0,0,0,0.15) !important;
          z-index: 9999999 !important;
          min-width: 160px !important;
          max-height: 300px !important;
          overflow-y: auto !important;
          padding: 8px 0 !important;
        `;

        const rect = addBtn.getBoundingClientRect();
        menu.style.top = `${rect.bottom + 5}px`;
        menu.style.left = `${Math.min(rect.left, window.innerWidth - 180)}px`;

        // 添加现有分类选项
        categories.forEach(cat => {
          const option = document.createElement('div');
          option.textContent = (cat.icon || '') + ' ' + cat.name;
          option.style.cssText = `
            padding: 10px 16px !important;
            font-size: 13px !important;
            font-weight: 500 !important;
            color: #1d1d1f !important;
            cursor: pointer !important;
            white-space: nowrap !important;
          `;
          option.addEventListener('mouseenter', () => option.style.background = 'rgba(0, 122, 255, 0.08)');
          option.addEventListener('mouseleave', () => option.style.background = 'transparent');
          option.addEventListener('click', async (e) => {
            e.stopPropagation();
            const nameEl = authorLink.querySelector('span') || authorLink;
            const authorName = nameEl.textContent.trim().length < 50 ? nameEl.textContent.trim() : profilePath.split('/').pop();

            if (!Array.isArray(cat.members)) cat.members = [];
            cat.members.push({ name: authorName, profilePath, addedAt: Date.now() });
            await Storage.saveCategories(categories);
            location.reload();
          });
          menu.appendChild(option);
        });

        // 分割线 + 新建分类
        const divider = document.createElement('div');
        divider.style.cssText = 'height: 1px !important; background: #e5e5e5 !important; margin: 4px 12px !important;';
        menu.appendChild(divider);

        const newOption = document.createElement('div');
        newOption.textContent = '+ 新建分类';
        newOption.style.cssText = `
          padding: 10px 16px !important;
          font-size: 13px !important;
          font-weight: 600 !important;
          color: #007AFF !important;
          cursor: pointer !important;
          white-space: nowrap !important;
        `;
        newOption.addEventListener('mouseenter', () => newOption.style.background = 'rgba(0, 122, 255, 0.08)');
        newOption.addEventListener('mouseleave', () => newOption.style.background = 'transparent');
        newOption.addEventListener('click', async (e) => {
          e.stopPropagation();
          menu.remove();

          // 弹出输入框让用户输入分类名称
          const catName = prompt('请输入新分类名称：');
          if (!catName || !catName.trim()) return;

          // 创建新分类（先保存空分类，跳转后再加成员，确保信息完整）
          const newCatId = Storage.generateId();
          const newCat = {
            id: newCatId,
            name: catName.trim(),
            color: '#007AFF',
            order: categories.length,
            members: []
          };

          categories.push(newCat);
          await Storage.saveCategories(categories);

          // 保存待处理的添加成员任务到 settings
          const newSettings = {
            ...settings,
            pendingAddToCategory: newCatId,
            pendingAddProfilePath: profilePath,
            pendingAddStartTime: Date.now()
          };
          await Storage.saveSettings(newSettings);

          // 在新标签页打开作者 profile，原 feed 页保持不变
          window.open(`https://www.linkedin.com${profilePath}`, '_blank');

          // 提示用户
          alert(`已在新标签页打开「${profilePath.split('/').pop()}」的主页\n\n将自动完成分类添加，完成后可关闭新标签页继续浏览 Feed`);
        });
        menu.appendChild(newOption);

        document.body.appendChild(menu);
      });

      insertPoint.appendChild(addBtn);
    }
  }

  // 主函数：为帖子中所有作者渲染标签
  function renderCategoryTags(post) {
    // 找到帖子中所有作者链接（个人+公司+学校）
    const authorLinks = post.querySelectorAll('a[href*="/in/"], a[href*="/company/"], a[href*="/school/"], a[href*="/showcase/"]');

    // 排除评论区和互动统计区的链接
    const filtered = Array.from(authorLinks).filter(link =>
      !link.closest('.comments-comments-list, .comments-comment-item, .social-details-social-counts')
    );

    filtered.forEach(link => {
      const href = link.getAttribute('href');
      if (!href || typeof href !== 'string') return;
      const match = href.match(/\/(in|company|school|showcase)\/[^/?#]+/);
      if (!match) return;

      const profilePath = match[0];
      insertTagForAuthor(link, profilePath);
    });
  }

  // 点击其他地方关闭所有菜单
  document.addEventListener('click', closeAllAddMenus);

  function findPosts() {
    if (!feedContainer) return [];

    // 旧版选择器
    const legacy = feedContainer.querySelectorAll('[data-urn*="activity"], [data-urn*="ugcPost"], .feed-shared-update-v2');
    if (legacy.length > 0) {
      return Array.from(legacy).filter((el, i, arr) => !arr.some(other => other !== el && other.contains(el)));
    }

    // 新版：搜索整个子树中包含作者链接的元素，过滤嵌套情况
    const allWithLinks = feedContainer.querySelectorAll('*');
    const posts = [];
    for (const el of allWithLinks) {
      if (el.querySelector('a[href*="/in/"], a[href*="/company/"], a[href*="/school/"]')) {
        // 确保不是嵌套在其他帖子中
        if (!posts.some(p => p.contains(el))) {
          posts.push(el);
        }
      }
    }
    return posts;
  }

  function applyFilter() {
    const posts = findPosts();
    let shown = 0, hidden = 0, unknown = 0;

    // 防御性检查：确保 activeCategory 是正确类型
    if (activeCategory !== null && typeof activeCategory !== 'string') {
      activeCategory = null;
    }

    debugShow(`[applyFilter] posts=${posts.length}, activeCategory=${activeCategory}`);

    // 关键：每次过滤前清空已处理集合 + 清理所有旧标签/按钮
    processedAuthors.clear();
    document.querySelectorAll('.lfc-post-tag, .lfc-add-btn').forEach(el => el.remove());

    // 自动提取 Feed 中可见帖子作者的 ID（提前收集，减少后续批量跳转）
    extractVisiblePostAuthorsId();

    // 收集所有已分类作者（去重）
    const categorizedAuthors = new Set();
    if (!activeCategory) {
      categories.forEach(cat => {
        cat.members.forEach(m => {
          if (m.profilePath) categorizedAuthors.add(m.profilePath);
        });
      });
      debugShow(`[标签] 需要渲染标签的作者数: ${categorizedAuthors.size}`);
    }

    posts.forEach((post, idx) => {
      if (!activeCategory) {
        post.style.display = '';
        post.style.opacity = '';
        shown++;
        // 给帖子内所有作者渲染标签或加入按钮
        renderCategoryTags(post);
        return;
      }

      // 分类过滤模式：检查帖子作者是否属于该分类
      const authorPath = getPostAuthorPath(post);
      if (!authorPath) {
        unknown++;
        return;
      }

      const cat = categories.find(c => c.id === activeCategory);
      if (!cat) return;

      const isMember = cat.members.some(m =>
        typeof m.profilePath === 'string' && m.profilePath === authorPath
      );
      const mode = (typeof settings.filterMode === 'string') ? settings.filterMode : 'hide';

      if (isMember) {
        post.style.display = '';
        post.style.opacity = '';
        shown++;
      } else if (mode === 'hide') {
        post.style.display = 'none';
        hidden++;
      } else {
        post.style.display = '';
        post.style.opacity = '0.3';
        hidden++;
      }
    });

    LOG('applyFilter', { total: posts.length, shown, hidden, unknown, activeCategory });
  }

  function observeFeed() {
    if (feedObserver) feedObserver.disconnect();
    const target = feedContainer || findFeedColumn();
    if (!target) return;

    // 添加防抖，避免频繁调用
    let filterTimeout = null;
    feedObserver = new MutationObserver(() => {
      if (filterTimeout) clearTimeout(filterTimeout);
      filterTimeout = setTimeout(() => applyFilter(), 100);
    });

    feedObserver.observe(target, { childList: true, subtree: true });
    LOG('MutationObserver attached');
  }

  // --- Message handlers (work on all LinkedIn pages) ---
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'getPageProfileInfo') {
      const nameEl = document.querySelector('h1.text-heading-xlarge, h1.top-card-layout__title, .org-top-card-summary__title, h1');
      const titleEl = document.querySelector('.text-body-medium.break-words, .top-card-layout__headline, .org-top-card-summary__tagline');
      const linkedinId = extractMemberIdFromProfilePage();
      sendResponse({
        name: nameEl ? nameEl.textContent.trim() : null,
        title: titleEl ? titleEl.textContent.trim() : null,
        linkedinId: linkedinId
      });
      return false;
    }

    if (message.type === 'getAuthorName') {
      const profilePath = message.profilePath;
      const link = document.querySelector(`a[href*="${profilePath}"]`);
      // 方式1: 从链接查找
      if (link) {
        const nameEl = link.querySelector('span') || link.closest('[data-urn]')?.querySelector('span[aria-hidden], span.visually-hidden, span');
        if (nameEl) {
          sendResponse(nameEl.textContent.trim());
          return false;
        }
      }
      // 方式2: 用 cleanMemberName 从 profilePath 提取友好名称（兜底）
      const friendlyName = cleanMemberName(profilePath);
      sendResponse(friendlyName || profilePath);
      return false;
    }

    if (message.type === 'promptNewCategory') {
      const name = prompt('输入新分类名称：');
      if (!name) return;
      (async () => {
        const cats = await Storage.getCategories();
        const authorName = message.authorName || message.profilePath;
        const newCat = {
          id: Storage.generateId(),
          name,
          color: '#4A90D9',
          order: cats.length,
          members: [{ name: authorName, profilePath: message.profilePath, title: '' }]
        };
        cats.push(newCat);
        await Storage.saveCategories(cats);
      })();
      return false;
    }

    if (message.type === 'extractFollowing') {
      extractFollowingList().then(sendResponse);
      return true;
    }
  });

  async function extractFollowingList() {
    const people = [];
    const cards = document.querySelectorAll(
      '.mn-connection-card, ' +
      '.entity-result, ' +
      '[data-view-name="following-list-item"]'
    );

    cards.forEach(card => {
      const nameEl = card.querySelector('.mn-connection-card__name, .entity-result__title-text a, a[href*="/in/"]');
      const titleEl = card.querySelector('.mn-connection-card__occupation, .entity-result__primary-subtitle');
      const link = card.querySelector('a[href*="/in/"], a[href*="/company/"], a[href*="/school/"]');

      if (!nameEl || !link) return;

      const href = link.getAttribute('href');
      const match = href.match(/\/(in|company|school)\/([^/?#]+)/);
      if (!match) return;

      people.push({
        name: nameEl.textContent.trim(),
        profilePath: `/${match[1]}/${match[2]}`,
        title: titleEl ? titleEl.textContent.trim() : ''
      });
    });

    return people;
  }

  init();
})();
