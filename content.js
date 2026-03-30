// Gemini Reading Assistant - Content Script (Manifest V3)
// -------------------------------------------------------
// This file is the main entry point injected into Gemini web pages.
// V1 只建立模組架構與初始化流程，功能由各模組日後實作。
//
// 主要責任：
// - 檢查是否為支援的 Gemini 網頁
// - 從 chrome.storage.local 載入使用者設定
// - 初始化各功能模組（右側導航、浮動工具列、引用暫存夾、插入 Gemini 輸入框、本頁關鍵字搜尋）
// - 監聽 popup / background 發送的控制訊息

// ---- DOM 彈性緩衝層（集中 Selector 定義，方便 Gemini DOM 更新時統一維護）----
var GRASelectors = {
  SEND_BUTTON: '[aria-label="傳送訊息"], [data-testid="send-button"], button.send-button, [aria-label="Send message"]',
  MESSAGE_CONTAINER: '[data-message-id], [data-qa="message"], [data-qa="conversation-turn"], article',
  RICH_TEXTAREA: 'rich-textarea',
  CONTENTEDITABLE: "[contenteditable='true']"
};

// ---- 型別與常數定義 --------------------------------------------------------

/**
 * 預設設定值。
 * 優先使用 utils/storage.js 中提供的 DEFAULT_SETTINGS。
 */
const DEFAULT_SETTINGS =
  typeof GRAStorage !== "undefined" && GRAStorage.DEFAULT_SETTINGS
    ? GRAStorage.DEFAULT_SETTINGS
    : {
        extensionEnabled: true,
        showNavigator: true,
        showQuotePanel: true,
        showSelectionToolbar: true,
        showGeminiInputInsertion: true,
        showPageSearch: true
      };

/**
 * 目前僅支援的網域白名單。
 * 若未來需要支援更多 Gemini 子網域，可在這裡擴充。
 */
const SUPPORTED_HOSTS = ["gemini.google.com"];

/** Production log gate: set to true for verbose diagnostics. */
const GRA_DEBUG = false;
const GRA_DEBUG_SIDEBAR = false;
const GRA_DEBUG_SIDEBAR_SCROLL = false;

// ---- 工具函式 --------------------------------------------------------------

/**
 * 確認目前頁面是否為支援的 Gemini 網頁。
 */
function isSupportedGeminiPage() {
  try {
    return SUPPORTED_HOSTS.includes(window.location.hostname);
  } catch (error) {
    console.warn("[GRA] Failed to detect host", error);
    return false;
  }
}

/**
 * 偵測目前 Gemini 頁型，供 diagnostics 使用。
 * @returns {"gemini-chat"|"coding-partner"|"unknown"}
 */
function detectPageType() {
  const path = (window.location.pathname || "").toLowerCase();

  if (path.includes("/gem/coding-partner")) {
    return "coding-partner";
  }
  if (
    path === "/" ||
    path === "" ||
    path.includes("/app") ||
    (path.includes("/gem/") && !path.includes("coding-partner"))
  ) {
    return "gemini-chat";
  }

  if (document.querySelector("rich-textarea")) {
    return "gemini-chat";
  }
  return "unknown";
}

/**
 * 偵測目前對話的 storage key，供 journal / snapshot 使用。
 * @returns {string} 例如 gemini:/u/1/gem/coding-partner/f3a7e7476a28b420 或 gemini:unknown
 */
function detectConversationKey() {
  const path = (window.location.pathname || "").trim();
  const base = path || "unknown";
  return `gemini:${base}`;
}

// ---- Message Store (Export V3) ---------------------------------------------

/**
 * 唯一資料來源：儲存每則訊息的 final 狀態，供 export 使用。
 * key = data-gra-message-id
 */
const messageStore = new Map();
let __gra_seq = 0;

// ---- Top-level helpers for export（不依賴任何模組 IIFE）----

/**
 * 從 message element 提取文字內容（獨立版，不依賴 SidebarNavigationModule）。
 */
function __gra_getSourceText(el) {
  if (!el) return "";
  const SELECTORS = [
    "message-content", ".message-content", "[data-message-content]",
    ".markdown-content", ".response-content", "model-response"
  ];
  let root = null;
  for (const sel of SELECTORS) {
    root = el.querySelector(sel);
    if (root) break;
  }
  root = root || el;
  return (root.innerText || root.textContent || "").trim().replace(/\s+/g, " ");
}

/**
 * 找出頁面上所有已標記 data-gra-message-id 的 message 元素（獨立版）。
 */
function __gra_findMessages() {
  return Array.from(document.querySelectorAll("[data-gra-message-id]"));
}

/**
 * 判定 message 角色（獨立版，不依賴 SidebarNavigationModule）。
 * @returns {"user"|"assistant"|"unknown"}
 */
function __gra_detectRole(el) {
  if (!el || !(el instanceof HTMLElement)) return "unknown";
  // 1) 自訂標籤
  var tag = (el.tagName || "").toUpperCase();
  if (tag === "USER-QUERY") return "user";
  if (tag === "MODEL-RESPONSE" || tag.startsWith("MODEL-") ||
      tag.startsWith("BOT-") || tag.startsWith("RESPONSE-") ||
      tag.startsWith("GEMINI-")) return "assistant";
  // 2) data-author 向上查找
  var node = el;
  while (node && node !== document.body) {
    var author = (node.getAttribute("data-author") ||
                  node.getAttribute("data-message-author") || "").toLowerCase();
    if (["user", "human", "1"].some(function(v) { return author.includes(v); })) return "user";
    if (["model", "assistant", "gemini", "2"].some(function(v) { return author.includes(v); })) return "assistant";
    node = node.parentElement;
  }
  return "unknown";
}

/**
 * 從 normalized text 建立指紋，供 journal 去重用。
 * 簡單可用版：前後片段組合，不要求密碼學強度。
 */
