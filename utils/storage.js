// Gemini Reading Assistant - Storage Utilities
// ---------------------------------------------
// 這個模組對 chrome.storage.local 提供簡單且可重用的封裝。
// 可在 content script、popup 等前景環境中直接使用。
//
// 設計目標：
// - 使用單一命名空間 key，避免與其他 extension 衝突
// - 提供預設設定值與方便的存取 API
// - 針對「設定」與「引用暫存夾」分別提供方法

(function () {
  const SETTINGS_KEY = "gra_settings";
  const QUOTES_KEY = "gra_quotes";

  /**
   * V1 預設設定值。
   *
   * extensionEnabled: 是否啟用整體擴充功能
   * showNavigator: 是否顯示右側段落導航列
   * showQuotePanel: 是否顯示引用暫存夾面板
   *
   * 之後若要加入更多模組（例如：浮動工具列、本頁搜尋），
   * 可以在這裡擴充欄位，並讓其他程式碼透過同一個物件存取。
   */
  const DEFAULT_SETTINGS = {
    extensionEnabled: true,
    showNavigator: true,
    showQuotePanel: true,

    // 預留未來用欄位（目前不一定會在 UI 中呈現）
    showSelectionToolbar: true,
    showGeminiInputInsertion: true,
    showPageSearch: true
  };

  /**
   * 從 chrome.storage.local 非同步讀取資料的輔助函式。
   */
  function readFromStorage(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (result) => resolve(result || {}));
    });
  }

  /**
   * 寫入 chrome.storage.local 的輔助函式。
   */
  function writeToStorage(object) {
    return new Promise((resolve) => {
      chrome.storage.local.set(object, () => resolve());
    });
  }

  /**
   * 取得目前設定（會自動套用預設值）。
   */
  async function getSettings() {
    const stored = await readFromStorage([SETTINGS_KEY]);
    const raw = stored[SETTINGS_KEY] || {};
    return {
      ...DEFAULT_SETTINGS,
      ...raw
    };
  }

  /**
   * 儲存部分設定。
   * 會先讀取舊設定，將 partialSettings 合併後整包寫回。
   */
  async function saveSettings(partialSettings) {
    const current = await getSettings();
    const next = {
      ...current,
      ...(partialSettings || {})
    };

    await writeToStorage({
      [SETTINGS_KEY]: next
    });

    return next;
  }

  /**
   * 取得目前儲存的引用列表。
   * V1 僅定義為字串陣列，後續可改成物件結構。
   */
  async function getQuotes() {
    const stored = await readFromStorage([QUOTES_KEY]);
    const quotes = stored[QUOTES_KEY];
    if (Array.isArray(quotes)) {
      return quotes;
    }
    return [];
  }

  /**
   * 儲存引用列表。
   * @param {Array} quotes - 任意型別陣列，V1 預期為字串陣列。
   */
  async function saveQuotes(quotes) {
    const safeQuotes = Array.isArray(quotes) ? quotes : [];
    await writeToStorage({
      [QUOTES_KEY]: safeQuotes
    });
    return safeQuotes;
  }

  /**
   * 清除所有引用資料。
   */
  async function clearQuotes() {
    const empty = [];
    await writeToStorage({
      [QUOTES_KEY]: empty
    });
    return empty;
  }

  // ---- Conversation Journal (V2.9A) -----------------------------------------

  const CONVERSATION_INDEX_KEY = "gra_conversation_index";

  function journalKey(conversationKey) {
    return `gra_conversation_journal_${conversationKey}`;
  }

  function snapshotKey(conversationKey) {
    return `gra_conversation_snapshot_${conversationKey}`;
  }

  /**
   * 取得對話索引（最近對話 key 列表）。
   */
  async function getConversationIndex() {
    const stored = await readFromStorage([CONVERSATION_INDEX_KEY]);
    const raw = stored[CONVERSATION_INDEX_KEY];
    if (raw && Array.isArray(raw.keys)) {
      return { keys: raw.keys, updatedAt: raw.updatedAt || 0 };
    }
    return { keys: [], updatedAt: 0 };
  }

  /**
   * 儲存對話索引。
   */
  async function saveConversationIndex(indexData) {
    const safe = {
      keys: Array.isArray(indexData?.keys) ? indexData.keys : [],
      updatedAt: indexData?.updatedAt ?? Date.now()
    };
    await writeToStorage({ [CONVERSATION_INDEX_KEY]: safe });
    return safe;
  }

  /**
   * 取得指定對話的 journal。
   */
  async function getConversationJournal(conversationKey) {
    if (!conversationKey) return null;
    const stored = await readFromStorage([journalKey(conversationKey)]);
    return stored[journalKey(conversationKey)] || null;
  }

  /**
   * 儲存指定對話的 journal。
   */
  async function saveConversationJournal(conversationKey, journal) {
    if (!conversationKey || !journal) return null;
    await writeToStorage({ [journalKey(conversationKey)]: journal });
    return journal;
  }

  /**
   * 取得指定對話的 snapshot。
   */
  async function getConversationSnapshot(conversationKey) {
    if (!conversationKey) return null;
    const stored = await readFromStorage([snapshotKey(conversationKey)]);
    return stored[snapshotKey(conversationKey)] || null;
  }

  /**
   * 儲存指定對話的 snapshot。
   */
  async function saveConversationSnapshot(conversationKey, snapshot) {
    if (!conversationKey || !snapshot) return null;
    await writeToStorage({ [snapshotKey(conversationKey)]: snapshot });
    return snapshot;
  }

  // 將工具暴露到全域命名空間，以便在 content script / popup 中共用。
  // 若 window 不存在（例如 background service worker），則僅輸出為自執行函式內部工具。
  if (typeof window !== "undefined") {
    window.GRAStorage = {
      SETTINGS_KEY,
      QUOTES_KEY,
      DEFAULT_SETTINGS,
      getSettings,
      saveSettings,
      getQuotes,
      saveQuotes,
      clearQuotes,
      getConversationIndex,
      saveConversationIndex,
      getConversationJournal,
      saveConversationJournal,
      getConversationSnapshot,
      saveConversationSnapshot
    };
  }
})();

