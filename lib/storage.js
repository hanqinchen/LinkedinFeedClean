const Storage = {
  // 防抖状态
  _saveTimeout: null,

  // 检测扩展上下文是否有效（chrome.runtime.id 是最可靠的检测方式）
  isContextValid() {
    try {
      // 访问 chrome.runtime.id 会在上下文失效时同步抛出异常
      return !!chrome.runtime.id && !!chrome.storage;
    } catch {
      return false;
    }
  },

  // 安全执行 chrome.storage 操作（前后双重检测上下文）
  async _safeStorageOp(operation) {
    if (!this.isContextValid()) {
      throw new Error('Extension context invalidated');
    }
    try {
      const result = await operation();
      // 二次检测：await 期间上下文可能已失效
      if (!this.isContextValid()) {
        throw new Error('Extension context invalidated during operation');
      }
      return result;
    } catch (err) {
      throw new Error(`Storage operation failed: ${err.message}`);
    }
  },

  // localStorage fallback key
  LOCAL_STORAGE_KEY: 'linkedin_feed_categorizer_data',

  async getCategories() {
    // 先尝试 chrome.storage
    if (this.isContextValid()) {
      try {
        const data = await this._safeStorageOp(() => chrome.storage.sync.get('categories'));
        if (data.categories === '__local__') {
          const local = await this._safeStorageOp(() => chrome.storage.local.get('categories'));
          const result = local.categories || [];
          // 同步到 localStorage 作为备份
          try { localStorage.setItem(this.LOCAL_STORAGE_KEY + '_cats', JSON.stringify(result)); } catch {}
          return result;
        }
        const result = data.categories || [];
        // 同步到 localStorage 作为备份
        try { localStorage.setItem(this.LOCAL_STORAGE_KEY + '_cats', JSON.stringify(result)); } catch {}
        return result;
      } catch (err) {
        console.warn('[Storage] chrome.storage failed, trying localStorage:', err.message);
      }
    }
    // 降级到 localStorage
    try {
      const data = localStorage.getItem(this.LOCAL_STORAGE_KEY + '_cats');
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  async saveCategories(categories) {
    // 先保存到 localStorage（总是可用）
    try { localStorage.setItem(this.LOCAL_STORAGE_KEY + '_cats', JSON.stringify(categories)); } catch {}

    // 再尝试 chrome.storage
    if (this.isContextValid()) {
      try {
        const json = JSON.stringify(categories);
        const byteLength = new TextEncoder().encode(json).byteLength;
        if (byteLength > 7500) {
          await this._safeStorageOp(() => chrome.storage.local.set({ categories }));
          await this._safeStorageOp(() => chrome.storage.sync.set({ categories: '__local__' }));
        } else {
          await this._safeStorageOp(() => chrome.storage.sync.set({ categories }));
        }
      } catch (err) {
        // 上下文失效是扩展重载后的正常情况，静默降级（localStorage 已保存）
        if (!err.message.includes('context invalidated')) {
          console.warn('[Storage] chrome.storage save failed:', err.message);
        }
      }
    }
  },

  // 防抖保存：批量操作时减少 chrome.storage 写入频率
  async saveCategoriesDebounced(categories, delayMs = 1000) {
    // localStorage 总是立即保存（数据永不丢失）
    try { localStorage.setItem(this.LOCAL_STORAGE_KEY + '_cats', JSON.stringify(categories)); } catch {}

    // chrome.storage 延迟写入
    clearTimeout(this._saveTimeout);

    return new Promise((resolve, reject) => {
      this._saveTimeout = setTimeout(async () => {
        try {
          await this.saveCategories(categories);
          resolve();
        } catch (err) {
          reject(err);
        }
      }, delayMs);
    });
  },

  // 页面卸载时清理待定的保存任务
  flushPendingSave() {
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
      this._saveTimeout = null;
    }
  },

  async getSettings() {
    const defaultSettings = { claudeApiKey: '', filterMode: 'hide', activeCategory: null };

    // 先尝试 chrome.storage
    if (this.isContextValid()) {
      try {
        const data = await this._safeStorageOp(() => chrome.storage.sync.get('settings'));
        const result = data.settings || defaultSettings;
        try { localStorage.setItem(this.LOCAL_STORAGE_KEY + '_settings', JSON.stringify(result)); } catch {}
        return result;
      } catch (err) {
        console.warn('[Storage] chrome.storage failed, trying localStorage:', err.message);
      }
    }
    // 降级到 localStorage
    try {
      const data = localStorage.getItem(this.LOCAL_STORAGE_KEY + '_settings');
      return data ? JSON.parse(data) : defaultSettings;
    } catch {
      return defaultSettings;
    }
  },

  async saveSettings(settings) {
    // 先保存到 localStorage（总是可用）
    try { localStorage.setItem(this.LOCAL_STORAGE_KEY + '_settings', JSON.stringify(settings)); } catch {}

    // 再尝试 chrome.storage
    if (this.isContextValid()) {
      try {
        await this._safeStorageOp(() => chrome.storage.sync.set({ settings }));
      } catch (err) {
        console.warn('[Storage] chrome.storage save failed:', err.message);
      }
    }
  },

  generateId() {
    return 'cat_' + Date.now();
  }
};

if (typeof module !== 'undefined') {
  module.exports = Storage;
}