function buildMessageFingerprint(text) {
  const s = (text || "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  const len = s.length;
  const head = s.slice(0, 40);
  const tail = len > 80 ? s.slice(-40) : "";
  return tail ? `${head}…${tail}` : head;
}

/**
 * 從訊息節點與 metadata 正規化為 journal entry 格式。
 */
function normalizeConversationBlock(node, index, messageType) {
  const text = (node?.textContent || "").trim().replace(/\s+/g, " ");
  const summary = text.slice(0, 60);
  const messageFingerprint = buildMessageFingerprint(text);
  const sourceMessageId =
    node?.getAttribute?.("data-gra-message-id") ||
    node?.getAttribute?.("data-message-id") ||
    null;

  return {
    index,
    messageFingerprint,
    type: messageType,
    text,
    summary,
    sourceMessageId,
    capturedAt: Date.now()
  };
}

/**
 * 從 chrome.storage.local 載入設定，若不存在則回傳預設值。
 */
async function loadSettings() {
  if (typeof GRAStorage !== "undefined" && GRAStorage.getSettings) {
    return GRAStorage.getSettings();
  }

  // 後備實作：直接從 chrome.storage.local 讀取。
  return new Promise((resolve) => {
    chrome.storage.local.get(["gra_settings"], (result) => {
      const stored = result.gra_settings;
      resolve({ ...DEFAULT_SETTINGS, ...(stored || {}) });
    });
  });
}

/**
 * 儲存設定到 chrome.storage.local。
 */
async function saveSettings(settings) {
  if (typeof GRAStorage !== "undefined" && GRAStorage.saveSettings) {
    return GRAStorage.saveSettings(settings);
  }

  return new Promise((resolve) => {
    chrome.storage.local.set(
      {
        gra_settings: settings
      },
      () => resolve()
    );
  });
}

/**
 * Phase 1 UX 附加層：閱讀聚焦、訊息收合（不介入 DOM 抽取／分類 pipeline）。
 * 檔案內模組作用域，不掛到 window。
 */
const GraReadingPhase1Ux = (() => {
  let focusedNode = null;
  let collapsedExpandListenerBound = false;

  function ensureGraMessage(node) {
    try {
      if (node && node.classList) node.classList.add("gra-message");
    } catch (_) {}
  }

  function toggleFocus(node) {
    if (!node || !(node instanceof HTMLElement) || !node.classList) return;
    if (focusedNode === node) {
      document.body.classList.remove("gra-focus-active");
      node.classList.remove("gra-focus-target");
      focusedNode = null;
      return;
    }
    if (focusedNode && focusedNode.classList) {
      focusedNode.classList.remove("gra-focus-target");
    }
    document.body.classList.add("gra-focus-active");
    focusedNode = node;
    node.classList.add("gra-focus-target");
  }

  function clearFocusForRebuild() {
    try {
      document.body.classList.remove("gra-focus-active");
      if (focusedNode && focusedNode.classList) {
        focusedNode.classList.remove("gra-focus-target");
      }
    } catch (_) {}
    focusedNode = null;
  }

  function toggleCollapse(node) {
    if (!node || !(node instanceof HTMLElement) || !node.classList) return;
    node.classList.toggle("gra-collapsed");
  }

  /** 點擊收合區底部「展開」提示時展開（不新增 message 子節點）。 */
  function ensureCollapsedExpandClickDelegate() {
    if (collapsedExpandListenerBound) return;
    collapsedExpandListenerBound = true;
    document.addEventListener(
      "click",
      (e) => {
        try {
          const hit = e.target instanceof Element ? e.target : e.target?.parentElement;
          if (hit && hit.closest && hit.closest(".gra-sidebar-nav")) return;
          const el = hit && hit.closest && hit.closest(".gra-collapsed.gra-message");
          if (!el || !document.body.contains(el)) return;
          const rect = el.getBoundingClientRect();
          if (rect.height <= 0) return;
          if (e.clientY < rect.bottom - 44) return;
          e.preventDefault();
          e.stopPropagation();
          el.classList.remove("gra-collapsed");
        } catch (_) {}
      },
      true
    );
  }

  return {
    ensureGraMessage,
    toggleFocus,
    toggleCollapse,
    clearFocusForRebuild,
    ensureCollapsedExpandClickDelegate
  };
})();

// ---- 模組骨架定義 ----------------------------------------------------------

// ---- Snapshot Handoff (Pro) ------------------------------------------------

/**
 * Pro: 一鍵銜接 — 匯出重點摘要 + 環境快照 + 開新對話 + 注入延續提示詞。
 * Opt-3: 一併傳遞 geminiPlan 設定值，確保新分頁 Usage Meter 使用正確計量。
 */
async function snapshotHandoff() {
  var convKey = detectConversationKey();
  var pins = typeof GRAStorage !== "undefined"
    ? await GRAStorage.getMemoryPins(convKey)
    : [];

  var summary = "";

  if (pins.length > 0) {
    // Opt-2: Sort by weight (core first)
    var sorted = pins.slice().sort(function (a, b) {
      var w = { core: 1, phase: 2 };
      return (w[a.type] || 2) - (w[b.type] || 2);
    });
    summary += "## 重點記憶\n\n";
    sorted.forEach(function (p, i) {
      var prefix = p.type === "core" ? "[CRITICAL PROJECT BASEPOINT] " : "[Phase] ";
      summary += (i + 1) + ". " + prefix + p.text + "\n";
    });
    summary += "\n";
  }

  // Add last 3 exchanges from messageStore
  var messages = Array.from(messageStore.values())
    .sort(function (a, b) { return a.seq - b.seq; });
  var lastMessages = messages.slice(-6);
  if (lastMessages.length > 0) {
    summary += "## 最近對話\n\n";
    lastMessages.forEach(function (msg) {
      var label = msg.role === "user" ? "使用者" : "Gemini";
      var text = msg.text.length > 300 ? msg.text.slice(0, 297) + "..." : msg.text;
      summary += "**" + label + ":** " + text + "\n\n";
    });
  }

  var continuationPrompt =
    "以下是上一輪對話的核心錨點、階段共識與近期脈絡。標記為 [CRITICAL PROJECT BASEPOINT] 的項目是不可偏離的決策基點：\n---\n" +
    summary +
    "---\n請確認你已校準以上基點，然後等待我的下一個指令。";

  // Copy to clipboard as backup
  try {
    await navigator.clipboard.writeText(continuationPrompt);
  } catch (_) {}

  // Open new Gemini tab
  window.open("https://gemini.google.com/app", "_blank");

  // Opt-3: Store prompt + geminiPlan for new tab to pick up
  if (typeof GRAStorage !== "undefined") {
    var currentSettings = await GRAStorage.getSettings();
    await GRAStorage.writeToStorage({
      gra_pending_handoff: {
        prompt: continuationPrompt,
        geminiPlan: currentSettings.geminiPlan || "pro-128k",
        createdAt: Date.now()
      }
    });
  }
}

/**
 * 右側段落節點導航模組。
 *
 * 功能：
 * - 在頁面右側建立固定浮動導航列
 * - 自動掃描 Gemini 對話中的主要訊息區塊並建立節點
 * - 點擊節點平滑捲動到對應訊息
 * - 根據視窗中心位置高亮最接近的節點
 * - 使用 MutationObserver 監聽內容變化並以 debounce 方式重新掃描
 *
 * 啟用條件：
 * - 僅在 Gemini 網頁版 (由 isSupportedGeminiPage() 判斷)
 * - 僅在 settings.extensionEnabled === true 且 settings.showNavigator === true 時啟用
 */
const SidebarNavigationModule = (() => {
  let container = null;
  let handleEl = null;
  let bodyEl = null;
  let toolbarEl = null;
  let listEl = null;
  let tooltipEl = null;
  let items = []; // { id, navEl, targetEl, summary, messageType }
  let observer = null;
  let rescanTimer = null;
  /** 短時間內 DOM childList 突變次數累計；串流輸出時會上升，用於拉長 debounce 減少主執行緒卡頓。 */
  let rescanMutationBurstWeight = 0;
  let scrollTicking = false;

  // 收合 / 展開 / 固定 狀態
  let isPinnedOpen = false;
  let collapseTimer = null;
  const COLLAPSE_DELAY_MS = 200;

  // 篩選狀態：'all' | 'gemini' | 'user'
  let currentFilter = "all";

  // 模組級 settings 參照（由 init/update 寫入，供 runCondenseV75 等內部函式使用）
  let _moduleSettings = null;
  // Pro 狀態（由 init 寫入，供 Pro 功能判斷）
  let _proEnabled = false;

  // 供 diagnostics 使用：最後使用的 selector 策略
  let lastStrategy = "none";

  /** 每輪掃描重置：從 turn wrapper 拆出原子訊息時寫入的節點 meta */
  let sidebarNodeKeptMeta = new WeakMap();

  /** turn wrapper 診斷計數（每輪 findMessageElements 開頭重置） */
  let lastTurnWrapperStats = {
    turnWrappersDetected: 0,
    turnWrappersExtracted: 0,
    atomicUnitsExtractedCount: 0
  };

  /**
   * user prompt 漏抓專用診斷（每輪 findMessageElements 重置）。
   * @type {{
   *   userQueryCandidates: object[],
   *   userLikeNotKept: object[],
   *   suppressedChains: object[]
   * } | null}
   */
  let lastUserPromptLeakDebug = null;

  function resetUserPromptLeakDebug() {
    lastUserPromptLeakDebug = {
      userQueryCandidates: [],
      userLikeNotKept: [],
      suppressedChains: []
    };
  }

  function previewElText(el, max) {
    try {
      return (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, max ?? 90);
    } catch (_) {
      return "";
    }
  }

  /**
   * 僅檢查元素自身（不含祖先）是否帶明確 user author。
   */
  function isExplicitUserRoleOnElement(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    const a = (
      el.getAttribute("data-author") ||
      el.getAttribute("data-message-author") ||
      ""
    ).toLowerCase()
      .trim();
    if (!a) return false;
    if (a === "user" || a === "human" || a === "1") return true;
    return /(^|[^a-z])(user|human|1)([^a-z]|$)/i.test(a);
  }

  /** 用於漏抓追蹤：user-query、明確 user author、或 isPotentialUserLikeCandidate */
  function isUserLikeForLeakTracking(el, root) {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (isUserQueryTagElement(el)) return true;
    if (isExplicitUserRoleOnElement(el)) return true;
    return isPotentialUserLikeCandidate(el, root);
  }

  /**
   * 更新 sidebar 的 state class。
   */
  function applySidebarState() {
    if (!container) return;
    container.classList.remove(
      "gra-sidebar-nav--collapsed",
      "gra-sidebar-nav--expanded",
      "gra-sidebar-nav--pinned"
    );
    if (isPinnedOpen) {
      container.classList.add("gra-sidebar-nav--pinned");
    } else {
      container.classList.add("gra-sidebar-nav--collapsed");
    }
  }

  /**
   * 暫時展開（hover 時）。
   */
  function setExpanded() {
    if (!container) return;
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
    container.classList.remove("gra-sidebar-nav--collapsed");
    container.classList.add("gra-sidebar-nav--expanded");
  }

  /**
   * 收合（非 pinned 時）。
   */
  function setCollapsed() {
    if (!container || isPinnedOpen) return;
    container.classList.remove("gra-sidebar-nav--expanded");
    container.classList.add("gra-sidebar-nav--collapsed");
  }

  function handleHandleClick() {
    isPinnedOpen = !isPinnedOpen;
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
    applySidebarState();
  }

  function handleMouseEnter() {
    if (isPinnedOpen) return;
    setExpanded();
  }

  function handleMouseLeave() {
    if (isPinnedOpen) return;
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => {
      collapseTimer = null;
      setCollapsed();
    }, COLLAPSE_DELAY_MS);
  }

  /**
   * 評分 root 候選：加分為正文特徵，扣分為外層殼 / composer 為主。
   */
  function scoreConversationRootCandidate(el, mainEl) {
    if (!el || !(el instanceof HTMLElement)) return -9999;
    let score = 0;
    const textLen = (el.textContent || "").trim().length;
    const mainRect = mainEl?.getBoundingClientRect?.() || { width: 1, height: 1 };
    const elRect = el.getBoundingClientRect();

    if (el === mainEl || el.tagName === "MAIN") {
      score -= 50;
    }
    if (el.closest?.("rich-textarea") || el.querySelector?.("rich-textarea")) score -= 30;
    if (el.querySelector?.("[contenteditable='true']") && textLen < 500) score -= 20;
    if (el.querySelector?.(".gra-sidebar-nav, .gra-citation-panel")) score -= 50;

    const paragraphCount = el.querySelectorAll?.("p")?.length || 0;
    const blockEls = el.querySelectorAll?.("pre, blockquote, ul, ol, article, [role='listitem']")?.length || 0;
    const messageLike = el.querySelectorAll?.("[data-message-id], [data-qa='message'], [data-qa='conversation-turn'], article")?.length || 0;

    score += Math.min(paragraphCount * 2, 20);
    score += Math.min(blockEls * 3, 15);
    score += Math.min(messageLike * 5, 25);
    if (textLen >= 200) score += 10;
    if (textLen >= 500) score += 5;

    try {
      const style = getComputedStyle(el);
      if (/auto|scroll|overlay/.test(style.overflowY || style.overflow || "")) score += 15;
    } catch (_) {}

    if (elRect.height > mainRect.height * 0.8 && textLen > 10000) score -= 20;
    if (elRect.width < 200 || elRect.height < 150) score -= 15;

    return score;
  }

  /**
   * 在 main 內找更好的對話內容容器，避免直接選 MAIN.chat-app。
   * @returns {{ best: HTMLElement, candidates: Array<{ tag, class, textLen, score }> }}
   */
  function findBestConversationRootWithinMain(mainEl) {
    if (!mainEl || !mainEl.querySelector) return { best: mainEl, candidates: [] };

    const firstMessage = findFirstMessageLikeElement(mainEl);
    if (!firstMessage) return { best: mainEl, candidates: [] };

    const candidateEls = [];
    let el = firstMessage.parentElement;
    while (el && el !== mainEl) {
      if (el.querySelector?.(".gra-sidebar-nav, .gra-citation-panel, .gra-selection-toolbar")) {
        el = el.parentElement;
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width >= 200 && rect.height >= 150) {
        candidateEls.push(el);
      }
      el = el.parentElement;
    }

    const directChildren = Array.from(mainEl.children || []).filter(
      (c) => c instanceof HTMLElement && c.getBoundingClientRect().width >= 200
    );
    directChildren.forEach((c) => {
      if (!candidateEls.includes(c)) candidateEls.push(c);
    });

    const scored = candidateEls.map((c) => ({
      el: c,
      score: scoreConversationRootCandidate(c, mainEl)
    }));
    const mainScore = scoreConversationRootCandidate(mainEl, mainEl);

    let best = mainEl;
    let bestScore = mainScore;
    for (const { el: c, score: s } of scored) {
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }

    const candidatesForDebug = [
      { tag: mainEl.tagName, class: mainEl.className?.slice(0, 40), textLen: (mainEl.textContent || "").trim().length, score: mainScore }
    ].concat(
      scored.map(({ el: c, score: s }) => ({
        tag: c.tagName,
        class: c.className?.slice(0, 40),
        textLen: (c.textContent || "").trim().length,
        score: s
      }))
    );

    return { best, candidates: candidatesForDebug };
  }

  let lastRootCandidates = [];
  let lastRootChosenReason = "";
  let lastFirstMessageInfo = { found: false, tag: null, class: null, reason: null };

  /**
   * 多路徑找第一個 message-like 元素，避免 no-first-message。
   */
  function findFirstMessageLikeElement(root) {
    if (!root || !root.querySelector) return null;

    const exclude = (el) =>
      el?.closest?.("rich-textarea") || el?.closest?.(".gra-") || el?.closest?.("[role='toolbar']");

    const paths = [
      () => root.querySelector("[data-message-id]"),
      () => root.querySelector("[data-qa='message'], [data-qa='conversation-turn']"),
      () => root.querySelector("article"),
      () => root.querySelector("section[role='article']"),
      () => root.querySelector("[role='listitem'][data-author], [role='listitem'][data-message-author]"),
      () => {
        const withBlock = root.querySelectorAll("div, section, article");
        for (const el of withBlock) {
          if (exclude(el)) continue;
          const text = (el.textContent || "").trim();
          if (text.length < 30) continue;
          if (el.querySelector("p, pre, blockquote, ul, ol")) return el;
        }
        return null;
      },
      () => {
        const historyContainer =
          root.querySelector(".chat-history-scroll-container") ||
          root.querySelector("[class*='chat-history']") ||
          root.querySelector("[class*='scroll-container']");
        if (!historyContainer) return null;
        const inner = historyContainer.querySelector(
          "[data-message-id], [data-qa='message'], article, section[role='article'], [role='listitem']"
        );
        if (inner) return inner;
        const withBlock = historyContainer.querySelectorAll("div, section, article");
        for (const el of withBlock) {
          if (exclude(el)) continue;
          const text = (el.textContent || "").trim();
          if (text.length < 30) continue;
          if (el.querySelector("p, pre, blockquote, ul, ol")) return el;
        }
        return null;
      }
    ];

    const reasons = [
      "data-message-id",
      "data-qa",
      "article",
      "section-article",
      "role-listitem",
      "block-content",
      "history-container-descendant"
    ];

    for (let i = 0; i < paths.length; i++) {
      const el = paths[i]();
      if (el && !exclude(el)) {
        lastFirstMessageInfo = {
          found: true,
          tag: el.tagName,
          class: el.className?.slice?.(0, 60) || null,
          reason: reasons[i]
        };
        return el;
      }
    }

    lastFirstMessageInfo = { found: false, tag: null, class: null, reason: "none" };
    return null;
  }

  /**
   * 鎖定主對話內容根容器。
   * 策略：先找 scroll 容器，若只得 main 則用評分找更好的 descendant。
   */
  function findConversationRootContainer() {
    const main =
      document.querySelector("main[role='main']") ||
      document.querySelector("main") ||
      document.body;
    if (!main) return document.body;

    const firstMessage = findFirstMessageLikeElement(main);
    if (!firstMessage) {
      lastRootCandidates = [];
      lastRootChosenReason = "no-first-message";
      return main;
    }

    let el = firstMessage.parentElement;
    let scrollCandidate = null;
    while (el && el !== main) {
      try {
        if (el.querySelector?.(".gra-sidebar-nav, .gra-citation-panel, .gra-selection-toolbar")) {
          el = el.parentElement;
          continue;
        }
        const style = getComputedStyle(el);
        const overflowY = style.overflowY || style.overflow || "";
        if (/auto|scroll|overlay/.test(overflowY)) {
          const rect = el.getBoundingClientRect();
          if (rect.width >= 250 && rect.height >= 200) {
            scrollCandidate = el;
            break;
          }
        }
      } catch (_) {}
      el = el.parentElement;
    }

    if (scrollCandidate && scrollCandidate !== main) {
      lastRootCandidates = [{ tag: scrollCandidate.tagName, class: scrollCandidate.className?.slice(0, 40), score: "scroll" }];
      lastRootChosenReason = "scroll-container";
      return scrollCandidate;
    }

    const { best, candidates } = findBestConversationRootWithinMain(main);
    lastRootCandidates = candidates;
    lastRootChosenReason = best === main ? "fallback-main" : "scored-best";
    return best;
  }

  /**
   * 計算 heuristic 分數與類型（不依賴「有正文就 gemini」）。
   * 順序：先明確 user，再明確 gemini，其餘 unknown。
   */
  function computeMessageTypeHeuristic(node, allSiblings) {
    if (!node || !(node instanceof HTMLElement)) {
      return { type: "unknown", userScore: 0, geminiScore: 0, selectedReason: "invalid-node" };
    }

    const root = findConversationRootContainer();
    const rootRect = root.getBoundingClientRect();
    const rootWidth = rootRect.width || 1;
    const rootCenterX = rootRect.left + rootRect.width / 2;

    const heavyStructureSelector =
      "pre, code, table, blockquote, ul, ol, h1, h2, h3, h4, h5, h6";
    const hasHeavyStructure = !!node.querySelector(heavyStructureSelector);
    const hasPreOrTable = !!node.querySelector("pre, table");
    const codeBlocks = node.querySelectorAll("pre, code").length;
    const listItems = node.querySelectorAll("ul li, ol li").length;
    const paragraphCount = node.querySelectorAll("p").length;

    const textLen = (node.textContent || "").trim().length;
    const nodeRect = node.getBoundingClientRect();
    const nodeCenterX = nodeRect.left + nodeRect.width / 2;
    const widthRatio = nodeRect.width / rootWidth;
    const centerOffsetFromRoot = nodeCenterX - rootCenterX;

    const isNarrow = widthRatio < 0.58;
    const isCardLike = isNarrow && nodeRect.height < rootRect.height * 0.25;
    const isSimpleStructure = paragraphCount <= 2 && !hasPreOrTable && listItems < 3;

    let hasLargeNextSibling = false;
    let nextTextLen = 0;
    if (Array.isArray(allSiblings) && allSiblings.length > 0) {
      const idx = allSiblings.indexOf(node);
      if (idx >= 0 && idx < allSiblings.length - 1) {
        const next = allSiblings[idx + 1];
        if (next && next.getBoundingClientRect) {
          const nextRect = next.getBoundingClientRect();
          nextTextLen = (next.textContent || "").trim().length;
          if (nextRect.height > nodeRect.height * 1.4 || nextTextLen > Math.max(textLen * 1.8, 120)) {
            hasLargeNextSibling = true;
          }
        }
      }
    }

    let userScore = 0;
    let geminiScore = 0;

    if (textLen < 280 && !hasHeavyStructure) userScore += 2;
    else if (textLen < 450 && isSimpleStructure && !hasPreOrTable) userScore += 1;

    if (textLen < 450 && isNarrow) userScore += 1;
    if (isCardLike && textLen < 500) userScore += 1;
    if (hasLargeNextSibling && textLen < 400 && !hasHeavyStructure) userScore += 2;
    if (centerOffsetFromRoot < -15 && textLen < 420 && isNarrow) userScore += 1;

    if (hasPreOrTable) geminiScore += 3;
    if (codeBlocks >= 2 || (codeBlocks >= 1 && textLen > 200)) geminiScore += 1;
    if (listItems >= 3) geminiScore += 2;
    if (node.querySelector("blockquote") && textLen > 80) geminiScore += 2;
    if (paragraphCount >= 4 && textLen > 500) geminiScore += 1;
    if (textLen > 900 && widthRatio > 0.48 && !isNarrow) geminiScore += 2;
    else if (textLen > 700 && widthRatio > 0.52 && paragraphCount >= 3) geminiScore += 1;

    if (hasHeavyStructure && textLen > 200) geminiScore += 1;

    let type = "unknown";
    let selectedReason = "heuristic-tie";

    if (geminiScore >= 4) {
      type = "gemini";
      selectedReason = "strong-gemini-structure";
    } else if (userScore >= 3 && geminiScore < 3) {
      type = "user";
      selectedReason = "strong-user-signals";
    } else if (userScore >= 2 && geminiScore <= 1) {
      type = "user";
      selectedReason = "user-over-weak-gemini";
    } else if (userScore >= 2 && geminiScore === 2 && textLen < 360) {
      type = "user";
      selectedReason = "short-prompt-vs-mild-gemini";
    } else if (geminiScore >= 3 && userScore < 2) {
      type = "gemini";
      selectedReason = "gemini-dominant";
    } else if (geminiScore >= 2 && userScore === 0 && textLen > 550) {
      type = "gemini";
      selectedReason = "long-reply-no-user-signal";
    } else if (userScore >= 1 && geminiScore <= 1 && textLen < 320) {
      type = "user";
      selectedReason = "short-lean-user";
    } else if (userScore >= 1 && geminiScore === 0) {
      type = "user";
      selectedReason = "user-only-weak";
    } else {
      type = "unknown";
      selectedReason = "ambiguous-scores";
    }

    return { type, userScore, geminiScore, selectedReason };
  }

  function detectMessageTypeByHeuristic(node, allSiblings) {
    return computeMessageTypeHeuristic(node, allSiblings).type;
  }

  /**
   * 供 debug：含 DOM author 與 heuristic 分數。
   */
  function detectMessageTypeWithDetails(node, siblings) {
    if (!node || !(node instanceof HTMLElement)) {
      return { type: "unknown", userScore: 0, geminiScore: 0, selectedReason: "invalid" };
    }

    if (isUserQueryTagElement(node)) {
      return {
        type: "user",
        userScore: null,
        geminiScore: null,
        selectedReason: "tag:user-query"
      };
    }
    if (isHighTrustModelComponentTagElement(node)) {
      return {
        type: "gemini",
        userScore: null,
        geminiScore: null,
        selectedReason: "tag:model-component"
      };
    }

    const check = (el) => {
      const author =
        el.getAttribute("data-author") ||
        el.getAttribute("data-message-author") ||
        "";
      const lower = author.toLowerCase();
      if (["user", "human", "1"].some((v) => lower.includes(v))) return "user";
      if (["model", "assistant", "gemini", "2"].some((v) => lower.includes(v)))
        return "gemini";
      return null;
    };

    const root = findConversationRootContainer();
    let el = node;
    while (el && el !== root && el !== document.body) {
      const result = check(el);
      if (result) {
        return {
          type: result,
          userScore: null,
          geminiScore: null,
          selectedReason: `data-author:${result}`
        };
      }
      el = el.parentElement;
    }

    const h = computeMessageTypeHeuristic(node, siblings);
    return { type: h.type, userScore: h.userScore, geminiScore: h.geminiScore, selectedReason: h.selectedReason };
  }

  /**
   * 判定訊息類型：gemini | user | unknown。
   * 第一層：優先 data-author、data-message-author；無則第二層 heuristic fallback。
   * @param {HTMLElement} node
   * @param {HTMLElement[]} [siblings] - 同批 candidate blocks，供幾何 heuristic 判斷 user→gemini 相鄰結構
   */
  function detectMessageType(node, siblings) {
    return detectMessageTypeWithDetails(node, siblings).type;
  }

  /** Gemini 實際 DOM：自訂元素 user-query（大小寫不敏感）。 */
  function isUserQueryTagElement(el) {
    return !!(el && el.tagName && el.tagName.toUpperCase() === "USER-QUERY");
  }

  /**
   * 高可信模型回覆自訂標籤：MODEL-RESPONSE、MODEL-*、BOT-*、RESPONSE-*、GEMINI-*。
   */
  function isHighTrustModelComponentTagElement(el) {
    if (!el || !el.tagName) return false;
    const t = el.tagName.toUpperCase();
    if (t === "USER-QUERY") return false;
    if (t === "MODEL-RESPONSE") return true;
    if (t.startsWith("MODEL-")) return true;
    if (t.startsWith("BOT-")) return true;
    if (t.startsWith("RESPONSE-")) return true;
    if (t.startsWith("GEMINI-")) return true;
    return false;
  }

  /**
   * 掃描 root 內高可信 DOM 標記（優先於 heuristic / 外層 wrapper）。
   * @returns {Array<{ el: HTMLElement, sourceSignal: string }>}
   */
  function collectHighTrustDomTaggedNodes(root) {
    const out = [];
    const seen = new Set();
    const add = (el, sourceSignal) => {
      if (!el || !(el instanceof HTMLElement) || !root.contains(el)) return;
      if (seen.has(el)) return;
      seen.add(el);
      out.push({ el, sourceSignal });
    };

    try {
      root.querySelectorAll("user-query").forEach((el) => add(el, "user-query-tag"));
    } catch (_) {}

    const modelSelectors = [
      "model-response",
      "model-output",
      "bot-response",
      "response-container",
      "assistant-message",
      "model-message"
    ];
    modelSelectors.forEach((sel) => {
      try {
        root.querySelectorAll(sel).forEach((el) => add(el, "model-component-tag"));
      } catch (_) {}
    });

    let scanned = 0;
    const maxScan = 25000;
    try {
      const all = root.querySelectorAll("*");
      for (let i = 0; i < all.length && scanned < maxScan; i++) {
        scanned += 1;
        const el = all[i];
        if (isHighTrustModelComponentTagElement(el)) add(el, "model-component-tag");
      }
    } catch (_) {}

    return out;
  }

  /** 若 A 包含 B，只保留較內層（原子）節點。 */
  function keepDeepestExclusiveInSet(elements) {
    const arr = [...new Set(elements)].filter(Boolean);
    return arr.filter((n) => !arr.some((other) => other !== n && other.contains(n)));
  }

  /**
   * 合併 selector 結果與高可信標籤：壓掉包住 USER-QUERY / model 元件的外層候選。
   */
  function mergeHighTrustDomTagsIntoCandidates(root, mergedFromSelectors) {
    const tagged = collectHighTrustDomTaggedNodes(root);
    const atoms = keepDeepestExclusiveInSet(tagged.map((t) => t.el));

    atoms.forEach((el) => {
      const hit = tagged.find((x) => x.el === el);
      const sourceSignal = hit?.sourceSignal || (isUserQueryTagElement(el) ? "user-query-tag" : "model-component-tag");
      sidebarNodeKeptMeta.set(el, {
        sourceSignal,
        ancestorSuppressed: true,
        keptReason: "high-trust-dom-tag"
      });
    });

    const documentOrder = (a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    };

    let merged = mergedFromSelectors.filter((c) => {
      const innerAtoms = atoms.filter((at) => c !== at && c.contains(at));
      if (innerAtoms.length === 0) return true;
      if (lastUserPromptLeakDebug) {
        const uqOrUserLike = innerAtoms.find(
          (at) => isUserQueryTagElement(at) || isPotentialUserLikeCandidate(at, root)
        );
        const by = uqOrUserLike || innerAtoms[0];
        lastUserPromptLeakDebug.suppressedChains.push({
          reason: "merge-high-trust-ancestor-removed",
          suppressedSelfPreview: previewElText(c, 100),
          suppressedByPreview: previewElText(by, 100),
          suppressedTag: c.tagName,
          keptAtomTag: by.tagName
        });
      }
      return false;
    });
    merged = [...new Set([...atoms, ...merged])].sort(documentOrder);
    return { merged, highTrustAtomCount: atoms.length };
  }

  function getDepthFromConversationRoot(node, root) {
    let d = 0;
    let p = node;
    while (p && p !== root && p !== document.body) {
      d += 1;
      p = p.parentElement;
    }
    return d;
  }

  function inferSourceSignalForKeptPreview(node, selectedReason) {
    const meta = sidebarNodeKeptMeta.get(node);
    if (meta && meta.sourceSignal) return meta.sourceSignal;
    if (isUserQueryTagElement(node)) return "user-query-tag";
    if (isHighTrustModelComponentTagElement(node)) return "model-component-tag";
    if (node.getAttribute("data-author") || node.getAttribute("data-message-author"))
      return "data-author";
    if (node.getAttribute("data-qa")) return "data-qa";
    const sr = String(selectedReason || "");
    if (sr.startsWith("data-author:")) return "data-author";
    if (sr.startsWith("tag:user-query")) return "user-query-tag";
    if (sr.startsWith("tag:model-component")) return "model-component-tag";
    if (sr.includes("data-qa")) return "data-qa";
    return "fallback-heuristic";
  }

  /**
   * 從目標 block 建立 tooltip 內容：{ summary, typeLabel }。
   */
  function buildTooltipContent(targetEl, messageType) {
    const raw = (targetEl?.textContent || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 40);
    const summary = raw || "無摘要";
    const typeLabel =
      { gemini: "Gemini", user: "使用者", unknown: "未知" }[messageType] ||
      "未知";
    return { summary, typeLabel };
  }

  /**
   * 確保 tooltip DOM 存在。
   */
  function ensureTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement("div");
    tooltipEl.className = "gra-sidebar-nav__tooltip";
    tooltipEl.setAttribute("role", "tooltip");
    tooltipEl.style.display = "none";
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  /**
   * 顯示 tooltip。
   */
  function showTooltipForItem(navEl, data) {
    ensureTooltip();
    tooltipEl.textContent = "";
    const summary = document.createElement("div");
    summary.className = "gra-sidebar-nav__tooltip-summary";
    summary.textContent = data.summary;
    const typeLabel = document.createElement("div");
    typeLabel.className = "gra-sidebar-nav__tooltip-type";
    typeLabel.textContent = data.typeLabel;
    tooltipEl.appendChild(summary);
    tooltipEl.appendChild(typeLabel);
    tooltipEl.style.display = "block";

    requestAnimationFrame(() => {
      if (!tooltipEl || tooltipEl.style.display !== "block") return;
      const navRect = navEl.getBoundingClientRect();
      const tooltipRect = tooltipEl.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      let left = navRect.left + navRect.width / 2 - tooltipRect.width / 2;
      if (left < 8) left = 8;
      if (left + tooltipRect.width > viewportWidth - 8)
        left = viewportWidth - tooltipRect.width - 8;
      tooltipEl.style.left = `${left}px`;
      tooltipEl.style.top = `${navRect.top - tooltipRect.height - 6}px`;
    });
  }

  /**
   * 隱藏 tooltip。
   */
  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = "none";
  }

  /** 捲動到訊息開頭時，與視窗頂／固定列保留的間距（scroll-margin）。 */
  const SIDEBAR_SCROLL_TOP_PADDING_PX = 56;

  /**
   * 訊息內用於捲動定位的節點是否在「工具列／操作區」語境（應略過，改找正文）。
   */
  function isScrollAnchorExcludedContext(el, messageRoot) {
    if (!el || !(el instanceof HTMLElement) || !messageRoot || !messageRoot.contains(el))
      return true;
    if (el.closest(".gra-sidebar-nav, .gra-citation-panel, .gra-selection-toolbar"))
      return true;
    if (el.matches("button,input,select,textarea,[role='button']")) return true;

    let cur = el;
    for (let depth = 0; cur && cur !== messageRoot && depth < 28; depth++) {
      if (!(cur instanceof HTMLElement)) break;
      const role = (cur.getAttribute("role") || "").toLowerCase();
      if (role === "toolbar" || role === "menubar" || role === "banner") return true;
      const tag = cur.tagName;
      if (tag === "BUTTON" || tag === "FOOTER") return true;
      const cls =
        typeof cur.className === "string"
          ? cur.className.toLowerCase()
          : String(cur.className?.baseVal ?? "").toLowerCase();
      if (
        cls.includes("toolbar") ||
        cls.includes("action-bar") ||
        cls.includes("action-row") ||
        cls.includes("source-control") ||
        cls.includes("source-controls") ||
        cls.includes("citation-bar") ||
        cls.includes("message-actions") ||
        cls.includes("quick-actions")
      ) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function isLikelyVisibleForScrollAnchor(el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return false;
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      if (parseFloat(s.opacity || "1") === 0) return false;
      return true;
    } catch (_) {
      return true;
    }
  }

  function hasMeaningfulAnchorText(el) {
    const t = (el.textContent || "").replace(/\u00a0/g, " ").trim();
    return t.length > 0;
  }

  /**
   * 在訊息 block 內找「開頭可讀內容」錨點，供捲動對齊頂部；找不到則退回 message 根節點。
   * @returns {{ anchor: HTMLElement, usedFallback: boolean }}
   */
  function findScrollAnchorWithinMessage(messageRoot) {
    if (!messageRoot || !(messageRoot instanceof HTMLElement)) {
      return { anchor: messageRoot, usedFallback: true };
    }

    const primarySelector =
      "p, h1, h2, h3, h4, h5, h6, pre, blockquote, li, [role='paragraph'], [role='heading'], rich-text p, rich-text [role='paragraph']";

    let candidates;
    try {
      candidates = messageRoot.querySelectorAll(primarySelector);
    } catch (_) {
      candidates = [];
    }

    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (!messageRoot.contains(el) || el === messageRoot) continue;
      if (isScrollAnchorExcludedContext(el, messageRoot)) continue;
      if (!isLikelyVisibleForScrollAnchor(el)) continue;
      if (!hasMeaningfulAnchorText(el)) continue;
      return { anchor: el, usedFallback: false };
    }

    return { anchor: messageRoot, usedFallback: true };
  }

  /**
   * Sidebar 點擊：對應同一 message node，但捲動對齊內部開頭錨點（Gemini / 使用者共用）。
   */
  function scrollSidebarTargetIntoView(messageNode, clickedMessageType) {
    if (!messageNode || !(messageNode instanceof HTMLElement)) return;
    const { anchor, usedFallback } = findScrollAnchorWithinMessage(messageNode);
    const targetEl = anchor;
    if (!targetEl) return;
    const prevMargin = targetEl.style.scrollMarginTop;
    targetEl.style.scrollMarginTop = `${SIDEBAR_SCROLL_TOP_PADDING_PX}px`;
    try {
      targetEl.scrollIntoView({
        behavior: "smooth",
        block: "start",
        inline: "nearest"
      });
    } catch (_) {
      try {
        targetEl.scrollIntoView();
      } catch (__) {}
    }
    window.setTimeout(() => {
      try {
        targetEl.style.scrollMarginTop = prevMargin;
      } catch (_) {}
    }, 1200);

    if (GRA_DEBUG_SIDEBAR_SCROLL) {
      const cn = targetEl.className;
      GRA_DEBUG && console.info("[GRA][sidebar][scroll-debug]", {
        clickedMessageType,
        targetTag: messageNode.tagName,
        anchorTag: targetEl.tagName,
        anchorClass:
          typeof cn === "string" ? cn.slice(0, 80) : String(cn || "").slice(0, 80),
        usedFallbackNode: usedFallback
      });
    }
  }

  /**
   * Phase 1 規格名稱：委派至既有 scrollSidebarTargetIntoView，行為不變。
   */
  function scrollToMessageTop(messageNode, messageType) {
    scrollSidebarTargetIntoView(messageNode, messageType);
  }

  /**
   * 避免重複建立容器。
   * 容器內部結構：
   * <div class="gra-sidebar-nav gra-sidebar-nav--collapsed">
   *   <button class="gra-sidebar-nav__handle">≡</button>
   *   <div class="gra-sidebar-nav__body">
   *     <div class="gra-sidebar-nav__list"></div>
   *   </div>
   * </div>
   */
  function ensureContainer() {
    if (container && listEl) return { container, listEl };

    if (!container) {
      container = document.createElement("div");
      container.className = "gra-sidebar-nav gra-sidebar-nav--collapsed";
      document.body.appendChild(container);

      handleEl = document.createElement("button");
      handleEl.type = "button";
      handleEl.className = "gra-sidebar-nav__handle";
      handleEl.textContent = "≡";
      handleEl.setAttribute("aria-label", "展開/收合導航");
      handleEl.addEventListener("click", handleHandleClick);

      container.addEventListener("mouseenter", handleMouseEnter);
      container.addEventListener("mouseleave", handleMouseLeave);

      bodyEl = document.createElement("div");
      bodyEl.className = "gra-sidebar-nav__body";

      toolbarEl = document.createElement("div");
      toolbarEl.className = "gra-sidebar-nav__toolbar";

      const filterEl = document.createElement("div");
      filterEl.className = "gra-sidebar-nav__filter";

      ["all", "gemini", "user"].forEach((filter) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "gra-sidebar-nav__filter-btn";
        btn.dataset.filter = filter;
        btn.textContent =
          filter === "all" ? "全部" : filter === "gemini" ? "Gemini" : "使用者";
        btn.addEventListener("click", () => {
          currentFilter = filter;
          filterEl
            .querySelectorAll(".gra-sidebar-nav__filter-btn")
            .forEach((b) => b.classList.remove("gra-sidebar-nav__filter-btn--active"));
          btn.classList.add("gra-sidebar-nav__filter-btn--active");
          applyFilter();
        });
        filterEl.appendChild(btn);
      });
      filterEl
        .querySelector('[data-filter="all"]')
        .classList.add("gra-sidebar-nav__filter-btn--active");

      // 🔍 搜尋按鈕
      const searchBtn = document.createElement("button");
      searchBtn.type = "button";
      searchBtn.className = "gra-sidebar-nav__search-btn";
      searchBtn.textContent = "🔍";
      searchBtn.title = "全文搜尋 messageStore (Ctrl+Shift+S)";
      searchBtn.addEventListener("click", function () {
        handleSearch("");
      });

      toolbarEl.appendChild(filterEl);
      toolbarEl.appendChild(searchBtn);
      bodyEl.appendChild(toolbarEl);

      container.appendChild(handleEl);
      container.appendChild(bodyEl);
      GRA_DEBUG && console.info("[GRA][sidebar] Sidebar container created.");
    }

    if (!listEl) {
      listEl = document.createElement("div");
      listEl.className = "gra-sidebar-nav__list";
      bodyEl.appendChild(listEl);
    }

    ensureUsageMeter();
    ensureRecallButton();

    return { container, listEl };
  }

  /**
   * 依 currentFilter 顯示/隱藏節點。
   * Tab 內部值（與 button dataset.filter 一致）："all" | "gemini" | "user"
   * 過濾欄位：item.messageType（與 rebuildNavigation 時 detectMessageType 結果相同）
   */
  function applyFilter() {
    items.forEach((item) => {
      const match =
        currentFilter === "all" ||
        (currentFilter === "gemini" && item.messageType === "gemini") ||
        (currentFilter === "user" && item.messageType === "user");
      const shell = item.rowEl || item.navEl;
      if (shell) shell.style.display = match ? "" : "none";
    });

    const renderedTypes = { gemini: 0, user: 0, unknown: 0 };
    let renderedCount = 0;
    items.forEach((item) => {
      const shell = item.rowEl || item.navEl;
      if (!shell || shell.style.display === "none") return;
      renderedCount += 1;
      const t = item.messageType;
      if (t === "gemini" || t === "user" || t === "unknown") {
        renderedTypes[t] += 1;
      } else {
        renderedTypes.unknown += 1;
      }
    });

    GRA_DEBUG && console.info("[GRA][sidebar][render]", {
      activeFilter: currentFilter,
      renderedCount,
      renderedTypes,
      totalItems: items.length
    });

    updateActiveItem();
  }

  /**
   * 正規化文字供比對用。
   */
  function normalizeTextForCompare(text) {
    return (text || "").trim().replace(/\s+/g, " ").slice(0, 200);
  }

  /**
   * 是否為聊天歷史容器（chat-history-scroll-container 等），非一般 control-heavy。
   */
  function isHistoryWrapperContainer(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    const cn = (el.className || "").toLowerCase();
    const hasHistoryClass = cn.includes("chat-history") || cn.includes("history-container");
    const hasScrollContainer = cn.includes("scroll-container");
    const textLen = (el.textContent || "").trim().length;
    const blockCount = el.querySelectorAll?.("p, pre, blockquote, ul, ol, article, [role='listitem']")?.length || 0;
    const messageLike = el.querySelectorAll?.("[data-message-id], [data-qa='message'], article")?.length || 0;
    if ((hasHistoryClass || hasScrollContainer) && (textLen >= 100 || blockCount >= 2 || messageLike >= 1)) {
      return true;
    }
    if (hasHistoryClass && textLen >= 50) return true;
    return false;
  }

  /**
   * 從 history wrapper 內提取 message-like 子節點。
   */
  function extractMessageLikeDescendantsFromHistoryWrapper(el, root) {
    if (!el || !(el instanceof HTMLElement)) return [];
    const selectors =
      "user-query, model-response, model-output, bot-response, [data-message-id], [data-qa='message'], [data-qa='conversation-turn'], [role='listitem'][data-author], article, section[role='article']";
    const found = Array.from(el.querySelectorAll(selectors));
    const withBlock = Array.from(el.querySelectorAll("div, section, article")).filter((desc) => {
      if (desc.closest("rich-textarea") || desc.closest(".gra-")) return false;
      const text = (desc.textContent || "").trim();
      if (text.length < 20) return false;
      return !!desc.querySelector("p, pre, blockquote, ul, ol, h1, h2, h3, h4, h5, h6");
    });
    const merged = [...found];
    withBlock.forEach((d) => {
      if (!merged.some((m) => m === d || m.contains(d) || d.contains(m))) merged.push(d);
    });
    const documentOrder = (a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    };
    merged.sort(documentOrder);
    return merged.filter((n) => n !== el && el.contains(n));
  }

  /**
   * 是否為 control-heavy block（button row / toolbar / menu / 純 icon 區塊）。
   * history wrapper 不算 control-heavy。
   */
  function isControlHeavyBlock(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (isHistoryWrapperContainer(el)) return false;
    const buttons = el.querySelectorAll("button, [role='button'], [role='menu'], [role='toolbar']");
    const svgs = el.querySelectorAll("svg");
    const textLen = (el.textContent || "").trim().replace(/\s+/g, " ").length;
    const controlCount = buttons.length + Math.min(svgs.length, 5);
    if (controlCount >= 2 && textLen < 30) return true;
    if (controlCount >= 3 && textLen < 80) return true;
    if (el.closest("[role='toolbar']") || el.closest("[role='menu']")) return true;
    const tag = el.tagName?.toLowerCase();
    if (tag === "button" || (tag === "div" && el.querySelector("button:only-child"))) return true;
    return false;
  }

  /**
   * 是否靠近 composer / input 區域。
   */
  function isNearComposerRegion(el, root) {
    if (!el || !root) return false;
    const composer =
      root.querySelector("rich-textarea, [contenteditable='true'], textarea, [role='textbox']") ||
      document.querySelector("rich-textarea");
    if (!composer) return false;
    const composerRect = composer.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const distFromComposer = Math.abs(elRect.bottom - composerRect.top);
    if (distFromComposer < 150) return true;
    const inBottomZone = elRect.top > rootRect.bottom - 200;
    if (inBottomZone && elRect.height < 80) return true;
    return false;
  }

  /**
   * 從 wrapper 內提取更像單一訊息的子容器。
   */
  function extractMessageLikeDescendantsFromWrapper(wrapper, root) {
    if (!wrapper || !(wrapper instanceof HTMLElement)) return [];
    const selectors =
      "user-query, model-response, model-output, bot-response, [data-message-id], [data-qa='message'], [data-qa='conversation-turn'], [role='listitem'][data-author], article, section[role='article']";
    const found = Array.from(wrapper.querySelectorAll(selectors));
    const withBlock = Array.from(wrapper.querySelectorAll("div")).filter((el) => {
      if (el.closest("rich-textarea") || el.closest(".gra-")) return false;
      const text = (el.textContent || "").trim();
      if (text.length < 30) return false;
      return !!el.querySelector("p, pre, blockquote, ul, ol, h1, h2, h3, h4, h5, h6");
    });
    const merged = [...found];
    withBlock.forEach((el) => {
      if (!merged.some((m) => m.contains(el) || el.contains(m))) merged.push(el);
    });
    const documentOrder = (a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    };
    merged.sort(documentOrder);
    return merged.filter((el) => el !== wrapper && wrapper.contains(el));
  }

  /**
   * 兩 block 文本是否高度重複。
   */
  function areBlocksTextuallyRedundant(a, b) {
    const ta = normalizeTextForCompare(a?.textContent || "");
    const tb = normalizeTextForCompare(b?.textContent || "");
    if (!ta || !tb) return false;
    if (ta === tb) return true;
    const minLen = Math.min(ta.length, tb.length);
    if (minLen < 20) return false;
    const overlap = ta.slice(0, 60) === tb.slice(0, 60) || ta.slice(-40) === tb.slice(-40);
    if (overlap && Math.abs(ta.length - tb.length) < 30) return true;
    return false;
  }

  /**
   * 判斷父層是否為完整 message container，子層是否只是內容片段。
   */
  function shouldPreferChildOverParent(parent, child) {
    const pText = (parent.textContent || "").trim().replace(/\s+/g, " ");
    const cText = (child.textContent || "").trim().replace(/\s+/g, " ");
    if (!cText || cText.length < 15) return false;
    const ratio = cText.length / (pText.length || 1);
    if (ratio > 0.85 && Math.abs(pText.length - cText.length) < 50) return true;
    const childTags = child.querySelectorAll("p, pre, blockquote, ul, ol, h1, h2, h3, h4, h5, h6");
    const parentHasMultipleBlocks = parent.querySelectorAll("article, section, [role='listitem']").length > 1;
    if (parentHasMultipleBlocks && childTags.length <= 2) return true;
    return false;
  }

  /**
   * prune 前看似 user prompt 的候選（短、窄、結構簡），用於 debug。
   */
  function isPotentialUserLikeCandidate(el, root) {
    if (!el || !(el instanceof HTMLElement)) return false;
    const textLen = (el.textContent || "").trim().length;
    if (textLen > 500 || textLen < 15) return false;
    if (el.querySelector("pre, table, blockquote")) return false;
    const rootRect = root?.getBoundingClientRect?.() || { width: 1 };
    const elRect = el.getBoundingClientRect();
    const widthRatio = elRect.width / (rootRect.width || 1);
    if (widthRatio < 0.62 || textLen < 350) return true;
    if (textLen < 200 && el.querySelectorAll("p").length <= 2) return true;
    return false;
  }

  /**
   * 舊版 generic prune 的 too-short 條件（含誤殺純中文的 /^[\s\W]*$/），僅供 debug「若未放寬會否排除」。
   */
  function wouldHitLegacyGenericTooShort(el, text, textLen) {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (isUserQueryTagElement(el) || isHighTrustModelComponentTagElement(el)) return false;
    if (textLen < 15) return true;
    if (/^[\s\W]*$/.test(text)) return true;
    if (textLen < 20 && !el.querySelector("p, pre, blockquote")) return true;
    return false;
  }

  /**
   * 高可信 user：略過過嚴的 too-short（仍排除全空白／無可見字元）。
   * - tag USER-QUERY
   * - turn 拆出後 meta sourceSignal === user-query-tag
   * - 本節點 data-author / data-message-author 明確 user
   * - summarizeInspectNode 判定 user-only（likelyUser 有、likelyGemini 無）
   * - isPotentialUserLikeCandidate（與 prunedUserLikeCandidates 同套「看似 user prompt」heuristic）
   */
  function isHighTrustUserForTooShortSkip(el, root) {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (isUserQueryTagElement(el)) return true;
    if (isExplicitUserRoleOnElement(el)) return true;
    const meta = sidebarNodeKeptMeta.get(el);
    if (meta && meta.sourceSignal === "user-query-tag") return true;
    try {
      const summary = summarizeInspectNode(el, 0);
      if (summary.hints.likelyUser.length > 0 && summary.hints.likelyGemini.length === 0) return true;
    } catch (_) {}
    return isPotentialUserLikeCandidate(el, root);
  }

  /**
   * 最終 kept 中，若無放寬會被舊 too-short 排除的高可信 user 筆數（含 USER-QUERY 純 CJK 舊誤殺）。
   */
  function computeRecoveredUserCountFromTooShort(kept, root) {
    if (!Array.isArray(kept) || !root) return 0;
    let n = 0;
    for (let i = 0; i < kept.length; i++) {
      const el = kept[i];
      if (!isHighTrustUserForTooShortSkip(el, root)) continue;
      const text = (el.textContent || "").trim().replace(/\s+/g, " ");
      const textLen = text.length;
      if (isUserQueryTagElement(el)) {
        if (textLen < 1) continue;
        if (/\S/.test(text) && /^[\s\W]*$/.test(text)) n += 1;
      } else if (!isHighTrustModelComponentTagElement(el) && wouldHitLegacyGenericTooShort(el, text, textLen)) {
        n += 1;
      }
    }
    return n;
  }

  /**
   * turn wrapper 內「可讀內容區塊」數量（粗略）：足夠長的 p/li/pre 或訊息節點。
   */
  function countReadableContentBlocksInTurn(el) {
    if (!el || !(el instanceof HTMLElement)) return 0;
    const blocks = el.querySelectorAll(
      "p, li, pre, article, [data-message-id], [data-qa='message'], [data-qa='conversation-turn']"
    );
    let n = 0;
    blocks.forEach((b) => {
      try {
        if ((b.textContent || "").trim().length >= 22) n += 1;
      } catch (_) {}
    });
    return Math.min(n, 40);
  }

  /**
   * 同一 DOM 區塊內是否同時出現「使用者側」與「模型側」常見文案或 author 訊號。
   */
  function containsUserAndGeminiMixedText(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    const text = (el.textContent || "").trim();
    if (text.length < 200) return false;

    const userPatterns = [
      /你說了/,
      /你(剛才|剛剛)?說/,
      /你的(訊息|問題|提問|留言|內容)/,
      /You said/i,
      /Your (message|prompt|question)/i
    ];
    const modelPatterns = [
      /點子發想/,
      /\bGemini\b/,
      /^(細節|摘要|重點|結論)/m,
      /Here's (what|how|a )/i,
      /I'?m (happy|glad|pleased)/i
    ];

    const hasUserPhrase = userPatterns.some((re) => re.test(text));
    const hasModelPhrase = modelPatterns.some((re) => re.test(text));

    let hasUserAuth = false;
    let hasModelAuth = false;
    try {
      el.querySelectorAll("[data-author], [data-message-author]").forEach((n) => {
        const a = (
          n.getAttribute("data-author") ||
          n.getAttribute("data-message-author") ||
          ""
        ).toLowerCase();
        if (/(^|[^a-z])(user|human|1)([^a-z]|$)/i.test(a)) hasUserAuth = true;
        if (/(model|assistant|gemini|2)/i.test(a)) hasModelAuth = true;
      });
    } catch (_) {}

    if (hasUserAuth && hasModelAuth) return true;
    return hasUserPhrase && hasModelPhrase;
  }

  /**
   * 是否為「整輪對話」外層容器（同時含 user + model 文本、偏長、內部多區塊）。
   */
  function isConversationTurnWrapper(el, root) {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (isHistoryWrapperContainer(el)) return false;
    try {
      if (el.closest("rich-textarea") || el.closest(".gra-")) return false;
    } catch (_) {}

    const textLen = (el.textContent || "").trim().length;
    if (textLen < 480) return false;

    const mixed = containsUserAndGeminiMixedText(el);
    const innerMsg = el.querySelectorAll(
      "[data-message-id], [data-qa='message'], [data-qa='conversation-turn']"
    ).length;
    const regions = countReadableContentBlocksInTurn(el);
    const tag = el.tagName.toUpperCase();
    const broadShell = tag === "DIV" || tag === "SECTION" || tag === "ARTICLE";
    const multiChild = el.children.length >= 2;

    let signals = 0;
    if (textLen > 800) signals += 1;
    if (textLen > 1200) signals += 1;
    if (mixed) signals += 2;
    if (innerMsg >= 2) signals += 2;
    if (regions >= 4) signals += 1;
    if (broadShell && multiChild) signals += 1;

    return signals >= 4 && (mixed || innerMsg >= 2 || regions >= 4);
  }

  /**
   * 若集合內 A 包含 B，則丟棄外層 A，保留較內層、較原子的節點。
   */
  function keepMostSpecificMessageNodes(nodes) {
    const arr = nodes.filter((n) => n && n instanceof HTMLElement);
    return arr.filter(
      (n) => !arr.some((other) => other !== n && n.contains(other))
    );
  }

  /**
   * 從 turn wrapper 內抽出原子訊息節點（不重複保留 wrapper 本身）。
   */
  function extractAtomicMessageUnitsFromTurnWrapper(wrapper, root) {
    if (!wrapper || !(wrapper instanceof HTMLElement) || !root) return [];

    const documentOrder = (a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    };

    const fromDomTags = [];
    try {
      wrapper.querySelectorAll("user-query").forEach((n) => fromDomTags.push(n));
      wrapper
        .querySelectorAll(
          "model-response, model-output, bot-response, response-container, assistant-message, model-message"
        )
        .forEach((n) => {
          if (isHighTrustModelComponentTagElement(n)) fromDomTags.push(n);
        });
    } catch (_) {}

    let units = [...fromDomTags, ...extractMessageLikeDescendantsFromWrapper(wrapper, root)];
    units = [...new Set(units)];
    units = keepMostSpecificMessageNodes(units);
    units.sort(documentOrder);

    if (units.length >= 2) {
      return units;
    }

    const directKids = Array.from(wrapper.children).filter((child) => {
      if (!(child instanceof HTMLElement)) return false;
      try {
        if (child.closest("rich-textarea") || child.closest(".gra-")) return false;
      } catch (_) {}
      if (isControlHeavyBlock(child)) return false;
      const tl = (child.textContent || "").trim().length;
      if (tl < 35) return false;
      const hasBlocks =
        !!child.querySelector(
          "p, pre, ul, ol, blockquote, article, [data-message-id], [data-qa='message']"
        ) || tl > 100;
      return hasBlocks;
    });

    let kids = keepMostSpecificMessageNodes(directKids);
    kids.sort(documentOrder);

    if (kids.length >= 2) {
      return kids;
    }

    if (units.length === 1) return units;
    if (kids.length === 1) return kids;

    return [];
  }

  /**
   * 合併 selector 結果後、prune 前：先拆 turn wrapper，原子訊息優先於大外層。
   */
  function expandTurnWrappersInCandidateList(candidates, root) {
    const documentOrder = (a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    };

    const sorted = [...candidates].filter(Boolean).sort(documentOrder);
    const out = [];
    const seen = new Set();

    const recordSplitMeta = (units) => {
      const n = units.length;
      units.forEach((u) => {
        const base = {
          keptReason: "turn-wrapper-split",
          atomicChildCount: n,
          fromTurnWrapper: true
        };
        if (isUserQueryTagElement(u)) {
          sidebarNodeKeptMeta.set(u, {
            ...base,
            sourceSignal: "user-query-tag",
            ancestorSuppressed: true
          });
        } else if (isHighTrustModelComponentTagElement(u)) {
          sidebarNodeKeptMeta.set(u, {
            ...base,
            sourceSignal: "model-component-tag",
            ancestorSuppressed: true
          });
        } else {
          sidebarNodeKeptMeta.set(u, base);
        }
      });
    };

    for (const el of sorted) {
      if (!(el instanceof HTMLElement) || seen.has(el)) continue;

      if (isUserQueryTagElement(el) || isHighTrustModelComponentTagElement(el)) {
        seen.add(el);
        out.push(el);
        if (!sidebarNodeKeptMeta.has(el)) {
          sidebarNodeKeptMeta.set(el, {
            sourceSignal: isUserQueryTagElement(el) ? "user-query-tag" : "model-component-tag",
            ancestorSuppressed: true,
            keptReason: "high-trust-dom-tag"
          });
        }
        continue;
      }

      if (isHistoryWrapperContainer(el)) {
        seen.add(el);
        out.push(el);
        continue;
      }

      if (isConversationTurnWrapper(el, root)) {
        lastTurnWrapperStats.turnWrappersDetected += 1;
        const units = extractAtomicMessageUnitsFromTurnWrapper(el, root);

        if (units.length >= 2) {
          lastTurnWrapperStats.turnWrappersExtracted += 1;
          lastTurnWrapperStats.atomicUnitsExtractedCount += units.length;
          recordSplitMeta(units);
          for (const u of units) {
            if (u && !seen.has(u)) {
              seen.add(u);
              out.push(u);
            }
          }
          continue;
        }

        if (units.length === 1 && units[0] !== el) {
          lastTurnWrapperStats.turnWrappersExtracted += 1;
          lastTurnWrapperStats.atomicUnitsExtractedCount += 1;
          const u = units[0];
          sidebarNodeKeptMeta.set(u, {
            keptReason: "turn-wrapper-single-unit",
            atomicChildCount: 1,
            fromTurnWrapper: true
          });
          if (!seen.has(u)) {
            seen.add(u);
            out.push(u);
          }
          continue;
        }

        sidebarNodeKeptMeta.set(el, {
          keptReason: "turn-wrapper-fallback-unsplit",
          atomicChildCount: 0,
          fromTurnWrapper: true
        });
        seen.add(el);
        out.push(el);
        continue;
      }

      seen.add(el);
      out.push(el);
    }

    const unique = [...new Set(out)];
    unique.sort(documentOrder);
    return unique;
  }

  /**
   * 統一 prune：排除不適合的 candidate，只保留更像單一對話訊息的 block。
   * @returns {{ kept: HTMLElement[], excluded: Array<{ el: HTMLElement, reason: string }>, prunedUserLikeCandidates: Array, tooShortSkippedForHighTrustUserCount: number }}
   */
  function pruneMessageElementCandidates(candidates, root) {
    const excluded = [];
    const extractedFromWrappers = [];
    const prunedUserLikeCandidates = [];
    let tooShortSkippedForHighTrustUserCount = 0;

    const addExcluded = (el, reason) => {
      excluded.push({ el, reason });
      if (isPotentialUserLikeCandidate(el, root)) {
        prunedUserLikeCandidates.push({
          tag: el.tagName,
          class: el.className?.slice(0, 60) || "",
          textLen: (el.textContent || "").trim().length,
          excludedReason: reason,
          textPreview: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80)
        });
      }
      if (lastUserPromptLeakDebug && isUserLikeForLeakTracking(el, root)) {
        const tl = (el.textContent || "").trim().length;
        lastUserPromptLeakDebug.userLikeNotKept.push({
          tag: el.tagName,
          class:
            typeof el.className === "string"
              ? el.className.slice(0, 100)
              : String(el.className || "").slice(0, 60),
          textPreview: previewElText(el, 100),
          textLen: tl,
          excludedReason: reason,
          nearComposer: isNearComposerRegion(el, root),
          tooShort: tl < 15,
          ancestorSuppressed: sidebarNodeKeptMeta.get(el)?.ancestorSuppressed === true
        });
      }
    };

    let kept = candidates.filter((el) => {
      if (!el || !(el instanceof HTMLElement)) return false;

      const text = (el.textContent || "").trim().replace(/\s+/g, " ");
      const textLen = text.length;

      const isUq = isUserQueryTagElement(el);
      const isMc = isHighTrustModelComponentTagElement(el);
      const explicitUser = isExplicitUserRoleOnElement(el);

      if (isUq) {
        if (textLen < 1) {
          addExcluded(el, "too-short");
          return false;
        }
        // 舊版 /^[\s\W]*$/ 會把純 CJK 當成「無語意」；改為僅排除無可見字元（全空白等）
        if (!/\S/.test(text)) {
          addExcluded(el, "too-short");
          return false;
        }
        if (textLen >= 1 && /\S/.test(text) && /^[\s\W]*$/.test(text)) {
          tooShortSkippedForHighTrustUserCount += 1;
        }
        if (isHistoryWrapperContainer(el)) {
          const extracted = extractMessageLikeDescendantsFromHistoryWrapper(el, root);
          if (extracted.length > 0) {
            extractedFromWrappers.push(...extracted);
            addExcluded(el, "history-wrapper-extracted");
            return false;
          }
          addExcluded(el, "history-wrapper-empty");
          return false;
        }
        return true;
      }

      if (isMc) {
        if (textLen < 8 || /^[\s\W]*$/.test(text)) {
          addExcluded(el, "too-short");
          return false;
        }
        if (isHistoryWrapperContainer(el)) {
          const extracted = extractMessageLikeDescendantsFromHistoryWrapper(el, root);
          if (extracted.length > 0) {
            extractedFromWrappers.push(...extracted);
            addExcluded(el, "history-wrapper-extracted");
            return false;
          }
          addExcluded(el, "history-wrapper-empty");
          return false;
        }
        if (isControlHeavyBlock(el)) {
          addExcluded(el, "control-heavy");
          return false;
        }
        return true;
      }

      const htUserSkip = isHighTrustUserForTooShortSkip(el, root);
      if (htUserSkip) {
        if (!/\S/.test(text)) {
          addExcluded(el, "too-short");
          return false;
        }
        if (wouldHitLegacyGenericTooShort(el, text, textLen)) {
          tooShortSkippedForHighTrustUserCount += 1;
        }
      } else {
        if (textLen < 15) {
          addExcluded(el, "too-short");
          return false;
        }
        if (
          /^[\s\W]*$/.test(text) ||
          (textLen < 20 && !el.querySelector("p, pre, blockquote"))
        ) {
          addExcluded(el, "too-short");
          return false;
        }
      }

      if (isHistoryWrapperContainer(el)) {
        const extracted = extractMessageLikeDescendantsFromHistoryWrapper(el, root);
        if (extracted.length > 0) {
          extractedFromWrappers.push(...extracted);
          addExcluded(el, "history-wrapper-extracted");
          return false;
        }
        addExcluded(el, "history-wrapper-empty");
        return false;
      }

      if (isControlHeavyBlock(el)) {
        addExcluded(el, "control-heavy");
        return false;
      }

      if (isNearComposerRegion(el, root) && !explicitUser && !isUq) {
        addExcluded(el, "near-composer");
        return false;
      }

      const rootRect = root.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const isOversizedWrapper = elRect.height > rootRect.height * 0.6 && textLen > 5000;
      const innerBlocks = el.querySelectorAll("[data-message-id], [data-qa='message'], article, [role='listitem']");
      const isMultiBlockWrapper = innerBlocks.length >= 3 && textLen > 2000;

      if (isOversizedWrapper || isMultiBlockWrapper) {
        const extracted = extractMessageLikeDescendantsFromWrapper(el, root);
        if (extracted.length > 0) {
          extractedFromWrappers.push(...extracted);
          addExcluded(el, "wrapper-extracted");
          return false;
        }
        addExcluded(el, "wrapper");
        return false;
      }

      if (isConversationTurnWrapper(el, root)) {
        const atomic = extractAtomicMessageUnitsFromTurnWrapper(el, root);
        if (atomic.length >= 2) {
          lastTurnWrapperStats.turnWrappersDetected += 1;
          lastTurnWrapperStats.turnWrappersExtracted += 1;
          lastTurnWrapperStats.atomicUnitsExtractedCount += atomic.length;
          atomic.forEach((u) => {
            const base = {
              keptReason: "turn-wrapper-split-prune",
              atomicChildCount: atomic.length,
              fromTurnWrapper: true
            };
            if (isUserQueryTagElement(u)) {
              sidebarNodeKeptMeta.set(u, {
                ...base,
                sourceSignal: "user-query-tag",
                ancestorSuppressed: true
              });
            } else if (isHighTrustModelComponentTagElement(u)) {
              sidebarNodeKeptMeta.set(u, {
                ...base,
                sourceSignal: "model-component-tag",
                ancestorSuppressed: true
              });
            } else {
              sidebarNodeKeptMeta.set(u, base);
            }
          });
          extractedFromWrappers.push(...atomic);
          addExcluded(el, "turn-wrapper-extracted");
          return false;
        }
        if (atomic.length === 1 && atomic[0] !== el) {
          lastTurnWrapperStats.turnWrappersDetected += 1;
          lastTurnWrapperStats.turnWrappersExtracted += 1;
          lastTurnWrapperStats.atomicUnitsExtractedCount += 1;
          sidebarNodeKeptMeta.set(atomic[0], {
            keptReason: "turn-wrapper-single-prune",
            atomicChildCount: 1,
            fromTurnWrapper: true
          });
          extractedFromWrappers.push(atomic[0]);
          addExcluded(el, "turn-wrapper-extracted");
          return false;
        }
      }

      return true;
    });

    const documentOrder = (a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    };
    kept = [...kept, ...extractedFromWrappers];
    kept.sort(documentOrder);

    kept = kept.filter((el, i) => {
      for (let j = 0; j < kept.length; j++) {
        if (i === j) continue;
        const other = kept[j];
        if (el.contains(other)) {
          if (isUserQueryTagElement(other) || shouldPreferChildOverParent(el, other)) {
            addExcluded(el, "duplicate-parent");
            if (lastUserPromptLeakDebug && isUserLikeForLeakTracking(el, root)) {
              lastUserPromptLeakDebug.suppressedChains.push({
                reason: "dedupe-duplicate-parent",
                suppressedSelfPreview: previewElText(el, 100),
                suppressedByPreview: previewElText(other, 100),
                suppressedTag: el.tagName,
                keptAtomTag: other.tagName
              });
            }
            return false;
          }
        }
        if (other.contains(el)) {
          if (!isUserQueryTagElement(el) && !shouldPreferChildOverParent(other, el)) {
            addExcluded(el, "duplicate-child");
            if (lastUserPromptLeakDebug && isUserLikeForLeakTracking(el, root)) {
              lastUserPromptLeakDebug.suppressedChains.push({
                reason: "dedupe-duplicate-child",
                suppressedSelfPreview: previewElText(el, 100),
                suppressedByPreview: previewElText(other, 100),
                suppressedTag: el.tagName,
                keptAtomTag: other.tagName
              });
            }
            return false;
          }
        }
        if (!el.contains(other) && !other.contains(el) && areBlocksTextuallyRedundant(el, other)) {
          const elLen = (el.textContent || "").length;
          const otherLen = (other.textContent || "").length;
          if (elLen <= otherLen) {
            addExcluded(el, "duplicate-sibling");
            if (lastUserPromptLeakDebug && isUserLikeForLeakTracking(el, root)) {
              lastUserPromptLeakDebug.suppressedChains.push({
                reason: "dedupe-duplicate-sibling",
                suppressedSelfPreview: previewElText(el, 100),
                suppressedByPreview: previewElText(other, 100),
                suppressedTag: el.tagName,
                keptAtomTag: other.tagName
              });
            }
            return false;
          }
        }
      }
      return true;
    });

    return {
      kept,
      excluded,
      prunedUserLikeCandidates,
      tooShortSkippedForHighTrustUserCount
    };
  }

  /**
   * 診斷專用：是否「肉眼上可能像 user prompt」。
   * 不影響 messageType / prune，僅供 console 與 keptBlocksPreview 標記。
   */
  function computeLooksUserLikeForDiagnostic(node, allKept) {
    if (!node || !(node instanceof HTMLElement)) return false;

    if (node.querySelector("pre, table, blockquote")) return false;

    const listItems = node.querySelectorAll("ul li, ol li").length;
    if (listItems >= 3) return false;

    if (node.querySelectorAll("pre").length > 0) return false;

    const codeEls = node.querySelectorAll("code");
    if (codeEls.length > 2) return false;

    const textLen = (node.textContent || "").trim().length;
    if (textLen < 15 || textLen > 520) return false;

    const paragraphCount = node.querySelectorAll("p").length;
    const isSimpleStructure =
      paragraphCount <= 3 && listItems < 2 && codeEls.length <= 1;

    const root = findConversationRootContainer();
    if (!root || !root.getBoundingClientRect) return false;

    const rootRect = root.getBoundingClientRect();
    const rootWidth = rootRect.width || 1;
    const nodeRect = node.getBoundingClientRect();
    const widthRatio = nodeRect.width / (rootWidth || 1);
    const isNarrow = widthRatio < 0.62;
    const isCardLike = isNarrow && nodeRect.height < rootRect.height * 0.28;

    let hasLargeNextSibling = false;
    if (Array.isArray(allKept) && allKept.length > 0) {
      const idx = allKept.indexOf(node);
      if (idx >= 0 && idx < allKept.length - 1) {
        const next = allKept[idx + 1];
        if (next && next.getBoundingClientRect) {
          const nextRect = next.getBoundingClientRect();
          const nextTextLen = (next.textContent || "").trim().length;
          if (
            nextRect.height > nodeRect.height * 1.35 ||
            nextTextLen > Math.max(textLen * 1.7, 100)
          ) {
            hasLargeNextSibling = true;
          }
        }
      }
    }

    try {
      const extLinks = node.querySelectorAll('a[href^="http"], a[href^="//"]');
      if (extLinks.length >= 8) return false;
      if (node.querySelectorAll("sup").length >= 5) return false;
    } catch (_) {}

    let score = 0;
    if (textLen < 300) score += 2;
    else if (textLen < 450) score += 1;
    if (isSimpleStructure) score += 2;
    if (isNarrow) score += 1;
    if (isCardLike) score += 1;
    if (hasLargeNextSibling && textLen < 480) score += 2;

    return (
      score >= 5 ||
      (score >= 4 && textLen < 360) ||
      (hasLargeNextSibling && isSimpleStructure && textLen < 420)
    );
  }

  /** 相對於本輪 kept 清單的層級（診斷用）。 */
  function getHierarchyLevelForKept(node, allKept) {
    const hasChildInKept = allKept.some((o) => o !== node && node.contains(o));
    const hasParentInKept = allKept.some((o) => o !== node && o.contains(node));
    if (hasChildInKept && hasParentInKept) return "mid";
    if (hasChildInKept) return "parent";
    if (hasParentInKept) return "mid";
    return "leaf";
  }

  function buildKeptBlocksPreview(kept) {
    const root = findConversationRootContainer();
    return kept.map((node, index) => {
      const d = detectMessageTypeWithDetails(node, kept);
      const text = (node.textContent || "").trim().replace(/\s+/g, " ");
      const looksUserLike = computeLooksUserLikeForDiagnostic(node, kept);
      const meta = sidebarNodeKeptMeta.get(node) || {};
      const containsMixed = containsUserAndGeminiMixedText(node);
      const stillTurnWrapper = root ? isConversationTurnWrapper(node, root) : false;
      return {
        index,
        tag: node.tagName,
        class: (node.className && String(node.className).slice(0, 60)) || "",
        textLen: text.length,
        type: d.type,
        messageType: d.type,
        textPreview: text.slice(0, 80),
        scoreUser: d.userScore,
        scoreGemini: d.geminiScore,
        selectedReason: d.selectedReason,
        sourceSignal: inferSourceSignalForKeptPreview(node, d.selectedReason),
        depth: root ? getDepthFromConversationRoot(node, root) : null,
        ancestorSuppressed: meta.ancestorSuppressed === true,
        looksUserLike,
        isTurnWrapper: stillTurnWrapper,
        containsMixedUserGeminiText: containsMixed,
        atomicChildCount: meta.atomicChildCount ?? 0,
        keptReason: meta.keptReason || "direct-candidate",
        hierarchyLevel: getHierarchyLevelForKept(node, kept)
      };
    });
  }

  /**
   * Selector -> merge -> prune 管線。
   * 不再「命中一組就整組回傳」，改為收集所有 selector 候選、合併去重、prune 後回傳。
   */
  function finalizeUserPromptLeakDebug(root, mergedAfterHighTrust, mergedAfterExpand, kept, excluded) {
    if (!lastUserPromptLeakDebug || !root) return;
    const keptSet = new Set(kept);
    const mergedHS = new Set(mergedAfterHighTrust);
    const mergedEX = new Set(mergedAfterExpand);
    let uq = [];
    try {
      uq = Array.from(root.querySelectorAll("user-query"));
    } catch (_) {}

    lastUserPromptLeakDebug.userQueryCandidates = uq.map((el) => {
      const tl = (el.textContent || "").trim().length;
      const dp = getDepthFromConversationRoot(el, root);
      const inMerged = mergedHS.has(el);
      const inExpanded = mergedEX.has(el);
      const inKept = keptSet.has(el);
      let notKeptReason = null;
      if (!inKept) {
        if (!inMerged) notKeptReason = "not-in-merged-after-high-trust";
        else if (!inExpanded) notKeptReason = "not-in-merged-after-expand";
        else {
          const hit = excluded.find((x) => x.el === el);
          notKeptReason = hit ? hit.reason : "prune-unknown-not-in-excluded";
        }
      }
      return {
        textPreview: previewElText(el, 100),
        textLen: tl,
        depth: dp,
        inMerged,
        inExpanded,
        inKept,
        notKeptReason
      };
    });
  }

  function findMessageElements() {
    const root = findConversationRootContainer();
    if (!root) {
      resetUserPromptLeakDebug();
      return [];
    }

    sidebarNodeKeptMeta = new WeakMap();
    lastTurnWrapperStats = {
      turnWrappersDetected: 0,
      turnWrappersExtracted: 0,
      atomicUnitsExtractedCount: 0
    };
    resetUserPromptLeakDebug();

    const strategies = [
      () => Array.from(root.querySelectorAll("[data-message-id]")),
      () =>
        Array.from(
          root.querySelectorAll(
            "[data-qa='message'], [data-qa='conversation-turn']"
          )
        ),
      () =>
        Array.from(
          root.querySelectorAll(
            "[role='listitem'][data-author], [role='listitem'][data-message-author]"
          )
        ),
      () => Array.from(root.querySelectorAll("article"))
    ];

    const strategyLabels = [
      "[data-message-id]",
      "[data-qa='message'], [data-qa='conversation-turn']",
      "[role='listitem'][data-author], [role='listitem'][data-message-author]",
      "article"
    ];

    const seen = new Set();
    const selectorCounts = {};
    for (let si = 0; si < strategies.length; si++) {
      const nodes = strategies[si]();
      selectorCounts[strategyLabels[si]] = nodes.length;
      for (const node of nodes) {
        if (!node || !(node instanceof HTMLElement)) continue;
        if (seen.has(node)) continue;
        seen.add(node);
      }
    }

    let merged = Array.from(seen);
    const documentOrder = (a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    };
    merged.sort(documentOrder);

    const highTrustMerge = mergeHighTrustDomTagsIntoCandidates(root, merged);
    merged = highTrustMerge.merged;
    selectorCounts["high-trust-dom-tags"] = highTrustMerge.highTrustAtomCount;

    if (merged.length === 0) {
      const taggedOnly = collectHighTrustDomTaggedNodes(root);
      const atomsOnly = keepDeepestExclusiveInSet(taggedOnly.map((t) => t.el));
      if (atomsOnly.length > 0) {
        atomsOnly.forEach((hel) => {
          const hit = taggedOnly.find((x) => x.el === hel);
          sidebarNodeKeptMeta.set(hel, {
            sourceSignal: hit?.sourceSignal || (isUserQueryTagElement(hel) ? "user-query-tag" : "model-component-tag"),
            ancestorSuppressed: true,
            keptReason: "high-trust-dom-tag-only"
          });
        });
        merged = atomsOnly.sort(documentOrder);
        selectorCounts["high-trust-dom-tags"] = atomsOnly.length;
      }
    }

    const mergedAfterHighTrust = merged.slice();
    merged = expandTurnWrappersInCandidateList(merged, root);
    const mergedAfterExpand = merged.slice();

    if (merged.length === 0) {
      let fallback = runFallbackScan(root);
      if (fallback.length > 0) {
        fallback = expandTurnWrappersInCandidateList(fallback, root);
        lastStrategy = "fallback-text-block-scan";
        let tooShortSkippedForHighTrustUserCount = 0;
        let pruneOut = pruneMessageElementCandidates(fallback, root);
        let { kept, excluded, prunedUserLikeCandidates } = pruneOut;
        tooShortSkippedForHighTrustUserCount += pruneOut.tooShortSkippedForHighTrustUserCount || 0;
        let rescueTriggered = false;
        let rescueCandidateCount = 0;
        let rescueKeptCount = 0;
        let singleCandidateReason = null;

        if (fallback.length === 1 && kept.length === 0) {
          const single = fallback[0];
          const singleExcluded = excluded.find((x) => x.el === single);
          singleCandidateReason = singleExcluded?.reason || "unknown";
          const singleIsHistoryWrapper = isHistoryWrapperContainer(single);
          if (
            singleIsHistoryWrapper ||
            singleExcluded?.reason === "control-heavy" ||
            singleExcluded?.reason === "history-wrapper-empty"
          ) {
            const extracted =
              singleIsHistoryWrapper || singleExcluded?.reason === "history-wrapper-empty"
                ? extractMessageLikeDescendantsFromHistoryWrapper(single, root)
                : isHistoryWrapperContainer(single)
                  ? extractMessageLikeDescendantsFromHistoryWrapper(single, root)
                  : extractMessageLikeDescendantsFromWrapper(single, root);
            if (extracted.length > 0) {
              rescueTriggered = true;
              rescueCandidateCount = extracted.length;
              const rescueResult = pruneMessageElementCandidates(extracted, root);
              tooShortSkippedForHighTrustUserCount +=
                rescueResult.tooShortSkippedForHighTrustUserCount || 0;
              prunedUserLikeCandidates = prunedUserLikeCandidates.concat(rescueResult.prunedUserLikeCandidates || []);
              if (rescueResult.kept.length > 0) {
                kept = rescueResult.kept;
                rescueKeptCount = kept.length;
              }
            }
          } else if (singleExcluded?.reason === "wrapper") {
            const extracted = extractMessageLikeDescendantsFromWrapper(single, root);
            rescueTriggered = true;
            rescueCandidateCount = extracted.length;
            if (extracted.length > 0) {
              const rescueResult = pruneMessageElementCandidates(extracted, root);
              tooShortSkippedForHighTrustUserCount +=
                rescueResult.tooShortSkippedForHighTrustUserCount || 0;
              prunedUserLikeCandidates = prunedUserLikeCandidates.concat(rescueResult.prunedUserLikeCandidates || []);
              if (rescueResult.kept.length > 0) {
                kept = rescueResult.kept;
                rescueKeptCount = kept.length;
              }
            }
          } else if (singleExcluded?.reason === "near-composer" && (single.textContent || "").trim().length >= 100 && !isControlHeavyBlock(single)) {
            rescueTriggered = true;
            kept = [single];
            rescueKeptCount = 1;
          } else if (singleExcluded?.reason === "too-short" && (single.textContent || "").trim().length >= 15 && !isControlHeavyBlock(single) && !isNearComposerRegion(single, root)) {
            rescueTriggered = true;
            kept = [single];
            rescueKeptCount = 1;
          }
        }

        const fallbackCounts = { gemini: 0, user: 0, unknown: 0 };
        kept.forEach((n) => {
          const t = detectMessageType(n, kept);
          fallbackCounts[t] = (fallbackCounts[t] || 0) + 1;
        });

        const fallbackSingle = fallback.length === 1 ? fallback[0] : null;
        const keptBlocksPreview = buildKeptBlocksPreview(kept);
        const recoveredUserCountFromTooShort = computeRecoveredUserCountFromTooShort(kept, root);
        finalizeUserPromptLeakDebug(root, [], fallback.slice(), kept, excluded);
        emitSidebarDebug({
          root,
          selectorCounts,
          mergedCount: fallback.length,
          pruneCount: kept.length,
          strategy: lastStrategy,
          excludedReasons: excluded.map(({ reason }) => reason),
          usedFallback: true,
          rescueTriggered,
          rescueCandidateCount,
          rescueKeptCount,
          singleCandidateReason: fallback.length === 1 && kept.length === 0 ? singleCandidateReason : null,
          singleCandidate: fallbackSingle,
          singleCandidateIsHistoryWrapper: fallbackSingle ? isHistoryWrapperContainer(fallbackSingle) : null,
          historyWrapperDescendantCount: rescueTriggered ? rescueCandidateCount : null,
          historyWrapperKeptCount: rescueTriggered ? rescueKeptCount : null,
          typeCounts: fallbackCounts,
          keptBlocksPreview,
          prunedUserLikeCandidates,
          tooShortSkippedForHighTrustUserCount,
          recoveredUserCountFromTooShort,
          turnWrappersDetected: lastTurnWrapperStats.turnWrappersDetected,
          turnWrappersExtracted: lastTurnWrapperStats.turnWrappersExtracted,
          atomicUnitsExtractedCount: lastTurnWrapperStats.atomicUnitsExtractedCount
        });
        return kept;
      }
      lastStrategy = "none";
      finalizeUserPromptLeakDebug(root, [], [], [], []);
      emitSidebarDebug({
        root,
        selectorCounts,
        mergedCount: 0,
        pruneCount: 0,
        strategy: lastStrategy,
        usedFallback: true,
        tooShortSkippedForHighTrustUserCount: 0,
        recoveredUserCountFromTooShort: 0,
        prunedUserLikeCandidates: [],
        turnWrappersDetected: lastTurnWrapperStats.turnWrappersDetected,
        turnWrappersExtracted: lastTurnWrapperStats.turnWrappersExtracted,
        atomicUnitsExtractedCount: lastTurnWrapperStats.atomicUnitsExtractedCount
      });
      return [];
    }

    lastStrategy = Object.entries(selectorCounts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}:${n}`)
      .join(", ") || "merged";

    let tooShortSkippedForHighTrustUserCount = 0;
    let pruneMain = pruneMessageElementCandidates(merged, root);
    let { kept, excluded, prunedUserLikeCandidates } = pruneMain;
    tooShortSkippedForHighTrustUserCount += pruneMain.tooShortSkippedForHighTrustUserCount || 0;
    let rescueTriggered = false;
    let rescueCandidateCount = 0;
    let rescueKeptCount = 0;
    let singleCandidateReason = null;

    if (merged.length === 1 && kept.length === 0) {
      const single = merged[0];
      const singleExcluded = excluded.find((x) => x.el === single);
      singleCandidateReason = singleExcluded?.reason || "unknown";

      const singleIsHistoryWrapper = isHistoryWrapperContainer(single);
      if (
        singleIsHistoryWrapper ||
        singleExcluded?.reason === "control-heavy" ||
        singleExcluded?.reason === "history-wrapper-empty"
      ) {
        const extracted =
          singleIsHistoryWrapper || singleExcluded?.reason === "history-wrapper-empty"
            ? extractMessageLikeDescendantsFromHistoryWrapper(single, root)
            : isHistoryWrapperContainer(single)
              ? extractMessageLikeDescendantsFromHistoryWrapper(single, root)
              : extractMessageLikeDescendantsFromWrapper(single, root);
        if (extracted.length > 0) {
          rescueTriggered = true;
          rescueCandidateCount = extracted.length;
          const rescueResult = pruneMessageElementCandidates(extracted, root);
          tooShortSkippedForHighTrustUserCount +=
            rescueResult.tooShortSkippedForHighTrustUserCount || 0;
          prunedUserLikeCandidates = prunedUserLikeCandidates.concat(rescueResult.prunedUserLikeCandidates || []);
          if (rescueResult.kept.length > 0) {
            kept = rescueResult.kept;
            rescueKeptCount = kept.length;
          }
        }
      } else if (singleExcluded?.reason === "wrapper") {
        const extracted = extractMessageLikeDescendantsFromWrapper(single, root);
        rescueTriggered = true;
        rescueCandidateCount = extracted.length;
        if (extracted.length > 0) {
          const rescueResult = pruneMessageElementCandidates(extracted, root);
          tooShortSkippedForHighTrustUserCount +=
            rescueResult.tooShortSkippedForHighTrustUserCount || 0;
          prunedUserLikeCandidates = prunedUserLikeCandidates.concat(rescueResult.prunedUserLikeCandidates || []);
          if (rescueResult.kept.length > 0) {
            kept = rescueResult.kept;
            rescueKeptCount = kept.length;
          }
        }
      } else if (singleExcluded?.reason === "near-composer") {
        const textLen = (single.textContent || "").trim().length;
        if (textLen >= 100 && !isControlHeavyBlock(single)) {
          rescueTriggered = true;
          kept = [single];
          rescueKeptCount = 1;
        }
      } else if (singleExcluded?.reason === "too-short") {
        const textLen = (single.textContent || "").trim().length;
        if (textLen >= 15 && !isControlHeavyBlock(single) && !isNearComposerRegion(single, root)) {
          rescueTriggered = true;
          kept = [single];
          rescueKeptCount = 1;
        }
      }
    }

    const counts = { gemini: 0, user: 0, unknown: 0 };
    kept.forEach((n) => {
      const t = detectMessageType(n, kept);
      counts[t] = (counts[t] || 0) + 1;
    });
    const singleCandidate = merged.length === 1 ? merged[0] : null;
    const singleCandidateIsHistoryWrapper = singleCandidate ? isHistoryWrapperContainer(singleCandidate) : null;
    const keptBlocksPreview = buildKeptBlocksPreview(kept);
    const recoveredUserCountFromTooShort = computeRecoveredUserCountFromTooShort(kept, root);

    finalizeUserPromptLeakDebug(root, mergedAfterHighTrust, mergedAfterExpand, kept, excluded);

    emitSidebarDebug({
      root,
      selectorCounts,
      mergedCount: merged.length,
      pruneCount: kept.length,
      strategy: lastStrategy,
      typeCounts: counts,
      excludedReasons: excluded.map(({ reason }) => reason),
      usedFallback: false,
      rescueTriggered,
      rescueCandidateCount,
      rescueKeptCount,
      singleCandidateReason: merged.length === 1 && kept.length === 0 ? singleCandidateReason : null,
      singleCandidate,
      singleCandidateIsHistoryWrapper,
      historyWrapperDescendantCount: rescueTriggered ? rescueCandidateCount : null,
      historyWrapperKeptCount: rescueTriggered ? rescueKeptCount : null,
      keptBlocksPreview,
      prunedUserLikeCandidates,
      tooShortSkippedForHighTrustUserCount,
      recoveredUserCountFromTooShort,
      turnWrappersDetected: lastTurnWrapperStats.turnWrappersDetected,
      turnWrappersExtracted: lastTurnWrapperStats.turnWrappersExtracted,
      atomicUnitsExtractedCount: lastTurnWrapperStats.atomicUnitsExtractedCount
    });

    return kept;
  }

  let lastSidebarDebugInfo = null;

  /**
   * 判定 zero blocks 的原因。
   */
  function computeZeroBlockReason(info) {
    const { mergedCount, pruneCount, excludedCounts, usedFallback, chosenRootTextLength } = info;
    if (mergedCount === 0) {
      if (chosenRootTextLength != null && chosenRootTextLength < 100) {
        return "root-has-no-message-like-content";
      }
      return usedFallback ? "fallback-empty" : "selectors-empty";
    }
    if (pruneCount === 0) {
      const counts = excludedCounts || {};
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (total > 0 && counts["near-composer"] === total) return "all-near-composer";
      if (total > 0 && counts["control-heavy"] === total) return "all-control-heavy";
      return "all-pruned";
    }
    return null;
  }

  // logReadableSidebarScanEvidence removed for production

  /**
   * Debug 輸出：儲存 lastSidebarDebugInfo、寫入 DOM 供 page context 讀取、自動 console 輸出。
   */
  function emitSidebarDebug(info) {
    const pageType = typeof detectPageType === "function" ? detectPageType() : "unknown";
    const excludedReasons = info.excludedReasons || [];
    const excludedCounts = {};
    excludedReasons.forEach((r) => {
      excludedCounts[r] = (excludedCounts[r] || 0) + 1;
    });
    const chosenRootTextLength = info.root ? (info.root.textContent || "").trim().length : 0;
    const zeroBlockReason = info.pruneCount === 0 ? computeZeroBlockReason({
      mergedCount: info.mergedCount,
      pruneCount: info.pruneCount,
      excludedCounts,
      usedFallback: info.usedFallback,
      chosenRootTextLength
    }) : null;

    const chosenRootTag = info.root?.tagName || null;
    const chosenRootClass = info.root?.className?.slice?.(0, 80) || null;

    const singleCandidateTag = info.singleCandidate?.tagName || null;
    const singleCandidateClass = info.singleCandidate?.className?.slice?.(0, 60) || null;
    const singleCandidateTextLength = info.singleCandidate ? (info.singleCandidate.textContent || "").trim().length : null;

    const prunedListForTooShort = info.prunedUserLikeCandidates || [];
    const prunedUserLikeTooShortRemaining = prunedListForTooShort.filter(
      (r) => r.excludedReason === "too-short"
    ).length;

    lastSidebarDebugInfo = {
      pageType,
      firstMessageFound: lastFirstMessageInfo.found,
      firstMessageTag: lastFirstMessageInfo.tag,
      firstMessageClass: lastFirstMessageInfo.class,
      firstMessageReason: lastFirstMessageInfo.reason,
      chosenRootTag,
      chosenRootClass,
      chosenRootTextLength,
      rootCandidateCount: lastRootCandidates.length,
      rootCandidates: lastRootCandidates,
      rootChosenReason: lastRootChosenReason,
      selectorCounts: info.selectorCounts,
      mergedCount: info.mergedCount,
      pruneCount: info.pruneCount,
      excludedCounts,
      zeroBlockReason,
      typeCounts: info.typeCounts,
      singleCandidateTag,
      singleCandidateClass,
      singleCandidateTextLength,
      singleCandidateReason: info.singleCandidateReason,
      singleCandidateIsHistoryWrapper: info.singleCandidateIsHistoryWrapper,
      historyWrapperDescendantCount: info.historyWrapperDescendantCount,
      historyWrapperKeptCount: info.historyWrapperKeptCount,
      rescueTriggered: info.rescueTriggered,
      rescueCandidateCount: info.rescueCandidateCount,
      rescueKeptCount: info.rescueKeptCount,
      allCount: info.typeCounts
        ? (info.typeCounts.gemini || 0) + (info.typeCounts.user || 0) + (info.typeCounts.unknown || 0)
        : null,
      geminiCount: info.typeCounts?.gemini ?? null,
      userCount: info.typeCounts?.user ?? null,
      unknownCount: info.typeCounts?.unknown ?? null,
      keptBlocksPreview: info.keptBlocksPreview || [],
      prunedUserLikeCandidates: info.prunedUserLikeCandidates || [],
      tooShortSkippedForHighTrustUserCount: info.tooShortSkippedForHighTrustUserCount ?? 0,
      recoveredUserCountFromTooShort: info.recoveredUserCountFromTooShort ?? 0,
      prunedUserLikeTooShortRemaining,
      turnWrappersDetected: info.turnWrappersDetected ?? 0,
      turnWrappersExtracted: info.turnWrappersExtracted ?? 0,
      atomicUnitsExtractedCount: info.atomicUnitsExtractedCount ?? 0,
      userPromptLeakDebug: lastUserPromptLeakDebug
        ? {
            userQueryCandidates: lastUserPromptLeakDebug.userQueryCandidates,
            userLikeNotKept: lastUserPromptLeakDebug.userLikeNotKept,
            suppressedChains: lastUserPromptLeakDebug.suppressedChains
          }
        : null
    };

    // Debug data no longer written to DOM in production

    if (info.pruneCount === 0) {
      GRA_DEBUG && console.info("[GRA][sidebar][debug] zero blocks", {
        pageType,
        firstMessageFound: lastFirstMessageInfo.found,
        firstMessageTag: lastFirstMessageInfo.tag,
        firstMessageClass: lastFirstMessageInfo.class,
        firstMessageReason: lastFirstMessageInfo.reason,
        chosenRootTag,
        chosenRootClass,
        rootCandidateCount: lastRootCandidates.length,
        rootCandidates: lastRootCandidates,
        rootChosenReason: lastRootChosenReason,
        selectorCounts: info.selectorCounts,
        mergedCount: info.mergedCount,
        pruneCount: info.pruneCount,
        excludedCounts,
        zeroBlockReason,
        singleCandidateTag,
        singleCandidateClass,
        singleCandidateTextLength,
        singleCandidateReason: info.singleCandidateReason,
        singleCandidateIsHistoryWrapper: info.singleCandidateIsHistoryWrapper,
        historyWrapperDescendantCount: info.historyWrapperDescendantCount,
        historyWrapperKeptCount: info.historyWrapperKeptCount,
        rescueTriggered: info.rescueTriggered,
        rescueCandidateCount: info.rescueCandidateCount,
        rescueKeptCount: info.rescueKeptCount,
        turnWrappersDetected: info.turnWrappersDetected ?? 0,
        turnWrappersExtracted: info.turnWrappersExtracted ?? 0,
        atomicUnitsExtractedCount: info.atomicUnitsExtractedCount ?? 0,
        tooShortSkippedForHighTrustUserCount: info.tooShortSkippedForHighTrustUserCount ?? 0,
        recoveredUserCountFromTooShort: info.recoveredUserCountFromTooShort ?? 0,
        prunedUserLikeTooShortRemaining
      });
    } else {
      GRA_DEBUG && console.info("[GRA][sidebar][debug] blocks found", {
        count: info.pruneCount,
        typeCounts: info.typeCounts,
        allCount: lastSidebarDebugInfo.allCount,
        geminiCount: lastSidebarDebugInfo.geminiCount,
        userCount: lastSidebarDebugInfo.userCount,
        unknownCount: lastSidebarDebugInfo.unknownCount,
        turnWrappersDetected: info.turnWrappersDetected ?? 0,
        turnWrappersExtracted: info.turnWrappersExtracted ?? 0,
        atomicUnitsExtractedCount: info.atomicUnitsExtractedCount ?? 0,
        keptBlocksPreview: info.keptBlocksPreview,
        prunedUserLikeCandidates: info.prunedUserLikeCandidates || [],
        tooShortSkippedForHighTrustUserCount: info.tooShortSkippedForHighTrustUserCount ?? 0,
        recoveredUserCountFromTooShort: info.recoveredUserCountFromTooShort ?? 0,
        prunedUserLikeTooShortRemaining
      });
    }

    // Evidence logging removed for production
  }

  /**
   * 由訊息節點產生側邊欄顯示文字。
   * 優先使用該訊息的前幾個字，過長則截斷並加上編號。
   */
  function buildLabelFromMessage(node, index) {
    const raw = (node.textContent || "").trim().replace(/\s+/g, " ");
    if (!raw) {
      return `訊息 ${index + 1}`;
    }

    const prefix = `${index + 1}. `;
    const maxLength = 40;
    const available = maxLength - prefix.length;
    if (raw.length <= available) {
      return prefix + raw;
    }
    return `${prefix}${raw.slice(0, available - 1)}…`;
  }

  /**
   * Fallback 文字區塊掃描策略。
   * 在所有主要 selector 都找不到訊息節點時使用。
   *
   * 掃描流程：
   *   階段 1：語義元素 — article / section / [role='article'] / [role='region'] / [role='listitem']
   *   階段 2：含 block 子元素的 div（更嚴格過濾）
   *
   * 過濾規則（兩個階段共用）：
   *   - 排除插件 UI（class 含 gra- 前綴）
   *   - 排除 Gemini 輸入框區域（rich-textarea 內部 / 元素本身帶 contenteditable）
   *   - 排除結構性根元素（main / body / html / header / footer / nav）
   *   - 排除不可見元素（display:none / visibility:hidden）
   *   - 排除文字內容 < 30 字元的元素
   *
   * 去重規則：父子同時命中時，移除外層父元素，保留內層子元素。
   */
  function runFallbackScan(root) {
    /** 判斷元素是否為 GRA UI 或 Gemini 輸入框區域。 */
    function isExcludedEl(el) {
      // GRA 插件 UI：往祖先查找是否有 gra- 前綴 class。
      let cur = el;
      while (cur && cur !== root) {
        if (
          cur.className &&
          typeof cur.className === "string" &&
          cur.className.split(" ").some((c) => c.startsWith("gra-"))
        ) {
          return true;
        }
        cur = cur.parentElement;
      }
      // Gemini 輸入框：元素本身是 contenteditable 或位於 rich-textarea 內。
      if (el.closest("rich-textarea")) return true;
      if (el.hasAttribute("contenteditable")) return true;
      if (el.closest("[contenteditable]")) return true;
      return false;
    }

    /** 排除結構性根元素，這些幾乎必然是外層包裹容器。 */
    function isStructuralWrapper(el) {
      if (el === root) return true;
      const tag = el.tagName.toLowerCase();
      return [
        "main", "body", "html", "header", "footer",
        "nav", "script", "style", "template"
      ].includes(tag);
    }

    /** 元素是否可見。 */
    function isVisible(el) {
      try {
        const s = getComputedStyle(el);
        return s.display !== "none" && s.visibility !== "hidden";
      } catch (_) {
        return true;
      }
    }

    /** 是否包含至少一個 block 層子孫元素（用於 div 篩選）。 */
    function hasBlockDescendant(el) {
      return !!el.querySelector(
        "p, h1, h2, h3, h4, h5, h6, pre, ul, ol, blockquote, table, code"
      );
    }

    /** 共用過濾條件。 */
    function passesBaseFilter(el) {
      if (isExcludedEl(el)) return false;
      if (isStructuralWrapper(el)) return false;
      if (!isVisible(el)) return false;
      if ((el.textContent || "").trim().length < 30) return false;
      return true;
    }

    /**
     * 父子去重：綜合文本長度比、是否更像完整訊息單位，決定保留父或子。
     * 不單純用 contains() 一律留子。
     */
    function deduplicateParentChild(els) {
      const set = new Set(els);
      return els.filter((el) => {
        for (const other of set) {
          if (other === el) continue;
          if (el.contains(other)) {
            if (shouldPreferChildOverParent(el, other)) return false;
          }
          if (other.contains(el)) {
            if (!shouldPreferChildOverParent(other, el)) return false;
          }
        }
        return true;
      });
    }

    // 階段 1：語義元素（不需要 block 子元素條件，本身語義已足夠）
    const semanticEls = Array.from(
      root.querySelectorAll(
        "article, section, [role='article'], [role='region'], [role='listitem']"
      )
    ).filter(passesBaseFilter);

    if (semanticEls.length > 0) {
      return deduplicateParentChild(semanticEls);
    }

    // 階段 2：div，需額外要求包含 block 子元素，避免抓到純文字小容器。
    const divEls = Array.from(root.querySelectorAll("div")).filter(
      (el) => passesBaseFilter(el) && hasBlockDescendant(el)
    );

    return deduplicateParentChild(divEls);
  }

  // ---------------------------------------------------------------------------
  // Condense V7.5 — passive mount helpers
  // ---------------------------------------------------------------------------

  /**
   * 注入 condense UI 所需的 CSS（冪等，只插一次）。
   */
  function injectCondenseStyles() {
    if (document.getElementById("gra-condense-style")) return;

    const style = document.createElement("style");
    style.id = "gra-condense-style";
    style.textContent = `
      .gra-condense-root {
        margin-bottom: 8px;
      }

      .gra-condense-box {
        background: rgba(30, 41, 59, 0.6);
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 13px;
        line-height: 1.5;
        color: #e5e7eb;
      }

      .gra-condense-summary {
        font-weight: 600;
        margin-bottom: 4px;
        color: #f1f5f9;
      }

      .gra-condense-method {
        opacity: 0.85;
        color: #cbd5e1;
      }
    `;

    document.head.appendChild(style);
  }

  /**
   * 從訊息節點取得可供濃縮的純文字。
   * 嘗試鎖定主內容區，避免抓到 UI 標籤文字。
   * @param {HTMLElement} node
   * @returns {string}
   */
  function getCondenseSourceText(node) {
    const CONTENT_SELECTORS = [
      "message-content",
      ".message-content",
      "[data-message-content]",
      ".markdown-content",
      ".response-content",
      "model-response"
    ];
    let root = null;
    for (const sel of CONTENT_SELECTORS) {
      root = node.querySelector(sel);
      if (root) break;
    }
    root = root || node;
    return (root.innerText || root.textContent || "").trim().replace(/\s+/g, " ");
  }

  /**
   * 對單一 Gemini 訊息節點執行 Condense V7.5，並將結果插入 DOM。
   * - 只處理 msgType === "gemini"
   * - 具備冪等防呆（data-gra-condense-root 已存在則跳過）
   * @param {HTMLElement} messageEl
   * @param {string} msgType
   */
  function runCondenseV75(messageEl, msgType) {
    if (_moduleSettings && !_moduleSettings.showMessageCondense) return;
    if (msgType !== "gemini") return;
    if (messageEl.querySelector("[data-gra-condense-root]")) return;

    injectCondenseStyles();

    const engine = window.GRACondenseEngine;
    if (!engine || typeof engine.extractIR !== "function") return;

    const text = getCondenseSourceText(messageEl);
    if (!text || text.length < 30) return;

    // extractIR returns null for unknown / unclassifiable content
    const ir      = engine.extractIR(text);
    let   summary = engine.renderSummaryV75(ir);   // null-safe: returns ⚠️ string
    let   method  = engine.renderMethodV75(ir);    // null-safe: returns ""

    // Semantic alignment guard: override if summary has no keyword overlap with source
    if (ir && typeof engine.hasKeywordOverlap === "function") {
      if (!engine.hasKeywordOverlap(text, summary)) {
        summary = "⚠️ 無法安全濃縮（語義不匹配）";
        method  = "";
      }
    }

    // Condense V7.5 debug log removed for production

    const condenseRoot = document.createElement("div");
    condenseRoot.setAttribute("data-gra-condense-root", "true");
    condenseRoot.className = "gra-condense-root";

    // Build inner HTML; omit method row when empty (warning-only state)
    const methodHtml = method
      ? '<div class="gra-condense-method">\u2699\uFE0F ' + method + "</div>"
      : "";
    condenseRoot.innerHTML =
      '<div class="gra-condense-box">' +
        '<div class="gra-condense-summary">\uD83E\uDDE0 ' + summary + "</div>" +
        methodHtml +
      "</div>";

    // 找到最近的內容根，插在其前方；找不到則 prepend 到訊息節點
    const CONTENT_SELECTORS_INLINE = [
      "message-content", ".message-content", "[data-message-content]",
      ".markdown-content", ".response-content", "model-response"
    ];
    let contentRoot = null;
    for (const sel of CONTENT_SELECTORS_INLINE) {
      contentRoot = messageEl.querySelector(sel);
      if (contentRoot) break;
    }
    if (contentRoot && contentRoot.parentElement) {
      contentRoot.parentElement.insertBefore(condenseRoot, contentRoot);
    } else {
      messageEl.prepend(condenseRoot);
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * 根據目前的訊息節點重建側邊導覽清單。
   * 會清空舊項目並重新建立，但不會重複插入外層容器。
   */
  // ---- Context Usage Meter (Pro) ----

  function ensureUsageMeter() {
    if (!_proEnabled || !bodyEl) return;
    if (document.getElementById("gra-usage-meter")) return;
    var meter = document.createElement("div");
    meter.id = "gra-usage-meter";
    meter.className = "gra-usage-meter";
    meter.innerHTML =
      '<div class="gra-usage-meter__bar"><div class="gra-usage-meter__fill"></div></div>' +
      '<div class="gra-usage-meter__label"></div>';
    bodyEl.appendChild(meter);
  }

  function updateUsageMeter() {
    if (!_proEnabled) return;
    var meter = document.getElementById("gra-usage-meter");
    if (!meter) return;

    var totalChars = 0;
    var totalRounds = 0;
    var lastRole = null;
    messageStore.forEach(function (msg) {
      totalChars += (msg.text || "").length;
      if (msg.role === "user" && lastRole !== "user") totalRounds++;
      lastRole = msg.role;
    });

    var PLAN_LIMITS = {
      "flash-32k": 32000,
      "pro-128k": 128000,
      "ultra-1m": 1000000
    };
    var plan = (_moduleSettings && _moduleSettings.geminiPlan) || "pro-128k";
    var limit = typeof plan === "number" ? plan : (PLAN_LIMITS[plan] || 128000);

    var estimatedTokens = Math.round(totalChars * 1.5);
    var usagePercent = Math.min(100, Math.round((estimatedTokens / limit) * 100));

    var fill = meter.querySelector(".gra-usage-meter__fill");
    var label = meter.querySelector(".gra-usage-meter__label");

    fill.style.width = usagePercent + "%";
    fill.className = "gra-usage-meter__fill" +
      (usagePercent >= 75 ? " gra-usage-meter__fill--danger" :
       usagePercent >= 50 ? " gra-usage-meter__fill--warning" : "");

    var charsK = Math.round(totalChars / 1000);
    var hint = "";
    if (usagePercent >= 75) hint = " · 認知臨界點：建議執行環境快照，避免 AI 邏輯偏差";
    else if (usagePercent >= 50) hint = " · 認知餘裕收窄：建議準備快照銜接";

    label.textContent = totalRounds + " 輪 · 約 " + charsK + "K 字 · " + usagePercent + "%" + hint;

    // Handoff button at 75%+
    if (usagePercent >= 75) {
      var handoffBtn = meter.querySelector(".gra-usage-meter__handoff");
      if (!handoffBtn) {
        handoffBtn = document.createElement("button");
        handoffBtn.type = "button";
        handoffBtn.className = "gra-usage-meter__handoff";
        handoffBtn.textContent = "執行環境快照 · 銜接新對話";
        handoffBtn.addEventListener("click", snapshotHandoff);
        meter.appendChild(handoffBtn);
      }
    } else {
      var existing = meter.querySelector(".gra-usage-meter__handoff");
      if (existing) existing.remove();
    }
  }

  // ---- Recall Button (Pro) ----

  function ensureRecallButton() {
    if (!_proEnabled || !bodyEl) return;
    if (document.getElementById("gra-recall-btn")) return;

    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "gra-recall-btn";
    btn.className = "gra-sidebar-nav__recall-btn";
    btn.textContent = "\uD83E\uDDE0 喚醒記憶";
    btn.title = "召回核心錨點：優先同步專案基點，校準 AI 認知方向";
    btn.style.display = "none";
    btn.addEventListener("click", async function () {
      var convKey = detectConversationKey();
      var pins = await GRAStorage.getMemoryPins(convKey);
      if (!pins.length) return;

      // Opt-2: Sort by type weight — core goals first, then phase conclusions
      var sorted = pins.slice().sort(function (a, b) {
        var w = { core: 1, phase: 2 };
        return (w[a.type] || 2) - (w[b.type] || 2);
      });

      var segments = sorted.map(function (p, i) {
        var prefix = p.type === "core" ? "[CRITICAL PROJECT BASEPOINT] " : "[Phase Consensus] ";
        return (i + 1) + ". " + prefix + p.text;
      });
      var prompt =
        "以下是本專案的核心錨點與階段共識。標記為 [CRITICAL PROJECT BASEPOINT] 的項目是不可偏離的決策基點，請在後續所有回答中嚴格遵守：\n\n" +
        segments.join("\n\n") +
        "\n\n請確認你已校準以上基點，然後基於此框架繼續回答。";
      GeminiInputIntegrationModule.insertTextIntoInput(prompt);
    });

    bodyEl.appendChild(btn);
  }

  async function updateRecallButton() {
    var btn = document.getElementById("gra-recall-btn");
    if (!btn) return;
    var convKey = detectConversationKey();
    var pins = await GRAStorage.getMemoryPins(convKey);
    btn.style.display = pins.length > 0 ? "block" : "none";
    var coreCount = pins.filter(function (p) { return p.type === "core"; }).length;
    var label = "\uD83E\uDDE0 喚醒記憶 (" + pins.length + ")";
    if (coreCount > 0) label += " · " + coreCount + " 核心";
    btn.textContent = label;
  }

  function rebuildNavigation() {
    GraReadingPhase1Ux.clearFocusForRebuild();
    GraReadingPhase1Ux.ensureCollapsedExpandClickDelegate();

    const messageElements = findMessageElements();
    if (!messageElements.length) {
      // 若找不到任何訊息，則隱藏整個側邊欄容器，以避免留下空白盒子。
      if (listEl) {
        listEl.textContent = "";
      }
      if (container) {
        container.style.display = "none";
      }
      items = [];
      GRA_DEBUG && console.info("[GRA][sidebar] Sidebar hidden because no message elements were found.");
      return;
    }

    ensureContainer();

    // 一旦重新找到訊息，恢復顯示容器。
    if (container) {
      container.style.display = "";
    }

    listEl.textContent = "";
    items = [];

    messageElements.forEach((node, index) => {
      const id =
        node.getAttribute("data-gra-message-id") || `gra-message-${index + 1}`;
      node.setAttribute("data-gra-message-id", id);
      GraReadingPhase1Ux.ensureGraMessage(node);

      const msgType = detectMessageType(node, messageElements);
      runCondenseV75(node, msgType);
      finalizeMessage(node, msgType);
      const label = buildLabelFromMessage(node, index);
      const tooltipData = buildTooltipContent(node, msgType);

      const rowEl = document.createElement("div");
      rowEl.className = "gra-sidebar-nav__item-row";

      const collapseBtn = document.createElement("button");
      collapseBtn.type = "button";
      collapseBtn.className = "gra-sidebar-nav__item-collapse";
      collapseBtn.textContent = "▶";
      collapseBtn.title = "收合／展開此訊息（僅版面）";
      collapseBtn.setAttribute("aria-label", "收合或展開此訊息");
      collapseBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        GraReadingPhase1Ux.toggleCollapse(node);
      });

      const itemEl = document.createElement("button");
      itemEl.type = "button";
      itemEl.className = "gra-sidebar-nav__item";
      itemEl.textContent = label;

      itemEl.addEventListener("mouseenter", () => {
        showTooltipForItem(itemEl, tooltipData);
      });
      itemEl.addEventListener("mouseleave", () => {
        hideTooltip();
      });

      itemEl.addEventListener("click", () => {
        scrollToMessageTop(node, msgType);
        GraReadingPhase1Ux.toggleFocus(node);
      });

      rowEl.appendChild(collapseBtn);
      rowEl.appendChild(itemEl);

      // ---- Pro: Condense button (Gemini messages only) ----
      if (msgType === "gemini" && _proEnabled) {
        var condenseBtn = document.createElement("button");
        condenseBtn.type = "button";
        condenseBtn.className = "gra-sidebar-nav__condense-btn";
        condenseBtn.textContent = "濃";
        condenseBtn.title = "批判性濃縮：檢索邏輯漏洞、驅逐認知偏差、鎖定決策基點";
        condenseBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          var text = __gra_getSourceText(node);
          if (!text || text.length < 30) return;
          var defaultPrompt = "請用 3-5 個重點濃縮以下內容。特別要求：請找出文中潛在的邏輯漏洞、被忽略的反面因素，並列出對我最有利的決策基點：";
          var userPrompt = (_moduleSettings && _moduleSettings.proCondensePrompt)
            ? _moduleSettings.proCondensePrompt
            : defaultPrompt;
          var prompt = userPrompt + "\n---\n" + text + "\n---";
          GeminiInputIntegrationModule.insertTextIntoInput(prompt);

          if (_moduleSettings && _moduleSettings.proAutoSend) {
            setTimeout(function () {
              var sendBtn = document.querySelector(
                GRASelectors.SEND_BUTTON
              );
              if (sendBtn) sendBtn.click();
            }, 200);
          }
        });
        rowEl.appendChild(condenseBtn);
      }

      // ---- Pro: Memory Pin button (three-state cycle) ----
      // Click cycle: unpinned → phase (blue 📌) → core (gold 📌) → remove
      if (_proEnabled) {
        var pinBtn = document.createElement("button");
        pinBtn.type = "button";
        pinBtn.className = "gra-sidebar-nav__pin-btn";
        pinBtn.title = "點擊校準錨點：階段共識 → 核心基點 → 解除";

        // Check existing pin state for this message
        (async function () {
          var convKey = detectConversationKey();
          var pins = await GRAStorage.getMemoryPins(convKey);
          var text = __gra_getSourceText(node);
          var summary = text.length > 200 ? text.slice(0, 197) + "..." : text;
          var existing = pins.find(function (p) { return p.text === summary || p.sourceMessageId === id; });
          if (existing && existing.type === "core") {
            pinBtn.textContent = "\uD83D\uDCCC";
            pinBtn.classList.add("gra-sidebar-nav__pin-btn--core");
          } else if (existing) {
            pinBtn.textContent = "\uD83D\uDCCC";
            pinBtn.classList.add("gra-sidebar-nav__pin-btn--phase");
          } else {
            pinBtn.textContent = "\uD83D\uDCCC";
          }
        })();

        pinBtn.addEventListener("click", async function (e) {
          e.stopPropagation();
          var text = __gra_getSourceText(node);
          var summary = text.length > 200 ? text.slice(0, 197) + "..." : text;
          var convKey = detectConversationKey();
          var pins = await GRAStorage.getMemoryPins(convKey);
          var existing = pins.find(function (p) { return p.text === summary || p.sourceMessageId === id; });

          if (!existing) {
            // State 1: Not pinned → add as phase
            await GRAStorage.addMemoryPin(convKey, {
              text: summary,
              sourceMessageId: id,
              type: "phase"
            });
            pinBtn.classList.remove("gra-sidebar-nav__pin-btn--core");
            pinBtn.classList.add("gra-sidebar-nav__pin-btn--phase");
          } else if (existing.type === "phase") {
            // State 2: Phase → upgrade to core
            existing.type = "core";
            await GRAStorage.saveMemoryPins(convKey, pins);
            pinBtn.classList.remove("gra-sidebar-nav__pin-btn--phase");
            pinBtn.classList.add("gra-sidebar-nav__pin-btn--core");
          } else {
            // State 3: Core → remove pin
            await GRAStorage.removeMemoryPin(convKey, existing.id);
            pinBtn.classList.remove("gra-sidebar-nav__pin-btn--core", "gra-sidebar-nav__pin-btn--phase");
          }
          updateRecallButton();
        });
        rowEl.appendChild(pinBtn);
      }

      listEl.appendChild(rowEl);
      items.push({
        id,
        navEl: itemEl,
        rowEl,
        targetEl: node,
        summary: tooltipData.summary,
        messageType: msgType
      });
    });

    const counts = { gemini: 0, user: 0, unknown: 0 };
    for (const it of items) counts[it.messageType] = (counts[it.messageType] || 0) + 1;
    GRA_DEBUG && console.info("[GRA][sidebar] message type counts:", counts);

    applyFilter();
    updateActiveItem();
    ensureUsageMeter();
    updateUsageMeter();
    ensureRecallButton();
    updateRecallButton();
  }

  /**
   * 以 debounce 方式排程重新掃描 DOM。
   */
  /** 一般重新掃描延遲；串流時 childList 連續觸發會改用較長延遲，避免 findMessageElements 搶占主執行緒。 */
  const RESCAN_DEBOUNCE_MS = 250;
  const RESCAN_DEBOUNCE_STREAMING_MS = 750;
  const RESCAN_BURST_THRESHOLD = 10;

  function scheduleRescan() {
    if (rescanTimer) {
      clearTimeout(rescanTimer);
    }
    rescanMutationBurstWeight = Math.min(rescanMutationBurstWeight + 1, 80);
    const debounceMs =
      rescanMutationBurstWeight > RESCAN_BURST_THRESHOLD
        ? RESCAN_DEBOUNCE_STREAMING_MS
        : RESCAN_DEBOUNCE_MS;
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      rescanMutationBurstWeight = 0;
      rebuildNavigation();
    }, debounceMs);
  }

  /**
   * 根據視窗中心位置計算最接近的訊息，並高亮對應側邊欄節點。
   * 會略過被篩選隱藏的節點。
   */
  function updateActiveItem() {
    if (!items.length || !listEl) return;

    const viewportTop = 0;
    const viewportBottom = window.innerHeight || document.documentElement.clientHeight;
    const viewportCenter = (viewportTop + viewportBottom) / 2;

    let best = null;

    for (const item of items) {
      const shell = item.rowEl || item.navEl;
      if (shell && shell.style.display === "none") continue;
      const rect = item.targetEl.getBoundingClientRect();
      if (rect.height === 0) continue;

      // 只考慮目前在視窗附近的訊息。
      if (rect.bottom < viewportTop || rect.top > viewportBottom) continue;

      const center = rect.top + rect.height / 2;
      const distance = Math.abs(center - viewportCenter);

      if (!best || distance < best.distance) {
        best = { distance, item };
      }
    }

    items.forEach(({ navEl }) => {
      navEl.classList.remove("gra-sidebar-nav__item--active");
    });

    if (best && best.item && best.item.navEl) {
      best.item.navEl.classList.add("gra-sidebar-nav__item--active");

      // 若選中的節點已經被側邊欄裁切，則自動捲動到可見範圍。
      const itemRect = best.item.navEl.getBoundingClientRect();
      const listRect = listEl.getBoundingClientRect();
      if (itemRect.top < listRect.top || itemRect.bottom > listRect.bottom) {
        best.item.navEl.scrollIntoView({ block: "nearest" });
      }
    }
  }

  /**
   * scroll / resize 事件處理，使用 requestAnimationFrame 以達到 throttle 效果。
   */
  function handleScrollOrResize() {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
      updateActiveItem();
      scrollTicking = false;
    });
  }

  /**
   * 啟用 MutationObserver 監聽對話內容變化。
   * 若無法取得明確 root，則退回監聽 document.body。
   */
  function startObserver() {
    if (observer) return;

    // 盡量只監聽對話根（常為 chat scroll 容器），少監聽整個 main，降低與串流無關區塊的突變噪音。
    const root = findConversationRootContainer();
    const target =
      root && root.nodeType === Node.ELEMENT_NODE ? root : document.body;
    if (!target) return;

    observer = new MutationObserver(() => {
      scheduleRescan();
    });

    observer.observe(target, {
      subtree: true,
      childList: true
      // 不監聽 characterData / attributes，避免逐字元文字更新打爆 callback（多數由 childList 已足夠觸發重建）
    });
  }

  /**
   * 停用 MutationObserver 並清除計時器。
   */
  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (rescanTimer) {
      clearTimeout(rescanTimer);
      rescanTimer = null;
    }
    rescanMutationBurstWeight = 0;
  }

  /**
   * 開發用：收集最外層 turn wrapper 候選（不含被其他候選包住的內層）。
   */
  function collectOutermostTurnWrappersForInspect(root, maxWrappers) {
    const candidates = [];
    const seen = new Set();
    try {
      const nodes = root.querySelectorAll("div, section, article, [role='listitem']");
      nodes.forEach((el) => {
        if (seen.has(el)) return;
        if (isConversationTurnWrapper(el, root)) {
          candidates.push(el);
          seen.add(el);
        }
      });
    } catch (_) {}

    const outermost = candidates.filter(
      (w) => !candidates.some((o) => o !== w && o.contains(w))
    );
    outermost.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return outermost.slice(0, maxWrappers);
  }

  /**
   * 單節點摘要（供 DOM 探查；不影響 Sidebar 行為）。
   */
  function summarizeInspectNode(el, depth) {
    const text = (el.textContent || "").trim();
    const textLen = text.length;
    const cn = el.className;
    const className =
      typeof cn === "string"
        ? cn.slice(0, 140)
        : String(cn?.baseVal ?? "").slice(0, 80);

    const dataAttrs = {};
    if (el.attributes) {
      for (let i = 0; i < el.attributes.length; i++) {
        const a = el.attributes[i];
        if (a.name.startsWith("data-")) {
          dataAttrs[a.name] = String(a.value).slice(0, 96);
        }
      }
    }

    const structural = {
      hasP: !!el.querySelector(":scope p, p"),
      hasPre: !!el.querySelector("pre"),
      hasBlockquote: !!el.querySelector("blockquote"),
      hasUlOl: !!el.querySelector("ul, ol"),
      hasTable: !!el.querySelector("table"),
      buttonCount: 0,
      hasToolbarOrMenu:
        !!el.querySelector("[role='toolbar'], [role='menu'], [role='menubar']"),
      hasAvatarLike: !!el.querySelector(
        'img[alt*="avatar" i], img[src*="googleusercontent"], [class*="avatar" i]'
      ),
      hasHeading: !!el.querySelector("h1,h2,h3,h4,h5,h6"),
      hasCitationLike: !!el.querySelector(
        "cite, sup, [class*='citation' i], [class*='source' i], [data-source]"
      )
    };
    try {
      structural.buttonCount = Math.min(el.querySelectorAll("button").length, 40);
    } catch (_) {}

    const hints = { likelyUser: [], likelyGemini: [] };

    const classifyAuthorAttr = (raw) => {
      const lower = (raw || "").toLowerCase();
      if (/(^|[^a-z])(user|human|1)([^a-z]|$)/i.test(lower))
        hints.likelyUser.push("attr-author-user");
      if (/(model|assistant|gemini|2)/i.test(lower))
        hints.likelyGemini.push("attr-author-model");
    };

    classifyAuthorAttr(
      el.getAttribute("data-author") || el.getAttribute("data-message-author")
    );
    try {
      el.querySelectorAll("[data-author], [data-message-author]").forEach((n) => {
        classifyAuthorAttr(
          n.getAttribute("data-author") || n.getAttribute("data-message-author")
        );
      });
    } catch (_) {}

    const dataQa = el.getAttribute("data-qa") || dataAttrs["data-qa"];
    if (dataQa) {
      if (/user|human|prompt|input|query|question/i.test(dataQa))
        hints.likelyUser.push(`data-qa:${dataQa}`);
      if (/model|assistant|response|output|answer|bot/i.test(dataQa))
        hints.likelyGemini.push(`data-qa:${dataQa}`);
    }

    const tagU = el.tagName ? el.tagName.toUpperCase() : "";
    if (tagU === "USER-QUERY") {
      hints.likelyUser.push("tag:USER-QUERY");
    }
    if (isHighTrustModelComponentTagElement(el)) {
      hints.likelyGemini.push(`tag:${tagU}`);
    }

    if (textLen > 0 && textLen < 420 && structural.hasP && !structural.hasPre) {
      hints.likelyUser.push("heuristic-short+p-no-pre");
    }
    if (textLen > 550 && (structural.hasPre || structural.hasTable || structural.hasUlOl)) {
      hints.likelyGemini.push("heuristic-long+rich-markup");
    }

    hints.likelyUser = [...new Set(hints.likelyUser)].slice(0, 12);
    hints.likelyGemini = [...new Set(hints.likelyGemini)].slice(0, 12);

    return {
      depth,
      tag: el.tagName,
      className,
      id: el.id ? el.id.slice(0, 80) : "",
      role: el.getAttribute("role") || "",
      ariaLabel: (el.getAttribute("aria-label") || "").slice(0, 100),
      dataAttrs,
      textLen,
      textPreview: text.replace(/\s+/g, " ").slice(0, 96),
      childElementCount: el.children.length,
      structural,
      hints
    };
  }

  /**
   * BFS 掃描 wrapper 子樹，收集帶訊號的節點（開發用）。
   */
  function bfsInspectTurnWrapperDescendants(wrapper, maxNodes) {
    const results = [];
    const queue = [{ el: wrapper, depth: 0 }];
    const maxDepth = 14;

    while (queue.length && results.length < maxNodes) {
      const item = queue.shift();
      const el = item.el;
      const depth = item.depth;
      if (!(el instanceof HTMLElement)) continue;
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;

      if (depth > 0) {
        const tl = (el.textContent || "").trim().length;
        const summary = summarizeInspectNode(el, depth);
        const hasSignal =
          Object.keys(summary.dataAttrs).length > 0 ||
          tl >= 28 ||
          summary.role ||
          summary.id ||
          summary.structural.hasP ||
          summary.structural.hasPre ||
          summary.structural.hasUlOl ||
          summary.hints.likelyUser.length > 0 ||
          summary.hints.likelyGemini.length > 0;
        if (hasSignal) results.push({ el, ...summary });
      }

      if (depth >= maxDepth) continue;
      Array.from(el.children).forEach((child) => {
        if (child instanceof HTMLElement) queue.push({ el: child, depth: depth + 1 });
      });
    }

    return results;
  }

  /** inspect：user-only 清單收斂為「不含其他 user-only 子代的最深候選」。 */
  function filterInspectHintsToDeepest(rows) {
    return rows.filter(
      (row) => !rows.some((other) => other !== row && row.el.contains(other.el))
    );
  }

  function stripElFromInspectRow(row) {
    const { el: _omit, ...rest } = row;
    return rest;
  }

  /**
   * 開發用：探查 turn wrapper 內 DOM 層級與 user/gemini 線索（不改 Sidebar 行為）。
   * @param {{ maxWrappers?: number, maxDescendantsPerWrapper?: number }} [options]
   */
  function runTurnDomInspect(options) {
    const opts = options || {};
    const maxWrappers = Math.min(Math.max(opts.maxWrappers ?? 5, 1), 12);
    const maxDesc = Math.min(Math.max(opts.maxDescendantsPerWrapper ?? 55, 12), 140);

    const root = findConversationRootContainer();
    if (!root) {
      return {
        ok: false,
        error: "no-conversation-root",
        generatedAt: new Date().toISOString()
      };
    }

    let wrappers = collectOutermostTurnWrappersForInspect(root, maxWrappers);

    if (wrappers.length === 0) {
      const seen = new Set();
      const merged = [];
      [
        () => Array.from(root.querySelectorAll("[data-message-id]")),
        () =>
          Array.from(
            root.querySelectorAll("[data-qa='message'], [data-qa='conversation-turn']")
          )
      ].forEach((fn) => {
        fn().forEach((n) => {
          if (n && n instanceof HTMLElement && !seen.has(n)) {
            seen.add(n);
            merged.push(n);
          }
        });
      });
      const documentOrder = (a, b) => {
        const pos = a.compareDocumentPosition(b);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      };
      wrappers = merged
        .filter(
          (n) =>
            containsUserAndGeminiMixedText(n) &&
            (n.textContent || "").trim().length >= 400
        )
        .sort(documentOrder)
        .slice(0, maxWrappers);
    }

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      disclaimer:
        "此物件僅反映「當下頁面」DOM。本環境無法代你讀取即時 Gemini；請在瀏覽器執行本函式取得真實結構。",
      root: {
        tag: root.tagName,
        className:
          typeof root.className === "string" ? root.className.slice(0, 120) : ""
      },
      turnWrapperCount: wrappers.length,
      wrappers: []
    };

    wrappers.forEach((w, i) => {
      const wtext = (w.textContent || "").trim();
      const rawDesc = bfsInspectTurnWrapperDescendants(w, maxDesc);
      const descendantCandidates = rawDesc.map((row) => stripElFromInspectRow(row));

      const userOnlyRaw = rawDesc.filter(
        (d) => d.hints.likelyUser.length > 0 && d.hints.likelyGemini.length === 0
      );
      const geminiOnlyRaw = rawDesc.filter(
        (d) => d.hints.likelyGemini.length > 0 && d.hints.likelyUser.length === 0
      );
      const userOnly = filterInspectHintsToDeepest(userOnlyRaw);
      const geminiOnly = filterInspectHintsToDeepest(geminiOnlyRaw);
      const ambiguous = rawDesc
        .filter(
          (d) => d.hints.likelyUser.length > 0 && d.hints.likelyGemini.length > 0
        )
        .map((row) => stripElFromInspectRow(row));

      report.wrappers.push({
        index: i,
        tag: w.tagName,
        className:
          typeof w.className === "string" ? w.className.slice(0, 180) : "",
        id: w.id || "",
        role: w.getAttribute("role") || "",
        textLen: wtext.length,
        textPreview: wtext.replace(/\s+/g, " ").slice(0, 120),
        isConversationTurnWrapper: isConversationTurnWrapper(w, root),
        containsMixedUserGeminiText: containsUserAndGeminiMixedText(w),
        descendantCandidatesReturned: descendantCandidates.length,
        descendantCandidates,
        nodesHintedUserOnly: userOnly.map((d) => ({
          depth: d.depth,
          tag: d.tag,
          className: d.className,
          textPreview: d.textPreview,
          dataAttrs: d.dataAttrs,
          reasons: d.hints.likelyUser
        })),
        nodesHintedGeminiOnly: geminiOnly.map((d) => ({
          depth: d.depth,
          tag: d.tag,
          className: d.className,
          textPreview: d.textPreview,
          dataAttrs: d.dataAttrs,
          reasons: d.hints.likelyGemini
        })),
        nodesHintedAmbiguous: ambiguous
      });
    });

    return report;
  }

  return {
    /**
     * 初始化側邊導覽模組，必要時會建立 DOM 容器、掃描訊息並綁定事件。
     */
    init(settings) {
      _moduleSettings = settings || _moduleSettings;
      if (settings && settings._proEnabled !== undefined) _proEnabled = !!settings._proEnabled;
      GRA_DEBUG && console.info("[GRA][sidebar] init called", {
        extensionEnabled: settings ? settings.extensionEnabled : undefined,
        showNavigator: settings ? settings.showNavigator : undefined,
        supported: isSupportedGeminiPage(),
        pathname: window.location.pathname
      });
      if (!isSupportedGeminiPage()) return;
      if (!settings || !settings.extensionEnabled || !settings.showNavigator) {
        return;
      }
      if (container) {
        // 已存在容器時只需重新掃描與更新，不重複插入，並確保監聽仍然啟用。
        rebuildNavigation();
        startObserver();
        return;
      }

      ensureContainer();
      rebuildNavigation();
      startObserver();

      window.addEventListener("scroll", handleScrollOrResize, {
        passive: true
      });
      window.addEventListener("resize", handleScrollOrResize);
    },

    /**
     * 銷毀側邊導覽模組，移除 DOM、事件與監聽器。
     */
    destroy() {
      GRA_DEBUG && console.info("[GRA][sidebar] Sidebar destroyed.");
      GraReadingPhase1Ux.clearFocusForRebuild();
      stopObserver();
      items = [];
      if (collapseTimer) {
        clearTimeout(collapseTimer);
        collapseTimer = null;
      }

      if (container && container.parentNode) {
        container.removeEventListener("mouseenter", handleMouseEnter);
        container.removeEventListener("mouseleave", handleMouseLeave);
        container.parentNode.removeChild(container);
      }
      hideTooltip();
      if (tooltipEl && tooltipEl.parentNode) {
        tooltipEl.parentNode.removeChild(tooltipEl);
      }
      container = null;
      handleEl = null;
      bodyEl = null;
      toolbarEl = null;
      listEl = null;
      tooltipEl = null;

      window.removeEventListener("scroll", handleScrollOrResize);
      window.removeEventListener("resize", handleScrollOrResize);
    },

    /**
     * 根據最新設定更新側邊導覽狀態。
     * - 當 extension 或 navigator 關閉時，會銷毀導覽列。
     * - 當重新開啟時，如果容器不存在則會重新初始化；若存在則重新掃描。
     */
    update(settings) {
      _moduleSettings = settings || _moduleSettings;
      if (settings && settings._proEnabled !== undefined) _proEnabled = !!settings._proEnabled;
      if (!settings || !settings.extensionEnabled || !settings.showNavigator) {
        this.destroy();
      } else if (!container) {
        this.init(settings);
      } else {
        // Pro toggle may have changed — immediately remove Pro-only DOM elements
        if (!_proEnabled) {
          var meter = document.getElementById("gra-usage-meter");
          if (meter) meter.remove();
          var recall = document.getElementById("gra-recall-btn");
          if (recall) recall.remove();
          // Remove condense + pin buttons from existing rows immediately (don't wait for rescan debounce)
          if (listEl) {
            listEl.querySelectorAll(".gra-sidebar-nav__condense-btn, .gra-sidebar-nav__pin-btn")
              .forEach(function (b) { b.remove(); });
          }
        }
        scheduleRescan();
      }
    },

    getDiagnostics() {
      return {
        initialized: !!container,
        messageCount: items.length,
        strategy: lastStrategy
      };
    },

    /**
     * 供 ConversationJournal 重用：回傳訊息節點與對應 messageType。
     * 不修改導航邏輯，僅暴露既有掃描結果。
     */
    getMessageElementsWithTypes() {
      const nodes = findMessageElements();
      return nodes.map((node) => ({
        node,
        messageType: detectMessageType(node, nodes)
      }));
    },

    /**
     * 開發用：探查 turn wrapper 內層 DOM（不修改 Sidebar / prune / 分類）。
     */
    inspectTurnStructure(options) {
      return runTurnDomInspect(options);
    }
  };
})();

// Debug bridge functions removed for production

/**
 * 選字後浮動工具列模組。
 *
 * 功能（MVP）：
 * - 只在 Gemini 頁面、且 extensionEnabled & showSelectionToolbar 為真時啟用
 * - 偵測頁面中文字選取（非空）時，在附近顯示浮動工具列
 * - 工具列包含三個按鈕：
 *   - 「加入引用」：先將選取文字輸出到 console，後續接上引用暫存邏輯
 *   - 「解釋這段」：先將模板字串與選取文字輸出到 console，後續接上輸入框整合
 *   - 「複製」：將選取文字複製到剪貼簿
 * - 當選取清空或使用者點擊其他地方時，隱藏工具列
 */
const SelectionToolbarModule = (() => {
  let toolbar = null;

  // 事件處理函式實際會在 init 時綁定，destroy 時解除。
  let selectionHandlerBound = null;
  let mouseDownHandlerBound = null;
  let scrollHandlerBound = null;
  let resizeHandlerBound = null;

  // 目前選取文字與 range，用於重新定位工具列。
  let currentSelectionText = "";
  let currentRange = null;

  /**
   * 建立工具列 DOM 結構，僅建立一次，初始為隱藏狀態。
   */
  function createToolbar() {
    if (toolbar) return toolbar;

    toolbar = document.createElement("div");
    toolbar.className = "gra-selection-toolbar";
    toolbar.style.position = "fixed";
    toolbar.style.top = "0px";
    toolbar.style.left = "0px";
    toolbar.style.display = "none"; // 初始不可見

    const buttonsContainer = document.createElement("div");
    buttonsContainer.className = "gra-selection-toolbar__buttons";

    const row1 = document.createElement("div");
    row1.className = "gra-selection-toolbar__row";

    const btnAddQuote = document.createElement("button");
    btnAddQuote.type = "button";
    btnAddQuote.className = "gra-selection-toolbar__button";
    btnAddQuote.textContent = "引用";
    btnAddQuote.title = "點擊：插入對話框 ｜ Shift+點擊：存入引用暫存庫";
    btnAddQuote.addEventListener("click", handleQuoteClick);

    const btnCopy = document.createElement("button");
    btnCopy.type = "button";
    btnCopy.className = "gra-selection-toolbar__button";
    btnCopy.textContent = "複製";
    btnCopy.addEventListener("click", handleCopyClick);

    row1.appendChild(btnAddQuote);
    row1.appendChild(btnCopy);

    buttonsContainer.appendChild(row1);
    toolbar.appendChild(buttonsContainer);
    document.body.appendChild(toolbar);

    return toolbar;
  }

  /**
   * 取得目前選取資訊：
   * - 非空文字
   * - 第一個 range（若存在）
   */
  function isNodeInsideGraUI(node) {
    if (!node || !(node instanceof Node)) return false;
    if (!(node instanceof HTMLElement) && node.parentElement) {
      node = node.parentElement;
    }
    if (!(node instanceof HTMLElement)) return false;
    return Boolean(
      node.closest(".gra-sidebar-nav") ||
        node.closest(".gra-selection-toolbar") ||
        node.closest(".gra-citation-panel")
    );
  }

  function getCurrentSelectionInfo() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return { text: "", range: null };
    }

    const range = selection.getRangeAt(0);
    if (!range) {
      return { text: "", range: null };
    }

    // 若選取的起點或共同祖先位於插件自己的 UI 內，則不觸發工具列。
    const anchorNode = selection.anchorNode;
    const commonAncestor = range.commonAncestorContainer;
    if (isNodeInsideGraUI(anchorNode) || isNodeInsideGraUI(commonAncestor)) {
      return { text: "", range: null };
    }

    const text = selection.toString().trim();
    if (!text) {
      return { text: "", range: null };
    }

    return { text, range };
  }

  /**
   * 將工具列顯示在指定的 bounding rect 附近。
   * 優先顯示在選取範圍上方，若空間不足則顯示在下方，
   * 並加入左右邊界保護以避免超出 viewport。
   */
  function positionToolbar(rect) {
    if (!toolbar || !rect) return;

    const margin = 8; // 與選取區及視窗邊緣保持的基本間距

    // 先暫時顯示，讓 offsetWidth / offsetHeight 有正確值。
    toolbar.style.display = "block";

    const toolbarWidth = toolbar.offsetWidth || 0;
    const toolbarHeight = toolbar.offsetHeight || 0;
    const viewportWidth =
      window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight;

    // 計算水平位置：以選取範圍中心為基準，並限制在左右邊界內。
    const selectionCenterX = rect.left + rect.width / 2;
    let left = selectionCenterX - toolbarWidth / 2;
    left = Math.max(margin, Math.min(left, viewportWidth - toolbarWidth - margin));

    // 優先放在選取上方，若空間不足則放在下方。
    let top = rect.top - toolbarHeight - margin;
    if (top < margin) {
      top = rect.bottom + margin;
      if (top + toolbarHeight + margin > viewportHeight) {
        // 若上下都放不下，則夾在可視範圍內。
        top = Math.max(margin, viewportHeight / 2 - toolbarHeight / 2);
      }
    }

    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
  }

  /**
   * 顯示工具列並根據目前 range 重新定位。
   */
  function showToolbarForRange(range) {
    if (!toolbar || !range) return;

    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hideToolbar();
      return;
    }

    positionToolbar(rect);
  }

  /**
   * 隱藏工具列並清除目前選取狀態。
   */
  function hideToolbar() {
    if (toolbar) {
      toolbar.style.display = "none";
    }
    currentSelectionText = "";
    currentRange = null;
  }

  /**
   * selectionchange 事件處理：
   * - 有有效選取時，更新狀態並顯示 / 定位工具列
   * - 否則隱藏工具列
   */
  function handleSelectionChange() {
    const { text, range } = getCurrentSelectionInfo();

    if (!text || !range) {
      hideToolbar();
      return;
    }

    currentSelectionText = text;
    currentRange = range;
    showToolbarForRange(range);
  }

  /**
   * mousedown 事件處理：
   * - 若點擊在工具列外部，先讓 selectionchange 處理清空後隱藏
   * - 這裡只在「選取已空」時保險性隱藏工具列
   */
  function handleMouseDown(event) {
    if (toolbar && toolbar.contains(event.target)) {
      // 點擊在工具列上，交由按鈕邏輯處理。
      return;
    }

    // 若之後 selection 被清空，selectionchange 會再觸發。
    // 這裡只是保險起見，在沒有有效選取時立即隱藏。
    const { text } = getCurrentSelectionInfo();
    if (!text) {
      hideToolbar();
    }
  }

  /**
   * scroll / resize 時重新根據目前 range 定位工具列。
   * 若已經沒有有效選取，則隱藏。
   */
  function handleScrollOrResize() {
    if (!currentRange || !currentSelectionText) {
      hideToolbar();
      return;
    }
    showToolbarForRange(currentRange);
  }

  /**
   * 「複製」按鈕：將目前選取文字寫入 clipboard。
   */
  async function handleCopyClick() {
    if (!currentSelectionText) return;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(currentSelectionText);
        GRA_DEBUG && console.info("[GRA][selection-toolbar] Copied to clipboard.");
      } else {
        // 後備機制：透過選取與 execCommand('copy') 嘗試複製。
        const textarea = document.createElement("textarea");
        textarea.value = currentSelectionText;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        GRA_DEBUG && console.info("[GRA][selection-toolbar] Copied to clipboard (fallback).");
      }
    } catch (error) {
      console.warn("[GRA][selection-toolbar] Failed to copy text:", error);
    }
  }

  /**
   * 從選取 range 找到最近的 message/block 容器，沿用 SidebarNavigationModule 的邏輯。
   * 回傳 { sourceUrl, sourceMessageId, sourceTextPreview, sourceSelectorHint } 或 null。
   */
  function findSourceContainerFromRange(range) {
    if (!range || !range.commonAncestorContainer) return null;

    let node =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;

    const main =
      document.querySelector("main[role='main']") ||
      document.querySelector("main") ||
      document.body;

    if (!main || !node || !main.contains(node)) return null;

    const messageSelectors = [
      "[data-gra-message-id]",
      "[data-message-id]",
      "[data-qa='message'], [data-qa='conversation-turn']",
      "[role='listitem'][data-author], [role='listitem'][data-message-author]",
      "article"
    ];

    let container = null;
    for (const sel of messageSelectors) {
      container = node.closest(sel);
      if (container && main.contains(container)) break;
    }

    if (!container) return null;

    let sourceMessageId = container.getAttribute("data-gra-message-id");
    if (!sourceMessageId) {
      sourceMessageId =
        container.getAttribute("data-message-id") ||
        `gra-message-src-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      container.setAttribute("data-gra-message-id", sourceMessageId);
    }

    const sourceTextPreview = (container.textContent || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 80);

    return {
      sourceUrl: window.location.href,
      sourceMessageId,
      sourceTextPreview: sourceTextPreview + (sourceTextPreview.length >= 80 ? "…" : ""),
      sourceSelectorHint: `[data-gra-message-id="${sourceMessageId}"]`
    };
  }

  /**
   * 「引用」按鈕（雙模式）：
   * - 普通點擊：將選取文字直接插入 Gemini 對話框
   * - Shift+點擊：將選取文字存入引用暫存庫（Knowledge Cards）
   */
  function handleQuoteClick(event) {
    if (!currentSelectionText) return;

    if (event.shiftKey) {
      // Shift+點擊：存入引用暫存庫
      const source =
        currentRange && findSourceContainerFromRange(currentRange);

      CitationClipboardModule.addQuote({
        text: currentSelectionText,
        sourceUrl: source?.sourceUrl,
        sourceMessageId: source?.sourceMessageId,
        sourceTextPreview: source?.sourceTextPreview,
        sourceSelectorHint: source?.sourceSelectorHint
      });
    } else {
      // 普通點擊：以引用模板插入 Gemini 對話框
      const template =
        GeminiInputIntegrationModule.buildQuoteTemplate(currentSelectionText);
      GeminiInputIntegrationModule.insertTextIntoInput(template);
    }
    hideToolbar();
  }

  /**
   * 綁定所有需要的事件監聽，避免重複綁定。
   */
  function bindEvents() {
    if (!selectionHandlerBound) {
      selectionHandlerBound = handleSelectionChange;
      document.addEventListener("selectionchange", selectionHandlerBound);
    }
    if (!mouseDownHandlerBound) {
      mouseDownHandlerBound = handleMouseDown;
      document.addEventListener("mousedown", mouseDownHandlerBound, true);
    }
    if (!scrollHandlerBound) {
      scrollHandlerBound = handleScrollOrResize;
      window.addEventListener("scroll", scrollHandlerBound, { passive: true });
    }
    if (!resizeHandlerBound) {
      resizeHandlerBound = handleScrollOrResize;
      window.addEventListener("resize", resizeHandlerBound);
    }
  }

  /**
   * 解除所有事件監聽。
   */
  function unbindEvents() {
    if (selectionHandlerBound) {
      document.removeEventListener("selectionchange", selectionHandlerBound);
      selectionHandlerBound = null;
    }
    if (mouseDownHandlerBound) {
      document.removeEventListener("mousedown", mouseDownHandlerBound, true);
      mouseDownHandlerBound = null;
    }
    if (scrollHandlerBound) {
      window.removeEventListener("scroll", scrollHandlerBound);
      scrollHandlerBound = null;
    }
    if (resizeHandlerBound) {
      window.removeEventListener("resize", resizeHandlerBound);
      resizeHandlerBound = null;
    }
  }

  return {
    init(settings) {
      if (!settings.extensionEnabled || !settings.showSelectionToolbar) return;
      if (!isSupportedGeminiPage()) return;

      createToolbar();
      bindEvents();
    },
    destroy() {
      unbindEvents();
      hideToolbar();
      if (toolbar && toolbar.parentNode) {
        toolbar.parentNode.removeChild(toolbar);
      }
      toolbar = null;
    },
    update(settings) {
      if (!settings.showSelectionToolbar || !settings.extensionEnabled) {
        this.destroy();
      } else if (!toolbar) {
        this.init(settings);
      }
    },

    getDiagnostics() {
      return { initialized: !!toolbar };
    }
  };
})();

/**
 * 引用暫存夾模組。
 *
 * 功能：
 * - 建立右下角固定引用面板
 * - 支援加入、刪除、清空引用
 * - 引用資料同步寫入 chrome.storage.local
 * - 去重：相同 text 不重複加入
 * - 初始化時從 storage 載入並 render
 *
 * 啟用條件：
 * - settings.extensionEnabled === true
 * - settings.showQuotePanel === true
 * - isSupportedGeminiPage() === true
 *
 * 引用資料格式：{ id: string, text: string, createdAt: number }
 */
const CitationClipboardModule = (() => {
  let panel = null;
  let listEl = null;
  let insertAllBtn = null;
  let insertSelectedBtn = null;

  // 勾選狀態，僅本次 session，不寫入 storage
  let selectedQuoteIds = new Set();

  // ---- Selection helpers -------------------------------------------------

  function toggleQuoteSelection(id) {
    if (selectedQuoteIds.has(id)) {
      selectedQuoteIds.delete(id);
    } else {
      selectedQuoteIds.add(id);
    }
  }

  function selectAllQuotes(quotes) {
    if (!quotes || !quotes.length) return;
    quotes.forEach((q) => selectedQuoteIds.add(q.id));
  }

  function clearQuoteSelection() {
    selectedQuoteIds.clear();
  }

  function getSelectedQuotes(quotes) {
    if (!quotes || !quotes.length) return [];
    return quotes.filter((q) => selectedQuoteIds.has(q.id));
  }

  function syncSelectionWithQuotes(quotes) {
    if (!quotes || quotes.length === 0) {
      clearQuoteSelection();
      return;
    }
    const ids = new Set(quotes.map((q) => q.id));
    selectedQuoteIds.forEach((id) => {
      if (!ids.has(id)) selectedQuoteIds.delete(id);
    });
  }

  // ---- DOM 建立 -------------------------------------------------------

  /**
   * 建立面板 DOM 結構（僅建立一次）。
   * 結構：
   * <div class="gra-citation-panel">
   *   <div class="gra-citation-panel__header">
   *     <span class="gra-citation-panel__title">引用暫存</span>
   *     <button class="...">清空</button>
   *   </div>
   *   <div class="gra-citation-panel__body">...</div>
   * </div>
   */
  function createPanel() {
    if (panel) return panel;

    panel = document.createElement("div");
    panel.className = "gra-citation-panel";

    const header = document.createElement("div");
    header.className = "gra-citation-panel__header";

    const title = document.createElement("span");
    title.className = "gra-citation-panel__title";
    title.textContent = "引用暫存";

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className =
      "gra-citation-panel__button gra-citation-panel__button--secondary";
    clearBtn.textContent = "清空全部";
    clearBtn.addEventListener("click", clearAllQuotes);

    header.appendChild(title);
    header.appendChild(clearBtn);

    listEl = document.createElement("div");
    listEl.className = "gra-citation-panel__body";

    const footer = document.createElement("div");
    footer.className = "gra-citation-panel__footer";

    insertAllBtn = document.createElement("button");
    insertAllBtn.type = "button";
    insertAllBtn.className = "gra-citation-panel__button";
    insertAllBtn.textContent = "全部插入";
    insertAllBtn.title = "將全部引用合併插入 Gemini 輸入框";
    insertAllBtn.disabled = true;
    insertAllBtn.addEventListener("click", () => insertAllQuotes());

    insertSelectedBtn = document.createElement("button");
    insertSelectedBtn.type = "button";
    insertSelectedBtn.className = "gra-citation-panel__button";
    insertSelectedBtn.textContent = "插入勾選";
    insertSelectedBtn.title = "將勾選的引用合併插入 Gemini 輸入框";
    insertSelectedBtn.disabled = true;
    insertSelectedBtn.addEventListener("click", () => insertSelectedQuotes());

    const selectAllBtn = document.createElement("button");
    selectAllBtn.type = "button";
    selectAllBtn.className =
      "gra-citation-panel__button gra-citation-panel__button--secondary";
    selectAllBtn.textContent = "全選";
    selectAllBtn.title = "全選所有引用";
    selectAllBtn.addEventListener("click", async () => {
      const quotes = await GRAStorage.getQuotes();
      selectAllQuotes(quotes);
      renderQuotes(quotes);
    });

    const clearSelectBtn = document.createElement("button");
    clearSelectBtn.type = "button";
    clearSelectBtn.className =
      "gra-citation-panel__button gra-citation-panel__button--secondary";
    clearSelectBtn.textContent = "取消全選";
    clearSelectBtn.title = "取消所有勾選";
    clearSelectBtn.addEventListener("click", async () => {
      clearQuoteSelection();
      renderQuotes(await GRAStorage.getQuotes());
    });

    footer.appendChild(insertSelectedBtn);
    footer.appendChild(insertAllBtn);
    footer.appendChild(selectAllBtn);
    footer.appendChild(clearSelectBtn);

    panel.appendChild(header);
    panel.appendChild(listEl);
    panel.appendChild(footer);
    // 初始為空狀態（小標籤），loadAndRenderQuotes 後會更新
    panel.classList.add("gra-citation-panel--empty");
    document.body.appendChild(panel);

    return panel;
  }

  // ---- 多段引用合併 ----------------------------------------------------

  /**
   * 建立多段引用合併模板字串。
   * @param {Array} quotes - 引用陣列
   * @returns {string|null} 模板字串，空陣列時回傳 null
   */
  function buildCombinedQuotesTemplate(quotes) {
    if (!quotes || quotes.length === 0) return null;

    const segments = quotes.map((q, i) => {
      const src = q.source ? `（來源：${q.source}）` : "";
      return `[引用 ${i + 1}]${src}\n「${q.text}」`;
    });
    return (
      "以下是我引用的幾段內容：\n\n" +
      segments.join("\n\n") +
      "\n\n請根據這些引用內容回答我接下來的問題："
    );
  }

  /**
   * 將目前全部引用合併插入 Gemini 輸入框。
   */
  async function insertAllQuotes() {
    const quotes = await GRAStorage.getQuotes();
    if (!quotes || quotes.length === 0) {
      console.warn("[GRA][citation] No quotes to insert.");
      return;
    }
    const template = buildCombinedQuotesTemplate(quotes);
    if (!template) return;
    GeminiInputIntegrationModule.insertTextIntoInput(template);
    // 插入後自動清除所有已插入的引用
    await GRAStorage.clearQuotes();
    clearQuoteSelection();
    renderQuotes([]);
  }

  /**
   * 將勾選的引用合併插入 Gemini 輸入框。
   */
  async function insertSelectedQuotes() {
    const quotes = await GRAStorage.getQuotes();
    const selected = getSelectedQuotes(quotes);
    if (!selected.length) {
      console.warn("[GRA][citation] No selected quotes to insert.");
      return;
    }
    const template = buildCombinedQuotesTemplate(selected);
    if (!template) return;
    GeminiInputIntegrationModule.insertTextIntoInput(template);
    // 插入後自動清除已插入的引用
    const selectedIds = new Set(selected.map((q) => q.id));
    const remaining = quotes.filter((q) => !selectedIds.has(q.id));
    await GRAStorage.saveQuotes(remaining);
    clearQuoteSelection();
    renderQuotes(remaining);
  }

  function updateFooterButtons(quotes) {
    if (insertAllBtn) {
      insertAllBtn.disabled = !quotes || quotes.length === 0;
    }
    if (insertSelectedBtn) {
      const selected = getSelectedQuotes(quotes || []);
      insertSelectedBtn.disabled = selected.length === 0;
    }
  }

  // ---- 回跳邏輯 -------------------------------------------------------

  const HIGHLIGHT_DURATION_MS = 1500;

  /**
   * 回跳至引用來源：smooth scroll + 短暫高亮。
   * 僅同頁 pathname 一致時執行，找不到目標則 console.warn。
   */
  function jumpToSource(quote) {
    if (!quote || !quote.sourceUrl) return;

    const currentPath = (window.location.pathname || "").replace(/\/$/, "");
    const sourcePath = (new URL(quote.sourceUrl).pathname || "").replace(/\/$/, "");
    if (currentPath !== sourcePath) {
      console.warn("[GRA][citation] Source URL pathname mismatch, skip jump.");
      return;
    }

    let target = null;
    if (quote.sourceMessageId) {
      target = document.querySelector(
        `[data-gra-message-id="${quote.sourceMessageId}"]`
      );
    }
    if (!target && quote.sourceSelectorHint) {
      try {
        target = document.querySelector(quote.sourceSelectorHint);
      } catch (_) {}
    }

    if (!target || !(target instanceof HTMLElement)) {
      console.warn("[GRA][citation] Source container not found, skip jump.");
      return;
    }

    try {
      target.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "nearest"
      });
    } catch (_) {
      target.scrollIntoView();
    }

    target.classList.add("gra-source-jump-highlight");
    setTimeout(() => {
      target.classList.remove("gra-source-jump-highlight");
    }, HIGHLIGHT_DURATION_MS);
  }

  // ---- 渲染 -----------------------------------------------------------

  /**
   * 以引用陣列重新渲染清單區。
   * 若陣列為空，顯示 empty state。
   */
  function renderQuotes(quotes) {
    if (!listEl || !panel) return;
    listEl.textContent = "";

    syncSelectionWithQuotes(quotes);
    updateFooterButtons(quotes);

    const isEmpty = !quotes || quotes.length === 0;

    // 切換面板狀態 class
    panel.classList.toggle("gra-citation-panel--empty", isEmpty);
    panel.classList.toggle("gra-citation-panel--active", !isEmpty);

    if (isEmpty) {
      return;
    }

    quotes.forEach((quote) => {
      const item = document.createElement("div");
      item.className = "gra-citation-panel__item";
      item.dataset.id = quote.id;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "gra-citation-panel__item-checkbox";
      checkbox.checked = selectedQuoteIds.has(quote.id);
      checkbox.setAttribute("aria-label", `勾選引用 ${quote.id}`);
      checkbox.addEventListener("change", () => {
        toggleQuoteSelection(quote.id);
        updateFooterButtons(quotes);
      });

      const textEl = document.createElement("span");
      textEl.className = "gra-citation-panel__item-text";
      const qtext = String(quote.text || "");
      const preview = qtext.length > 60 ? qtext.slice(0, 59) + "…" : qtext;
      textEl.textContent = preview;
      let tip = qtext;
      if (quote.note) tip += `\n備註：${quote.note}`;
      if (quote.tags && quote.tags.length) tip += `\n標籤：${quote.tags.join(", ")}`;
      textEl.title = tip;

      const insertBtn = document.createElement("button");
      insertBtn.type = "button";
      insertBtn.className = "gra-citation-panel__item-insert";
      insertBtn.textContent = "↑";
      insertBtn.setAttribute("aria-label", "插入 Gemini 輸入框");
      insertBtn.title = "插入輸入框";
      insertBtn.addEventListener("click", () => {
        const template = GeminiInputIntegrationModule.buildQuoteTemplate(quote.text);
        GeminiInputIntegrationModule.insertTextIntoInput(template);
        removeQuote(quote.id);
      });

      item.appendChild(checkbox);
      item.appendChild(textEl);
      item.appendChild(insertBtn);

      if (quote.sourceUrl && (quote.sourceMessageId || quote.sourceSelectorHint)) {
        const jumpBtn = document.createElement("button");
        jumpBtn.type = "button";
        jumpBtn.className = "gra-citation-panel__item-jump";
        jumpBtn.textContent = "↩";
        jumpBtn.setAttribute("aria-label", "回到原文");
        jumpBtn.title = "回到原文";
        jumpBtn.addEventListener("click", () => jumpToSource(quote));
        item.appendChild(jumpBtn);
      }

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "gra-citation-panel__item-delete";
      deleteBtn.textContent = "✕";
      deleteBtn.setAttribute("aria-label", "刪除此引用");
      deleteBtn.addEventListener("click", () => removeQuote(quote.id));

      item.appendChild(deleteBtn);
      listEl.appendChild(item);
    });
  }

  // ---- 資料操作 -------------------------------------------------------

  /**
   * 加入一筆引用。
   * - 可接受字串 text 或物件 { text, sourceUrl?, sourceMessageId?, sourceTextPreview?, sourceSelectorHint? }
   * - 空字串略過
   * - 與現有 text 完全相同時略過（去重）
   * - 成功後同步寫回 storage 並重新 render
   */
  async function addQuote(textOrPayload) {
    const payload =
      typeof textOrPayload === "string"
        ? { text: textOrPayload }
        : textOrPayload || {};
    const text = (payload.text || "").trim();
    if (!text) return;

    const quotes = await GRAStorage.getQuotes();

    const isDuplicate = quotes.some((q) => q.text === text);
    if (isDuplicate) {
      GRA_DEBUG && console.info("[GRA][citation] Duplicate quote skipped:", text);
      return;
    }

    const sourceLabel =
      (payload.source && String(payload.source).trim()) ||
      (payload.sourceTextPreview && String(payload.sourceTextPreview).trim().slice(0, 80)) ||
      "";
    const baseCard =
      typeof GRAStorage.createCard === "function"
        ? GRAStorage.createCard(text, sourceLabel)
        : {
            id: `gra-card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            text,
            source: sourceLabel,
            tags: [],
            note: "",
            createdAt: Date.now()
          };
    const newQuote = {
      ...baseCard,
      sourceUrl: payload.sourceUrl,
      sourceMessageId: payload.sourceMessageId,
      sourceTextPreview: payload.sourceTextPreview,
      sourceSelectorHint: payload.sourceSelectorHint
    };

    quotes.push(newQuote);
    await GRAStorage.saveQuotes(quotes);
    renderQuotes(quotes);
  }

  /**
   * 刪除指定 id 的引用。
   * 刪除後同步寫回 storage 並重新 render。
   */
  async function removeQuote(id) {
    const quotes = await GRAStorage.getQuotes();
    const filtered = quotes.filter((q) => q.id !== id);
    await GRAStorage.saveQuotes(filtered);
    renderQuotes(filtered);
  }

  /**
   * 清空全部引用。
   * 使用 GRAStorage.clearQuotes() 寫回空陣列後重新 render。
   */
  async function clearAllQuotes() {
    await GRAStorage.clearQuotes();
    renderQuotes([]);
  }

  /**
   * 從 storage 讀取引用列表並渲染到面板。
   * 在 init 時呼叫，確保面板顯示最新資料。
   */
  async function loadAndRenderQuotes() {
    const quotes = await GRAStorage.getQuotes();
    renderQuotes(quotes);
  }

  // ---- 公開 API -------------------------------------------------------

  return {
    createPanel,
    renderQuotes,
    addQuote,
    removeQuote,
    clearAllQuotes,
    loadAndRenderQuotes,

    init(settings) {
      if (!settings.extensionEnabled || !settings.showQuotePanel) return;
      if (!isSupportedGeminiPage()) return;
      createPanel();
      loadAndRenderQuotes();
    },

    /**
     * 移除面板 DOM 並清理內部狀態。
     * 不清除 storage 中的引用資料。
     */
    destroy() {
      if (panel && panel.parentNode) {
        panel.parentNode.removeChild(panel);
      }
      panel = null;
      listEl = null;
      insertAllBtn = null;
      insertSelectedBtn = null;
      clearQuoteSelection();
    },

    /**
     * 根據最新設定更新面板狀態。
     * - showQuotePanel 關閉 → 移除面板
     * - 重新開啟 → 重建面板並載入 storage 資料
     */
    update(settings) {
      if (!settings.extensionEnabled || !settings.showQuotePanel) {
        this.destroy();
      } else if (!panel) {
        this.init(settings);
      }
    },

    async getDiagnostics() {
      let quoteCount = 0;
      if (typeof GRAStorage !== "undefined" && GRAStorage.getQuotes) {
        const quotes = await GRAStorage.getQuotes();
        quoteCount = Array.isArray(quotes) ? quotes.length : 0;
      }
      return {
        initialized: !!panel,
        quoteCount
      };
    }
  };
})();

/**
 * 將引用插入 Gemini 輸入框模組。
 *
 * 功能：
 * - 以保守 selector 找到 Gemini 輸入區
 * - 建立固定引用模板字串
 * - 將模板文字附加到輸入框，不自動送出
 * - 同時兼容 contenteditable div 與 textarea
 *
 * 啟用條件：
 * - settings.extensionEnabled === true
 * - settings.showGeminiInputInsertion === true
 * - isSupportedGeminiPage() === true
 */
const GeminiInputIntegrationModule = (() => {
  // 記錄目前是否已啟用，避免在設定關閉時仍執行插入。
  let enabled = false;

  // ---- 輸入框查找 -------------------------------------------------------

  /**
   * 以保守策略尋找 Gemini 輸入區元素。
   *
   * 策略（依優先順序）：
   *
   * 1. rich-textarea div[contenteditable="true"]
   *    Gemini 使用自訂 Web Component <rich-textarea>，
   *    內部包含一個 contenteditable div 作為實際輸入區。
   *    鎖定此 Web Component 的子層可避免誤觸頁面其他 contenteditable。
   *
   * 2. div[contenteditable="true"][data-placeholder]
   *    次選：有 data-placeholder 屬性的 contenteditable，
   *    通常只有 prompt 編輯器才會帶此屬性，誤觸機率低。
   *
   * 3. textarea
   *    後備，若 Gemini 將來改回普通 textarea。
   *
   * 刻意不使用含隨機 hash 的 class 名稱，降低日後壞掉的機率。
   */
  function findInputElement() {
    const el = findInputElementWithType();
    return el ? el.element : null;
  }

  /**
   * 回傳 { element, selectorType } 供 diagnostics 使用。
   */
  function findInputElementWithType() {
    const richTextareaInner = document.querySelector(
      "rich-textarea div[contenteditable='true']"
    );
    if (richTextareaInner)
      return { element: richTextareaInner, selectorType: "rich-textarea-contenteditable" };

    const contenteditableWithPlaceholder = document.querySelector(
      "div[contenteditable='true'][data-placeholder]"
    );
    if (contenteditableWithPlaceholder)
      return { element: contenteditableWithPlaceholder, selectorType: "contenteditable-data-placeholder" };

    const textarea = document.querySelector("textarea");
    if (textarea) return { element: textarea, selectorType: "textarea" };

    return null;
  }

  // ---- 模板建立 ---------------------------------------------------------

  /**
   * 建立固定引用模板字串。
   * @param {string} text - 引用的原始文字
   * @returns {string}
   */
  function buildQuoteTemplate(text) {
    return `我想引用以下這段內容：\n「${text}」\n請根據這段內容回答我接下來的問題：`;
  }

  // ---- 插入邏輯 ---------------------------------------------------------

  function dispatchInputEvents(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * textarea：優先 setRangeText，失敗則 fallback 直接賦值。
   */
  function insertIntoTextarea(el, text) {
    const existing = (el.value || "").trimEnd();
    const toInsert = existing ? "\n\n" + text : text;

    if (typeof el.setRangeText === "function") {
      try {
        const start = existing.length;
        el.setSelectionRange(start, start);
        el.setRangeText(toInsert, start, start, "end");
        el.selectionStart = el.selectionEnd = el.value.length;
        dispatchInputEvents(el);
        return;
      } catch (err) {
        console.warn("[GRA][input] setRangeText failed, fallback to value assignment.", err);
      }
    }

    el.value = existing ? existing + "\n\n" + text : text;
    dispatchInputEvents(el);
  }

  /**
   * contenteditable：優先 Selection API，失敗則 fallback execCommand。
   */
  function insertIntoContentEditable(el, text) {
    const existing = (el.innerText || "").trimEnd();
    const toInsert = existing ? "\n\n" + text : text;

    if (appendTextWithSelectionAPI(el, toInsert)) return;

    console.warn("[GRA][input] Selection API insert failed, fallback to execCommand.");
    appendTextWithExecCommand(el, toInsert);
  }

  /**
   * 使用 Selection API 插入文字。
   */
  function appendTextWithSelectionAPI(el, text) {
    try {
      el.focus();
      const sel = window.getSelection();
      if (!sel) return false;

      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);

      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);

      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 使用 execCommand 插入文字（fallback）。
   */
  function appendTextWithExecCommand(el, text) {
    try {
      el.focus();
      const existing = (el.innerText || "").trimEnd();

      if (existing) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("insertText", false, text);
      } else {
        document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, text);
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (err) {
      console.warn("[GRA][input] execCommand insert failed.", err);
    }
  }

  /**
   * 將文字插入 Gemini 輸入區。
   *
   * 插入策略：附加（append）
   * - 若輸入框已有內容，先補兩個換行（\n\n）後再附加模板。
   * - 若輸入框為空，直接插入模板。
   * - 不自動送出。
   *
   * 多層策略：textarea 優先 setRangeText；contenteditable 優先 Selection API，再 fallback execCommand。
   */
  function insertTextIntoInput(text) {
    if (!enabled) return;

    const el = findInputElement();
    if (!el) {
      console.warn("[GRA][input-integration] 找不到 Gemini 輸入框，無法插入。");
      return;
    }

    if (el.isContentEditable) {
      insertIntoContentEditable(el, text);
    } else {
      insertIntoTextarea(el, text);
    }
  }

  // ---- 公開 API ---------------------------------------------------------

  /**
   * 建立固定解釋模板字串。
   * @param {string} text - 選取的原始文字
   * @returns {string}
   */
  function buildExplainTemplate(text) {
    return `請幫我解釋這段內容，重點說明關鍵概念與上下文意義：\n「${text}」`;
  }

  function buildPlainExplainTemplate(text) {
    return `請用白話方式解釋以下內容，避免術語過多，讓一般人也能看懂：\n\n「${text}」`;
  }

  function buildExampleTemplate(text) {
    return `請針對以下內容提供 2～3 個具體例子，幫助我理解：\n\n「${text}」`;
  }

  function buildBulletSummaryTemplate(text) {
    return `請將以下內容整理成清楚的條列重點：\n\n「${text}」`;
  }

  function buildCounterArgumentTemplate(text) {
    return `請站在質疑或反方角度，指出以下內容可能的問題、盲點或反駁觀點：\n\n「${text}」`;
  }

  function buildCursorInstructionTemplate(text) {
    return `請將以下內容改寫成清楚、可執行、適合給 Cursor 使用的開發指令：\n\n「${text}」`;
  }

  return {
    findInputElement,
    buildQuoteTemplate,
    buildExplainTemplate,
    buildPlainExplainTemplate,
    buildExampleTemplate,
    buildBulletSummaryTemplate,
    buildCounterArgumentTemplate,
    buildCursorInstructionTemplate,
    insertTextIntoInput,

    init(settings) {
      if (!settings.extensionEnabled || !settings.showGeminiInputInsertion) {
        enabled = false;
        return;
      }
      if (!isSupportedGeminiPage()) {
        enabled = false;
        return;
      }
      enabled = true;
    },

    destroy() {
      // 不清除輸入框內容，僅重置 enabled 狀態。
      enabled = false;
    },

    update(settings) {
      if (!settings.extensionEnabled || !settings.showGeminiInputInsertion) {
        enabled = false;
      } else if (isSupportedGeminiPage()) {
        enabled = true;
      }
    },

    /**
     * 保留給 GeminiReadingAssistant 主控制器呼叫的外部插入 API。
     * 內部委派給 insertTextIntoInput。
     */
    insertCitation(text) {
      insertTextIntoInput(text);
    },

    getDiagnostics() {
      const result = findInputElementWithType();
      return {
        selectorType: result ? result.selectorType : "none"
      };
    }
  };
})();

/**
 * 本頁關鍵字搜尋模組。
 *
 * 功能：
 * - 固定搜尋列（輸入框 + 上/下一個 + 計數 + 關閉）
 * - 以 TreeWalker 安全收集文字節點，不操作 innerHTML
 * - 以 splitText + <mark> 包裹方式高亮命中結果
 * - 支援循環跳轉、debounce 即時搜尋
 * - destroy 完整清除 DOM 與高亮
 *
 * 啟用條件：
 * - settings.extensionEnabled === true
 * - settings.showPageSearch === true
 * - isSupportedGeminiPage() === true
 */
const PageSearchModule = (() => {
  let searchUI = null;
  let inputEl = null;
  let counterEl = null;
  let dragHandleEl = null;
  let matches = []; // Array of <mark> elements
  let currentIndex = -1;
  let debounceTimer = null;

  // 單次搜尋最多高亮數量，防止超大頁面卡頓。
  const MAX_MATCHES = 500;

  // 本次 session 內最後位置，open() 重新開啟時保留。
  let sessionPosition = null;

  // 拖曳狀態
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartLeft = 0;
  let dragStartTop = 0;

  let dragMoveBound = null;
  let dragUpBound = null;

  // 供快捷鍵檢查用，由 init/update 更新。
  let lastSettings = null;

  let keyboardShortcutBound = null;

  // ---- 輔助判斷 ---------------------------------------------------------

  /**
   * 本頁搜尋需排除的插件 UI 根（不含正文上的 gra-message / focus / collapse 等標記）。
   * tooltip 掛在 body 下，須單獨列出。
   */
  const PAGE_SEARCH_EXCLUDED_UI_SELECTOR =
    ".gra-sidebar-nav, .gra-citation-panel, .gra-selection-toolbar, .gra-search-ui, .gra-sidebar-nav__tooltip";

  /**
   * 判斷 text node 是否位於上述插件 UI 子樹內（與任意 gra-* class 無關）。
   */
  function isInsideGraUI(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!el || !(el instanceof Element)) return false;
    try {
      return !!el.closest(PAGE_SEARCH_EXCLUDED_UI_SELECTOR);
    } catch (_) {
      return false;
    }
  }

  // ---- 浮動定位與拖曳 ----------------------------------------------------

  const DEFAULT_OFFSET = 16;
  const CLAMP_MARGIN = 40;

  /**
   * 取得預設浮動位置（右上角）。
   */
  function getDefaultPosition() {
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const w = searchUI ? searchUI.offsetWidth : 0;
    const panelWidth = w > 0 ? w : 420;
    return {
      left: vw - panelWidth - DEFAULT_OFFSET,
      top: DEFAULT_OFFSET
    };
  }

  /**
   * 將位置限制在 viewport 內，至少保留 CLAMP_MARGIN 可見。
   */
  function clampPosition(left, top) {
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const w = searchUI.offsetWidth || 420;
    const h = searchUI.offsetHeight || 48;
    const minLeft = -w + CLAMP_MARGIN;
    const maxLeft = vw - CLAMP_MARGIN;
    const minTop = -h + CLAMP_MARGIN;
    const maxTop = vh - CLAMP_MARGIN;
    return {
      left: Math.max(minLeft, Math.min(maxLeft, left)),
      top: Math.max(minTop, Math.min(maxTop, top))
    };
  }

  function applyPosition(left, top) {
    const clamped = clampPosition(left, top);
    searchUI.style.left = `${clamped.left}px`;
    searchUI.style.top = `${clamped.top}px`;
  }

  function handleDragStart(e) {
    if (e.button !== 0) return;
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    const rect = searchUI.getBoundingClientRect();
    dragStartLeft = rect.left;
    dragStartTop = rect.top;
    e.preventDefault();
    document.body.style.userSelect = "none";

    if (!dragMoveBound) {
      dragMoveBound = handleDragMove;
      dragUpBound = handleDragEnd;
    }
    document.addEventListener("mousemove", dragMoveBound);
    document.addEventListener("mouseup", dragUpBound);
  }

  function handleDragMove(e) {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    applyPosition(dragStartLeft + dx, dragStartTop + dy);
  }

  function handleDragEnd(e) {
    if (e.button !== 0) return;
    isDragging = false;
    document.body.style.userSelect = "";
    document.removeEventListener("mousemove", dragMoveBound);
    document.removeEventListener("mouseup", dragUpBound);

    const rect = searchUI.getBoundingClientRect();
    sessionPosition = { left: rect.left, top: rect.top };
  }

  // ---- UI 建立 ----------------------------------------------------------

  /**
   * 建立搜尋列 DOM，僅建立一次。
   * 結構：
   * <div class="gra-search-ui">
   *   <div class="gra-search-ui__header">
   *     <span class="gra-search-ui__drag-handle">⋮⋮</span>
   *   </div>
   *   <div class="gra-search-ui__body">
   *     <input /> <button>↑</button> <button>↓</button> <span>0/0</span> <button>✕</button>
   *   </div>
   * </div>
   */
  function createSearchUI() {
    if (searchUI) return searchUI;

    searchUI = document.createElement("div");
    searchUI.className = "gra-search-ui";

    const headerEl = document.createElement("div");
    headerEl.className = "gra-search-ui__header";

    dragHandleEl = document.createElement("span");
    dragHandleEl.className = "gra-search-ui__drag-handle";
    dragHandleEl.textContent = "⋮⋮";
    dragHandleEl.title = "拖曳移動";
    dragHandleEl.addEventListener("mousedown", handleDragStart);

    headerEl.appendChild(dragHandleEl);
    searchUI.appendChild(headerEl);

    const bodyEl = document.createElement("div");
    bodyEl.className = "gra-search-ui__body";

    inputEl = document.createElement("input");
    inputEl.type = "text";
    inputEl.className = "gra-search-ui__input";
    inputEl.placeholder = "搜尋頁面內容…";
    inputEl.addEventListener("input", () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        performSearch(inputEl.value.trim());
      }, 200);
    });
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.shiftKey ? goToPreviousMatch() : goToNextMatch();
        e.preventDefault();
      } else if (e.key === "Escape") {
        clearSearch();
      }
    });

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "gra-search-ui__button";
    prevBtn.textContent = "↑";
    prevBtn.title = "上一個（Shift+Enter）";
    prevBtn.addEventListener("click", goToPreviousMatch);

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "gra-search-ui__button";
    nextBtn.textContent = "↓";
    nextBtn.title = "下一個（Enter）";
    nextBtn.addEventListener("click", goToNextMatch);

    counterEl = document.createElement("span");
    counterEl.className = "gra-search-ui__counter";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "gra-search-ui__button gra-search-ui__button--close";
    closeBtn.textContent = "✕";
    closeBtn.title = "關閉";
    closeBtn.addEventListener("click", () => {
      clearSearch();
      searchUI.style.display = "none";
    });

    bodyEl.appendChild(inputEl);
    bodyEl.appendChild(prevBtn);
    bodyEl.appendChild(nextBtn);
    bodyEl.appendChild(counterEl);
    bodyEl.appendChild(closeBtn);
    searchUI.appendChild(bodyEl);
    document.body.appendChild(searchUI);

    const pos = sessionPosition || getDefaultPosition();
    applyPosition(pos.left, pos.top);

    return searchUI;
  }

  // ---- 搜尋範圍 ---------------------------------------------------------

  /**
   * 以 TreeWalker 收集 Gemini 主內容區中所有可見文字節點。
   *
   * 搜尋根：main[role='main'] > main > document.body（與導航模組相同策略）
   * 排除：
   * - PAGE_SEARCH_EXCLUDED_UI_SELECTOR 所涵蓋的插件 UI 子樹（側欄／引用面板／選字列／搜尋列／tooltip）
   * - display:none / visibility:hidden 的元素
   * - 純空白文字節點
   */
  function findSearchTargets() {
    const root =
      document.querySelector("main[role='main']") ||
      document.querySelector("main") ||
      document.body;

    const textNodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (isInsideGraUI(node)) return NodeFilter.FILTER_REJECT;
        if (!node.textContent.trim()) return NodeFilter.FILTER_SKIP;
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_SKIP;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") {
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }
    return textNodes;
  }

  // ---- 高亮處理 ---------------------------------------------------------

  /**
   * 在單一文字節點內，將所有命中位置以 <mark> 包裹並回傳 mark 陣列。
   *
   * 演算法（安全、不用 innerHTML）：
   * 1. 在 text node 中找出所有命中起始位置（忽略大小寫）
   * 2. 從後往前處理，保持索引不失效：
   *    a. 若命中結尾後還有文字，用 splitText(end) 切出後綴
   *    b. 若命中起始前有文字，用 splitText(pos) 切出前綴
   *    c. 將命中的文字節點包進 <mark.gra-search-highlight>
   * 3. 下一次迭代對前綴節點繼續操作
   */
  function highlightInTextNode(textNode, query) {
    const text = textNode.textContent;
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();

    const positions = [];
    let start = 0;
    let idx;
    while ((idx = lowerText.indexOf(lowerQuery, start)) !== -1) {
      positions.push(idx);
      start = idx + lowerQuery.length;
    }
    if (!positions.length) return [];

    const newMarks = [];
    let node = textNode;

    for (let i = positions.length - 1; i >= 0; i--) {
      const pos = positions[i];
      const end = pos + query.length;

      // 切出命中位置之後的後綴（若有）。
      if (end < node.textContent.length) {
        node.splitText(end);
      }

      // 切出命中位置之前的前綴（若有），命中部分成為新節點 matchNode。
      let matchNode;
      if (pos > 0) {
        matchNode = node.splitText(pos);
      } else {
        matchNode = node;
      }

      // 以 <mark> 包裹命中文字節點。
      const mark = document.createElement("mark");
      mark.className = "gra-search-highlight";
      if (matchNode.parentNode) {
        matchNode.parentNode.insertBefore(mark, matchNode);
        mark.appendChild(matchNode);
      }
      newMarks.unshift(mark); // 前插，維持文件順序

      if (pos > 0) {
        // 下一次迭代處理前綴節點。
        const prev = mark.previousSibling;
        if (!prev || prev.nodeType !== Node.TEXT_NODE) break;
        node = prev;
      } else {
        break; // 已到節點開頭，無更多前綴
      }
    }

    return newMarks;
  }

  /**
   * 移除所有高亮 <mark>，還原文字節點，並呼叫 normalize() 合併碎片。
   */
  function clearHighlights() {
    matches.forEach((mark) => {
      if (!mark.parentNode) return;
      const textChild = mark.firstChild;
      if (textChild) {
        mark.parentNode.insertBefore(textChild, mark);
      }
      mark.parentNode.removeChild(mark);
    });

    // 合併高亮拆分後留下的破碎文字節點，避免影響下次搜尋。
    const root =
      document.querySelector("main[role='main']") ||
      document.querySelector("main") ||
      document.body;
    try {
      root.normalize();
    } catch (_) {}

    matches = [];
    currentIndex = -1;
  }

  /**
   * 更新計數顯示，格式為「目前 / 總數」。
   */
  function updateCounter() {
    if (!counterEl) return;
    counterEl.textContent =
      matches.length === 0 ? "" : `${currentIndex + 1} / ${matches.length}`;
  }

  // ---- 搜尋與跳轉 -------------------------------------------------------

  /**
   * 執行搜尋：清除舊高亮 → 走訪文字節點 → 高亮命中 → 跳到第一個結果。
   * query 為空時只做清除。
   */
  function performSearch(query) {
    clearHighlights();
    updateCounter();
    if (!query) return;

    const textNodes = findSearchTargets();
    let limitReached = false;

    textNodes.forEach((node) => {
      if (limitReached) return;
      const newMarks = highlightInTextNode(node, query);
      matches.push(...newMarks);
      if (matches.length >= MAX_MATCHES) limitReached = true;
    });

    currentIndex = matches.length > 0 ? 0 : -1;
    if (currentIndex >= 0) focusMatch(currentIndex);
    updateCounter();
  }

  /**
   * 將指定索引的命中結果捲動到畫面中央並設為 active。
   * 索引自動循環（支援負數 wrap-around）。
   */
  function focusMatch(index) {
    if (!matches.length) return;

    matches.forEach((m) => m.classList.remove("gra-search-highlight--active"));

    // 循環處理
    currentIndex =
      ((index % matches.length) + matches.length) % matches.length;
    const active = matches[currentIndex];
    active.classList.add("gra-search-highlight--active");
    active.scrollIntoView({ behavior: "smooth", block: "center" });
    updateCounter();
  }

  function goToNextMatch() {
    if (!matches.length) return;
    focusMatch(currentIndex + 1);
  }

  function goToPreviousMatch() {
    if (!matches.length) return;
    focusMatch(currentIndex - 1);
  }

  /** 清除搜尋狀態（高亮 + 輸入框 + 計數），但不隱藏 UI。 */
  function clearSearch() {
    clearHighlights();
    if (inputEl) inputEl.value = "";
    updateCounter();
  }

  // ---- Ctrl+F / ⌘F 快捷鍵 -------------------------------------------------

  function handleKeyboardShortcut(e) {
    if ((e.key !== "f" && e.key !== "F") || (!e.ctrlKey && !e.metaKey)) return;
    if (!lastSettings || !lastSettings.extensionEnabled || !lastSettings.showPageSearch)
      return;
    if (!isSupportedGeminiPage()) return;

    e.preventDefault();
    e.stopPropagation();

    if (inputEl && document.activeElement === inputEl) return;

    openSearch(lastSettings);
  }

  function bindKeyboardShortcut() {
    if (keyboardShortcutBound) return;
    keyboardShortcutBound = handleKeyboardShortcut;
    document.addEventListener("keydown", keyboardShortcutBound, { capture: true });
  }

  function unbindKeyboardShortcut() {
    if (!keyboardShortcutBound) return;
    document.removeEventListener("keydown", keyboardShortcutBound, {
      capture: true
    });
    keyboardShortcutBound = null;
  }

  /**
   * 內部實作：開啟搜尋列。
   */
  function openSearch(settings) {
    if (!settings || !settings.extensionEnabled || !settings.showPageSearch)
      return;
    if (!isSupportedGeminiPage()) return;

    createSearchUI();
    searchUI.style.display = "";
    clearSearch();
    if (inputEl) inputEl.focus();
  }

  // ---- 公開 API ---------------------------------------------------------

  return {
    createSearchUI,
    findSearchTargets,
    performSearch,
    clearHighlights,
    focusMatch,
    goToNextMatch,
    goToPreviousMatch,

    init(settings) {
      if (!settings.extensionEnabled || !settings.showPageSearch) return;
      if (!isSupportedGeminiPage()) return;
      lastSettings = settings;
      createSearchUI();
      bindKeyboardShortcut();
    },

    destroy() {
      unbindKeyboardShortcut();
      clearSearch();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (isDragging && dragMoveBound && dragUpBound) {
        document.removeEventListener("mousemove", dragMoveBound);
        document.removeEventListener("mouseup", dragUpBound);
        document.body.style.userSelect = "";
        isDragging = false;
      }
      if (dragHandleEl) {
        dragHandleEl.removeEventListener("mousedown", handleDragStart);
      }
      if (searchUI && searchUI.parentNode) {
        searchUI.parentNode.removeChild(searchUI);
      }
      searchUI = null;
      inputEl = null;
      counterEl = null;
      dragHandleEl = null;
      matches = [];
      currentIndex = -1;
    },

    update(settings) {
      lastSettings = settings;
      if (!settings.extensionEnabled || !settings.showPageSearch) {
        this.destroy();
      } else if (!searchUI) {
        this.init(settings);
      }
    },

    /**
     * 從 popup 或 Ctrl+F 重新開啟搜尋列。
     * 若 UI 尚未建立則建立；若已隱藏則恢復顯示；並 focus 輸入框。
     * 策略：重新開啟時清空之前 query，避免殘留高亮。
     */
    open(settings) {
      openSearch(settings);
    },

    getDiagnostics() {
      return {
        initialized: !!searchUI,
        visible: !!(searchUI && searchUI.style.display !== "none")
      };
    }
  };
})();

// ---- Conversation Journal (V2.9A) -----------------------------------------

/**
 * 對話 journal + snapshot 基礎層。
 * 本輪僅實作：收集 blocks、journal append、snapshot update、立即保存。
 */
const ConversationJournalModule = (() => {
  /**
   * 收集目前頁面對話 blocks，重用 SidebarNavigationModule 掃描能力。
   */
  function collectConversationBlocks() {
    const withTypes = SidebarNavigationModule.getMessageElementsWithTypes?.();
    if (!Array.isArray(withTypes)) return [];

    return withTypes.map(({ node, messageType }, index) =>
      normalizeConversationBlock(node, index, messageType)
    );
  }

  /**
   * 將收集到的 blocks 增量 append 到 journal，並更新 snapshot。
   */
  async function appendToJournal(conversationKey, blocks, pageType) {
    if (!conversationKey || !blocks?.length) return null;

    const GRA = typeof GRAStorage !== "undefined" ? GRAStorage : null;
    if (!GRA?.getConversationJournal || !GRA?.saveConversationJournal) {
      console.warn("[GRA][journal] GRAStorage journal API not available.");
      return null;
    }

    let journal = await GRA.getConversationJournal(conversationKey);
    const now = Date.now();

    if (!journal) {
      journal = {
        conversationKey,
        pageType: pageType || detectPageType(),
        title: "",
        createdAt: now,
        updatedAt: now,
        entries: []
      };
    }

    const existingFps = new Set(
      journal.entries.map((e) => e.messageFingerprint).filter(Boolean)
    );

    let appended = 0;
    for (const block of blocks) {
      if (!block.messageFingerprint || existingFps.has(block.messageFingerprint))
        continue;

      const entryId = `gra-entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      journal.entries.push({
        entryId,
        messageFingerprint: block.messageFingerprint,
        messageType: block.type,
        text: block.text,
        summary: block.summary,
        sourceMessageId: block.sourceMessageId,
        capturedAt: block.capturedAt
      });
      existingFps.add(block.messageFingerprint);
      appended++;
    }

    journal.updatedAt = now;

    await GRA.saveConversationJournal(conversationKey, journal);
    return { journal, appended };
  }

  /**
   * 更新 snapshot 為目前 journal 狀態。
   * @param {Object} opts - 可選 { isPartial }
   */
  async function updateSnapshot(conversationKey, journal, opts) {
    if (!conversationKey || !journal) return null;

    const GRA = typeof GRAStorage !== "undefined" ? GRAStorage : null;
    if (!GRA?.saveConversationSnapshot) return null;

    const snapshot = {
      ...journal,
      lastSavedAt: Date.now(),
      ...(opts && typeof opts.isPartial === "boolean" && { isPartial: opts.isPartial })
    };
    await GRA.saveConversationSnapshot(conversationKey, snapshot);
    return snapshot;
  }

  /**
   * 立即保存：收集 blocks、append journal、更新 snapshot、更新 index。
   * @param {Object} opts - 可選 { isPartial }
   */
  async function saveNow(opts) {
    const conversationKey = detectConversationKey();
    const pageType = detectPageType();
    const blocks = collectConversationBlocks();

    if (!blocks.length) {
      return { ok: false, reason: "no_blocks", conversationKey };
    }

    const GRA = typeof GRAStorage !== "undefined" ? GRAStorage : null;
    if (!GRA) {
      return { ok: false, reason: "no_storage", conversationKey };
    }

    const { journal, appended } =
      (await appendToJournal(conversationKey, blocks, pageType)) || {};
    if (!journal) {
      return { ok: false, reason: "append_failed", conversationKey };
    }

    await updateSnapshot(conversationKey, journal, opts);

    let index = await GRA.getConversationIndex();
    if (!index.keys.includes(conversationKey)) {
      index.keys = [conversationKey, ...index.keys.filter((k) => k !== conversationKey)].slice(
        0,
        50
      );
      index.updatedAt = Date.now();
      await GRA.saveConversationIndex(index);
    }

    return {
      ok: true,
      conversationKey,
      entryCount: journal.entries.length,
      appended,
      lastSavedAt: Date.now()
    };
  }

  /**
   * 取得目前對話的保存狀態（供 popup 顯示）。
   */
  async function getStatus() {
    const conversationKey = detectConversationKey();
    const blocks = collectConversationBlocks();
    const GRA = typeof GRAStorage !== "undefined" ? GRAStorage : null;

    let journal = null;
    let snapshot = null;
    if (GRA?.getConversationJournal) {
      journal = await GRA.getConversationJournal(conversationKey);
    }
    if (GRA?.getConversationSnapshot) {
      snapshot = await GRA.getConversationSnapshot(conversationKey);
    }

    return {
      conversationKey,
      pageType: detectPageType(),
      blockCount: blocks.length,
      savedEntryCount: journal?.entries?.length ?? 0,
      lastSavedAt: snapshot?.lastSavedAt ?? null,
      isPartial: snapshot?.isPartial ?? true
    };
  }

  return {
    collectConversationBlocks,
    appendToJournal,
    updateSnapshot,
    saveNow,
    getStatus
  };
})();

// ---- Conversation Auto Save (V2.9B) ----------------------------------------

const AUTO_SAVE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 判定對話是否有變動，用於避免無謂寫入。
 * 比較：block 數、最後 1～3 筆 messageFingerprint。
 */
function hasConversationChanged(currentBlocks, snapshotOrJournal) {
  const entries = snapshotOrJournal?.entries || [];

  if (currentBlocks.length > entries.length) return true;

  const lastN = 3;
  const currentFps = currentBlocks
    .map((b) => b.messageFingerprint)
    .filter(Boolean)
    .slice(-lastN);
  const savedFps = entries
    .map((e) => e.messageFingerprint)
    .filter(Boolean)
    .slice(-lastN);

  if (currentFps.length !== savedFps.length) return true;
  for (let i = 0; i < currentFps.length; i++) {
    if (currentFps[i] !== savedFps[i]) return true;
  }
  return false;
}

const ConversationAutoSaveModule = (() => {
  let timerId = null;
  let state = {
    enabled: false,
    intervalMs: AUTO_SAVE_INTERVAL_MS,
    lastCheckedAt: null,
    lastAutoSavedAt: null,
    lastResult: "idle",
    lastKnownBlockCount: 0
  };

  function updateState(partial) {
    state = { ...state, ...partial };
  }

  function runCheck(settings) {
    if (!settings?.extensionEnabled || !isSupportedGeminiPage()) {
      updateState({ lastResult: "skipped" });
      return;
    }

    const blocks = ConversationJournalModule.collectConversationBlocks();
    updateState({ lastCheckedAt: Date.now(), lastKnownBlockCount: blocks.length });

    if (!blocks.length) {
      updateState({ lastResult: "skipped" });
      return;
    }

    const conversationKey = detectConversationKey();
    const GRA = typeof GRAStorage !== "undefined" ? GRAStorage : null;
    if (!GRA?.getConversationSnapshot) {
      updateState({ lastResult: "skipped" });
      return;
    }

    GRA.getConversationSnapshot(conversationKey).then((snapshot) => {
      if (!hasConversationChanged(blocks, snapshot)) {
        updateState({ lastResult: "skipped" });
        return;
      }

      ConversationJournalModule.saveNow()
        .then((result) => {
          if (result?.ok) {
            updateState({
              lastResult: "saved",
              lastAutoSavedAt: Date.now(),
              lastKnownBlockCount: blocks.length
            });
          } else {
            updateState({ lastResult: "error" });
          }
        })
        .catch(() => {
          updateState({ lastResult: "error" });
        });
    });
  }

  function startAutoSave(settings) {
    if (!settings?.extensionEnabled || !isSupportedGeminiPage()) return;
    if (timerId) return;

    updateState({ enabled: true });
    timerId = setInterval(() => {
      runCheck(settings);
    }, state.intervalMs);
    runCheck(settings);
  }

  function stopAutoSave() {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
    updateState({ enabled: false });
  }

  function getStatus() {
    return { ...state };
  }

  return {
    startAutoSave,
    stopAutoSave,
    getStatus
  };
})();

// ---- Conversation Backfill (V2.9C) -----------------------------------------

const BACKFILL_MAX_ROUNDS = 8;
const BACKFILL_STAGNANT_THRESHOLD = 2;
const BACKFILL_STABILIZE_MS = 700;
const BACKFILL_SCROLL_PERCENT = 0.85;

/**
 * 等待 DOM 穩定。
 */
function waitForDomStabilize(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms || BACKFILL_STABILIZE_MS));
}

/**
 * 尋找主要捲動容器：main 若有 overflow 則用 main，否則用 documentElement。
 */
function findScrollContainer() {
  const main =
    document.querySelector("main[role='main']") || document.querySelector("main");
  if (main && main.scrollHeight > main.clientHeight) return main;
  return document.documentElement;
}

/**
 * 向上捲動以載入較舊內容。
 */
function scrollUpToLoadOlderContent(container) {
  const el = container || findScrollContainer();
  const viewport = el === document.documentElement ? window.innerHeight : el.clientHeight;
  const scrollAmount = Math.floor(viewport * BACKFILL_SCROLL_PERCENT);
  const before =
    el === document.documentElement ? window.scrollY : el.scrollTop;

  if (el === document.documentElement) {
    window.scrollTo(0, Math.max(0, before - scrollAmount));
  } else {
    el.scrollTop = Math.max(0, before - scrollAmount);
  }

  const after =
    el === document.documentElement ? window.scrollY : el.scrollTop;
  return after !== before;
}

const ConversationBackfillModule = (() => {
  /**
   * 執行完整補抓流程。
   */
  async function runFullBackfill(settings) {
    if (!settings?.extensionEnabled || !isSupportedGeminiPage()) {
      return {
        success: false,
        reason: "not_enabled_or_not_gemini",
        beforeBlockCount: 0,
        afterBlockCount: 0,
        rounds: 0,
        isPartial: true,
        lastSavedAt: null
      };
    }

    const blocks0 = ConversationJournalModule.collectConversationBlocks();
    if (!blocks0.length) {
      return {
        success: false,
        reason: "no_blocks",
        beforeBlockCount: 0,
        afterBlockCount: 0,
        rounds: 0,
        isPartial: true,
        lastSavedAt: null
      };
    }

    const container = findScrollContainer();
    const savedScrollTop =
      container === document.documentElement
        ? window.scrollY
        : container.scrollTop;
    const beforeBlockCount = blocks0.length;

    let lastCount = beforeBlockCount;
    let stagnantRounds = 0;
    let rounds = 0;

    try {
      for (let r = 0; r < BACKFILL_MAX_ROUNDS; r++) {
        rounds = r + 1;
        scrollUpToLoadOlderContent(container);
        await waitForDomStabilize();

        const blocks = ConversationJournalModule.collectConversationBlocks();
        const count = blocks.length;

        if (count > lastCount) {
          stagnantRounds = 0;
          lastCount = count;
        } else {
          stagnantRounds++;
          if (stagnantRounds >= BACKFILL_STAGNANT_THRESHOLD) break;
        }
      }
    } catch (e) {
      console.warn("[GRA][backfill] Error during scroll/collect:", e);
    }

    const blocksAfter = ConversationJournalModule.collectConversationBlocks();
    const afterBlockCount = blocksAfter.length;

    const conversationKey = detectConversationKey();
    const pageType = detectPageType();
    const GRA = typeof GRAStorage !== "undefined" ? GRAStorage : null;

    if (!GRA) {
      restoreScroll(container, savedScrollTop);
      return {
        success: false,
        reason: "no_storage",
        beforeBlockCount,
        afterBlockCount,
        rounds,
        isPartial: true,
        lastSavedAt: null
      };
    }

    const appendResult = await ConversationJournalModule.appendToJournal(
      conversationKey,
      blocksAfter,
      pageType
    );
    if (!appendResult?.journal) {
      restoreScroll(container, savedScrollTop);
      return {
        success: false,
        reason: "append_failed",
        beforeBlockCount,
        afterBlockCount,
        rounds,
        isPartial: true,
        lastSavedAt: null
      };
    }

    await ConversationJournalModule.updateSnapshot(
      conversationKey,
      appendResult.journal,
      { isPartial: false }
    );

    let index = await GRA.getConversationIndex();
    if (!index.keys.includes(conversationKey)) {
      index.keys = [conversationKey, ...index.keys.filter((k) => k !== conversationKey)].slice(
        0,
        50
      );
    }
    index.updatedAt = Date.now();
    await GRA.saveConversationIndex(index);

    const lastSavedAt = Date.now();
    restoreScroll(container, savedScrollTop);

    return {
      success: true,
      beforeBlockCount,
      afterBlockCount,
      rounds,
      isPartial: false,
      lastSavedAt
    };
  }

  function restoreScroll(container, scrollTop) {
    try {
      if (container === document.documentElement) {
        window.scrollTo(0, scrollTop);
      } else {
        container.scrollTop = scrollTop;
      }
    } catch (_) {}
  }

  return {
    runFullBackfill
  };
})();

// ---- Message Store: finalizeMessage + Export (V3) --------------------------

/**
 * 將訊息的最終狀態寫入 messageStore。
 * Condense 資料從 UI 已渲染的 .condense-block 讀取（不呼叫 engine API）。
 * 冪等：若 id 已存在且 text + summary 未變，不覆蓋。
 * 由 rebuildNavigation() 在每次巡檢時呼叫，確保 messageStore 即時更新。
 *
 * @param {HTMLElement} messageEl
 * @param {string} msgType - "user" | "gemini" | "unknown"
 */
function finalizeMessage(messageEl, msgType) {
  // ---- 1️⃣ messageId 穩定性（deterministic fallback） ----
  let id = messageEl.getAttribute("data-gra-message-id");
  const text = __gra_getSourceText(messageEl) || "";

  if (!id) {
    id = "gra_" + text.slice(0, 50);
  }

  const role = msgType === "gemini" ? "assistant" : "user";

  // ---- Condense（僅 assistant） ----
  let condensed = null;

  if (role === "assistant") {
    const block = messageEl.querySelector("[data-gra-condense-root]");

    if (block) {
      // DOM 結構 parsing（對應實際 class: gra-condense-summary / gra-condense-method）
      const summaryEl = block.querySelector(".gra-condense-summary");
      const methodEl = block.querySelector(".gra-condense-method");

      // 移除 emoji 前綴（🧠 / ⚙️）取得純文字
      const summary = (summaryEl?.textContent || "").replace(/^[\s\uD83E\uDDE0\u2699\uFE0F⚠️]+/, "").trim();
      const method = (methodEl?.textContent || "").replace(/^[\s\uD83E\uDDE0\u2699\uFE0F⚠️]+/, "").trim();

      if (summary && !summary.startsWith("無法安全濃縮")) {
        condensed = {
          summary,
          method,
          version: "v1",
          status: "ok"
        };
      }
    }
    // block 不存在或 summary 為空 / 失敗 → condensed 保持 null
  }

  // ---- 2️⃣ race condition 防護 ----
  const prev = messageStore.get(id);

  if (prev) {
    // 若之前沒有 summary，現在有 → 允許補寫（condense-block 延遲渲染）
    if (!prev.condensed?.summary && condensed?.summary) {
      // allow update — fall through
    } else if (prev.text.length > text.length) {
      // 若舊資料更完整（text 更長），禁止覆蓋
      return;
    } else if (prev.updatedAt && Date.now() - prev.updatedAt < 50) {
      // 若距上次寫入 < 50ms，視為重複觸發，跳過
      return;
    } else if (prev.text === text && prev.condensed?.summary) {
      // 若已有完整 condense 且內容相同，不覆蓋
      return;
    }
  }

  messageStore.set(id, {
    id,
    role,
    text,
    condensed,
    state: "final",
    seq: prev?.seq ?? __gra_seq++,
    createdAt: prev?.createdAt || Date.now(),
    updatedAt: Date.now()
  });
}

/**
 * Export 前保險：掃描頁面上所有 message，補齊未 finalize 的項目。
 * 不改變已有資料，僅補漏。
 */
function ensureAllMessagesFinalized() {
  const nodes = __gra_findMessages();
  nodes.forEach(function (el) {
    const id = el.getAttribute("data-gra-message-id");
    if (!id || messageStore.has(id)) return;
    const role = __gra_detectRole(el);
    var msgType = role === "assistant" ? "gemini" : (role === "user" ? "user" : "unknown");
    finalizeMessage(el, msgType);
  });
  // 二次掃描：補齊首輪因 DOM timing 漏寫的項目
  nodes.forEach(function (el) {
    const id = el.getAttribute("data-gra-message-id") || ("gra_" + (__gra_getSourceText(el) || "").slice(0, 50));
    if (messageStore.has(id)) return;
    const role = __gra_detectRole(el);
    var msgType = role === "assistant" ? "gemini" : (role === "user" ? "user" : "unknown");
    finalizeMessage(el, msgType);
  });
}

// condenseObserver 已移除 — finalizeMessage 改由 rebuildNavigation() 統一觸發，
// 不再需要額外的全域 MutationObserver。

/**
 * 從 messageStore 匯出 Markdown（給人看）。
 * 不依賴 DOM，僅讀取 store；export 前自動補齊漏項。
 * @returns {string}
 */
function exportStoreToMarkdown() {
  ensureAllMessagesFinalized();

  const messages = Array.from(messageStore.values())
    .sort(function (a, b) { return a.seq - b.seq; });

  if (!messages.length) return "";

  let md = "# Gemini 對話紀錄\n\n*Exported from Gemini Reading Assistant*\n\n---\n\n";

  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (msg.role === "user") {
      md += "## 使用者\n\n" + msg.text + "\n\n---\n\n";
    } else {
      md += "## Gemini\n\n";

      if (msg.condensed && msg.condensed.summary) {
        md += "### 重點（Beta）\n\n" + msg.condensed.summary + "\n\n";
        if (msg.condensed.method) {
          md += "### 說明\n\n" + msg.condensed.method + "\n\n";
        }
      }

      md += msg.text + "\n\n---\n\n";
    }
  }

  return md;
}

/**
 * 從 messageStore 匯出 TXT（純文字）。
 * export 前自動補齊漏項。
 * @returns {string}
 */
function exportStoreToTxt() {
  ensureAllMessagesFinalized();

  const messages = Array.from(messageStore.values())
    .sort(function (a, b) { return a.seq - b.seq; });

  if (!messages.length) return "";

  const lines = [
    "=== Gemini 對話紀錄 ===",
    "Exported from Gemini Reading Assistant",
    "",
    "---",
    ""
  ];

  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    var label = msg.role === "user" ? "使用者" : "Gemini";
    lines.push("--- " + label + " ---");
    lines.push("");
    if (msg.role !== "user" && msg.condensed && msg.condensed.summary) {
      lines.push("[重點] " + msg.condensed.summary);
      if (msg.condensed.method) {
        lines.push("[說明] " + msg.condensed.method);
      }
      lines.push("");
    }
    lines.push(msg.text || "(無內容)");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 從 messageStore 匯出 JSON（給系統用 / RAG）。
 * export 前自動補齊漏項。
 * @returns {string}
 */
function exportStoreToJSON() {
  ensureAllMessagesFinalized();

  var messages = Array.from(messageStore.values())
    .sort(function (a, b) { return a.seq - b.seq; });

  if (!messages.length) return "";

  return JSON.stringify({
    conversation: messages.map(function (msg) {
      return {
        id: msg.id,
        role: msg.role,
        text: msg.text,
        summary: msg.condensed?.summary || "",
        method: msg.condensed?.method || "",
        condenseStatus: msg.condensed?.status || "none",
        condenseVersion: msg.condensed?.version || "v1",
        createdAt: msg.createdAt
      };
    })
  }, null, 2);
}

// ---- Search Layer (V3) -----------------------------------------------------

var FEATURES = { SEARCH_ADVANCED: false };

// Updated by init when Pro status is known
function updateProFeatures(isPro) {
  FEATURES.SEARCH_ADVANCED = isPro;
}
var __gra_search_styles_injected = false;

function injectSearchStyles() {
  if (__gra_search_styles_injected) return;
  __gra_search_styles_injected = true;
  var style = document.createElement("style");
  style.textContent =
    ".gra-search-panel{position:fixed;top:0;left:300px;right:0;height:auto;max-height:50vh;overflow:hidden;background:#1a1a1a;color:#e0e0e0;z-index:9999;box-shadow:0 2px 12px rgba(0,0,0,.5);font-family:system-ui,sans-serif;font-size:13px;display:flex;flex-direction:column;border-bottom:2px solid #f97316;border-radius:0 0 8px 8px}" +
    ".gra-search-panel__header{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid #333}" +
    ".gra-search-panel__input{flex:1;background:#111;border:1px solid #444;border-radius:6px;color:#fff;padding:6px 12px;font-size:14px;outline:none}" +
    ".gra-search-panel__input:focus{border-color:#f97316}" +
    ".gra-search-panel__input::placeholder{color:#666}" +
    ".gra-search-panel__close{background:none;border:none;color:#888;font-size:18px;cursor:pointer;padding:0 6px;line-height:1}" +
    ".gra-search-panel__close:hover{color:#fff}" +
    ".gra-search-panel__meta{padding:4px 16px;color:#888;font-size:11px;border-bottom:1px solid #222}" +
    ".gra-search-panel__list{overflow-y:auto;flex:1;padding:4px 0}" +
    ".gra-search-item{padding:8px 16px;cursor:pointer;border-bottom:1px solid #222;line-height:1.5}" +
    ".gra-search-item:hover{background:#262626}" +
    ".gra-search-item__role{font-size:11px;color:#888;margin-bottom:2px}" +
    ".gra-search-item mark{background:#f97316;color:#fff;border-radius:2px;padding:0 1px}";
  document.head.appendChild(style);
}

/**
 * 從 messageStore 搜尋關鍵字。Free 版搜 text + summary；Pro 版加搜 method 且無上限。
 * @param {string} keyword
 * @returns {Array}
 */
function searchMessages(keyword) {
  if (!keyword) return [];

  var lower = keyword.toLowerCase();
  var FREE_LIMIT = 20;

  var results = [];

  for (var entry of messageStore.values()) {
    var hit = false;

    if (entry.text.toLowerCase().includes(lower)) hit = true;
    if (!hit && entry.condensed?.summary?.toLowerCase().includes(lower)) hit = true;

    if (!hit && FEATURES.SEARCH_ADVANCED) {
      if (entry.condensed?.method?.toLowerCase().includes(lower)) hit = true;
    }

    if (hit) results.push(entry);
  }

  // seq 排序
  results.sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });

  if (!FEATURES.SEARCH_ADVANCED) {
    results = results.slice(0, FREE_LIMIT);
  }

  return results;
}

/**
 * 將 keyword 在文字中高亮（HTML safe）。
 * @param {string} text
 * @param {string} keyword
 * @returns {string}
 */
function highlightMatches(text, keyword) {
  if (!keyword || !text) return text || "";

  // 轉義 regex 特殊字元
  var escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  var regex = new RegExp("(" + escaped + ")", "gi");

  // 先 HTML escape 再高亮
  var safe = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return safe.replace(regex, "<mark>$1</mark>");
}

/**
 * 渲染搜尋結果到浮層面板。
 * @param {Array} results
 * @param {string} keyword
 */
function renderSearchResults(results, keyword) {
  injectSearchStyles();

  var container = document.querySelector(".gra-search-panel");

  if (!container) {
    container = document.createElement("div");
    container.className = "gra-search-panel";
    document.body.appendChild(container);
  }

  // 動態避讓左右 nav
  var geminiNav = document.querySelector("nav") || document.querySelector("[class*='side-nav']");
  var graNav = document.querySelector(".gra-sidebar-nav");
  container.style.left = (geminiNav ? geminiNav.offsetWidth : 300) + "px";
  container.style.right = (graNav ? graNav.offsetWidth : 0) + "px";

  container.innerHTML = "";

  // ---- header（input + close） ----
  var header = document.createElement("div");
  header.className = "gra-search-panel__header";

  var input = document.createElement("input");
  input.type = "text";
  input.className = "gra-search-panel__input";
  input.placeholder = "\u641C\u5C0B\u5C0D\u8A71\u5167\u5BB9\u2026";
  input.value = keyword || "";

  var debounceTimer = null;
  input.addEventListener("input", function () {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      handleSearch(input.value.trim());
    }, 200);
  });

  var closeBtn = document.createElement("button");
  closeBtn.className = "gra-search-panel__close";
  closeBtn.textContent = "\u2715";
  closeBtn.title = "\u95DC\u9589\u641C\u5C0B";
  closeBtn.addEventListener("click", function () {
    container.remove();
  });

  header.appendChild(input);
  header.appendChild(closeBtn);
  container.appendChild(header);

  // ---- meta ----
  var meta = document.createElement("div");
  meta.className = "gra-search-panel__meta";
  if (!keyword) {
    meta.textContent = "輸入關鍵字搜尋對話內容 ｜ 快捷鍵 Ctrl+Shift+S";
  } else {
    var countText = results.length + " \u7B46\u7D50\u679C";
    if (!FEATURES.SEARCH_ADVANCED && results.length >= 20) {
      countText += "\uFF08Free \u7248\u4E0A\u9650 20\uFF09";
    }
    meta.textContent = countText;
  }
  container.appendChild(meta);

  // ---- list ----
  var list = document.createElement("div");
  list.className = "gra-search-panel__list";

  for (var i = 0; i < results.length; i++) {
    (function (msg) {
      var item = document.createElement("div");
      item.className = "gra-search-item";

      var roleLabel = document.createElement("div");
      roleLabel.className = "gra-search-item__role";
      roleLabel.textContent = msg.role === "user" ? "\uD83D\uDC64 User" : "\uD83E\uDD16 Assistant";

      var preview = document.createElement("div");
      var previewText = msg.condensed?.summary || msg.text.slice(0, 120);
      preview.innerHTML = highlightMatches(previewText, keyword);

      item.appendChild(roleLabel);
      item.appendChild(preview);

      item.addEventListener("click", function () {
        var el = document.querySelector("[data-gra-message-id=\"" + msg.id + "\"]");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      });

      list.appendChild(item);
    })(results[i]);
  }

  container.appendChild(list);

  // focus input
  setTimeout(function () { input.focus(); }, 50);
}

/**
 * 搜尋入口。
 * @param {string} keyword
 */
function handleSearch(keyword) {
  ensureAllMessagesFinalized();
  var results = searchMessages(keyword);
  renderSearchResults(results, keyword);
}

// ---- Store Search 鍵盤快捷鍵 (Ctrl+Shift+S) ----
document.addEventListener("keydown", function (e) {
  if (e.ctrlKey && e.shiftKey && e.key === "S") {
    e.preventDefault();
    var existing = document.querySelector(".gra-search-panel");
    if (existing) {
      existing.remove();
    } else {
      handleSearch("");
      // 自動 focus 到搜尋輸入框
      var input = document.querySelector(".gra-search-panel__input");
      if (input) input.focus();
    }
  }
});

// ---- Snapshot Export (V2.9D) ----------------------------------------------

const TYPE_LABELS = { user: "使用者", gemini: "Gemini", unknown: "未知" };

/**
 * 將 snapshot 序列化為 Markdown。
 */
function serializeSnapshotToMarkdown(snapshot) {
  if (!snapshot?.entries?.length) return "";

  const lines = [
    "# Conversation Snapshot",
    "*Exported from Gemini Reading Assistant*",
    "",
    "---",
    ""
  ];

  for (const e of snapshot.entries) {
    const label = TYPE_LABELS[e.messageType] || "未知";
    lines.push(`## ${label}`);
    lines.push("");
    lines.push((e.text || "").trim() || "(無內容)");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 將 snapshot 序列化為 TXT。
 */
function serializeSnapshotToTxt(snapshot) {
  if (!snapshot?.entries?.length) return "";

  const lines = [
    "=== Conversation Snapshot ===",
    "Exported from Gemini Reading Assistant",
    "",
    "---",
    ""
  ];

  for (const e of snapshot.entries) {
    const label = TYPE_LABELS[e.messageType] || "未知";
    lines.push(`--- ${label} ---`);
    lines.push("");
    lines.push((e.text || "").trim() || "(無內容)");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 匯出對話為指定格式（md / txt / json）。
 *
 * 優先使用 messageStore（即時 DOM 資料，含 condense 摘要），
 * 若 messageStore 為空則降級讀取 storage snapshot。
 */
async function exportSnapshotAsFormat(format) {
  const conversationKey = detectConversationKey();
  const safeKey = (conversationKey || "conversation")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 40);
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");

  // ---- 1) 優先嘗試 messageStore ----
  let content = "";
  if (format === "json") {
    content = exportStoreToJSON();
  } else if (format === "md") {
    content = exportStoreToMarkdown();
  } else {
    content = exportStoreToTxt();
  }

  if (content) {
    const ext = format === "json" ? "json" : format === "md" ? "md" : "txt";
    return {
      success: true,
      content,
      format,
      filename: `gemini-${safeKey}-${timestamp}.${ext}`
    };
  }

  // ---- 2) 降級：從 storage snapshot 讀取 ----
  const GRA = typeof GRAStorage !== "undefined" ? GRAStorage : null;
  if (!GRA?.getConversationSnapshot) {
    return { success: false, reason: "no_data" };
  }

  const snapshot = await GRA.getConversationSnapshot(conversationKey);
  if (!snapshot?.entries?.length) {
    return { success: false, reason: "no_data" };
  }

  content =
    format === "md"
      ? serializeSnapshotToMarkdown(snapshot)
      : serializeSnapshotToTxt(snapshot);

  const ext = format === "md" ? "md" : "txt";
  return {
    success: true,
    content,
    format,
    filename: `gemini-${safeKey}-${timestamp}.${ext}`
  };
}

// ---- Content Script 主要控制流程 ------------------------------------------

/**
 * Content script 主控制器，負責協調各模組。
 */
const GeminiReadingAssistant = (() => {
  let initialized = false;
  let currentSettings = { ...DEFAULT_SETTINGS };

  async function applySettings(newSettings) {
    currentSettings = { ...currentSettings, ...newSettings };

    // Pro status toggle — update feature gate and rebuild sidebar to add/remove Pro UI
    if (newSettings._proEnabled !== undefined) {
      updateProFeatures(!!newSettings._proEnabled);
      // Sidebar will pick up new _proEnabled from currentSettings on next rebuild
    }

    if (!currentSettings.extensionEnabled) {
      ConversationAutoSaveModule.stopAutoSave();
      SidebarNavigationModule.destroy();
      SelectionToolbarModule.destroy();
      CitationClipboardModule.destroy();
      GeminiInputIntegrationModule.destroy();
      PageSearchModule.destroy();
      return;
    }

    ConversationAutoSaveModule.startAutoSave(currentSettings);
    // 各模組自行處理啟用 / 停用狀態。
    SidebarNavigationModule.update(currentSettings);
    SelectionToolbarModule.update(currentSettings);
    CitationClipboardModule.update(currentSettings);
    GeminiInputIntegrationModule.update(currentSettings);
    PageSearchModule.update(currentSettings);
  }

  async function init() {
    if (initialized) return;
    if (!isSupportedGeminiPage()) {
      GRA_DEBUG && console.info("[GRA] Not a supported Gemini page. Content script will stay idle.");
      return;
    }

    initialized = true;
    currentSettings = await loadSettings();

    // Pro license check
    var license = await GRAStorage.getLicense();
    var proEnabled = GRAStorage.isPro(license);
    currentSettings._proEnabled = proEnabled;
    updateProFeatures(proEnabled);
    GRA_DEBUG && console.info("[GRA] Pro status:", proEnabled);

    // Silent re-verify if license is in grace period (>30 days since last verify)
    if (proEnabled && license && license.verifiedAt) {
      var daysSince = (Date.now() - license.verifiedAt) / (1000 * 60 * 60 * 24);
      if (daysSince > 30) {
        GRAStorage.silentReVerify(license, "AR4HmEQdU1OmdDAm2V3ayA==").catch(function () {});
      }
    }

    // 初次依設定初始化各模組。
    SidebarNavigationModule.init(currentSettings);
    SelectionToolbarModule.init(currentSettings);
    CitationClipboardModule.init(currentSettings);
    GeminiInputIntegrationModule.init(currentSettings);
    PageSearchModule.init(currentSettings);
    ConversationAutoSaveModule.startAutoSave(currentSettings);

    // 接收 popup 或 background 傳來的設定更新 / 指令。
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || !message.type) return;

      switch (message.type) {
        case "GRA_GET_SETTINGS":
          sendResponse({ settings: currentSettings });
          break;
        case "GRA_UPDATE_SETTINGS":
          // popup 已將設定寫入 storage，這裡只需套用到記憶體中的模組
          applySettings(message.payload || {});
          sendResponse({ ok: true });
          break;
        case "GRA_INSERT_CITATION":
          // 讓輸入框模組處理插入行為。
          GeminiInputIntegrationModule.insertCitation(message.payload || "");
          sendResponse({ ok: true });
          break;
        case "GRA_OPEN_SEARCH_UI":
          PageSearchModule.open(currentSettings);
          sendResponse({ ok: true });
          break;
        case "GRA_GET_DIAGNOSTICS":
          (async () => {
            const pageType = detectPageType();

            let citationDiag = { initialized: false, quoteCount: 0 };
            try {
              citationDiag = await CitationClipboardModule.getDiagnostics();
            } catch (_) {}

            sendResponse({
              pageType,
              sidebar: SidebarNavigationModule.getDiagnostics(),
              selectionToolbar: SelectionToolbarModule.getDiagnostics(),
              citationPanel: citationDiag,
              searchUI: PageSearchModule.getDiagnostics(),
              inputIntegration: GeminiInputIntegrationModule.getDiagnostics()
            });
          })();
          return true;
        case "GRA_GET_CONVERSATION_STATUS":
          (async () => {
            try {
              const status = await ConversationJournalModule.getStatus();
              const autoSave = ConversationAutoSaveModule.getStatus();
              sendResponse({
                ...status,
                autoSave,
                messageStoreCount: messageStore.size
              });
            } catch (e) {
              sendResponse({
                conversationKey: detectConversationKey(),
                pageType: detectPageType(),
                blockCount: 0,
                savedEntryCount: 0,
                messageStoreCount: messageStore.size,
                lastSavedAt: null,
                autoSave: ConversationAutoSaveModule.getStatus(),
                error: String(e)
              });
            }
          })();
          return true;
        case "GRA_SAVE_CONVERSATION":
          (async () => {
            try {
              const result = await ConversationJournalModule.saveNow();
              sendResponse(result);
            } catch (e) {
              sendResponse({
                ok: false,
                reason: "error",
                error: String(e)
              });
            }
          })();
          return true;
        case "GRA_RUN_FULL_BACKFILL":
          (async () => {
            try {
              const result = await ConversationBackfillModule.runFullBackfill(
                currentSettings
              );
              sendResponse(result);
            } catch (e) {
              console.warn("[GRA][backfill] Error:", e);
              sendResponse({
                success: false,
                reason: "error",
                error: String(e),
                beforeBlockCount: 0,
                afterBlockCount: 0,
                rounds: 0,
                isPartial: true,
                lastSavedAt: null
              });
            }
          })();
          return true;
        case "GRA_EXPORT_SNAPSHOT":
          (async () => {
            try {
              const format = ["md", "txt", "json"].includes(message.format)
                ? message.format
                : "md";
              const result = await exportSnapshotAsFormat(format);
              sendResponse(result);
            } catch (e) {
              console.warn("[GRA][export] Error:", e);
              sendResponse({
                success: false,
                reason: "error",
                error: String(e)
              });
            }
          })();
          return true;
        case "GRA_OPEN_STORE_SEARCH":
          (function () {
            try {
              handleSearch(message.keyword || "");
              sendResponse({ success: true });
            } catch (e) {
              console.warn("[GRA][store-search] Error:", e);
              sendResponse({ success: false, reason: "error", error: String(e) });
            }
          })();
          return true;
        default:
          // 未識別的訊息類型可在此忽略或記錄。
          break;
      }
    });

    // ---- Handoff: always clean up stale data (privacy safety net) ----
    (async function () {
      try {
        var stored = await GRAStorage.readFromStorage(["gra_pending_handoff"]);
        var handoff = stored.gra_pending_handoff;
        if (!handoff) return;

        var age = Date.now() - (handoff.createdAt || 0);

        // Stale handoff (>60s) — silently purge for privacy
        if (age >= 60000) {
          await GRAStorage.writeToStorage({ gra_pending_handoff: null });
          return;
        }

        // Fresh handoff — re-read license from storage (don't rely on stale closure)
        var freshLicense = await GRAStorage.getLicense();
        if (GRAStorage.isPro(freshLicense) && handoff.prompt) {
          await GRAStorage.writeToStorage({ gra_pending_handoff: null });
          if (handoff.geminiPlan) {
            await GRAStorage.saveSettings({ geminiPlan: handoff.geminiPlan });
          }
          setTimeout(function () {
            GeminiInputIntegrationModule.insertTextIntoInput(handoff.prompt);
          }, 2000);
        }
      } catch (e) {
        // Fail-safe: always try to clear on error
        try { await GRAStorage.writeToStorage({ gra_pending_handoff: null }); } catch (_) {}
        console.warn("[GRA][handoff] pickup error:", e);
      }
    })();

    GRA_DEBUG && console.info("[GRA] Gemini Reading Assistant content script initialized.");
  }

  return {
    init
  };
})();

// 以 DOMContentLoaded / 已載入狀態為觸發點進行初始化。
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    GeminiReadingAssistant.init();
  });
} else {
  GeminiReadingAssistant.init();
}


