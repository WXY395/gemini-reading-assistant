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

// ---- 模組骨架定義 ----------------------------------------------------------

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
  let scrollTicking = false;

  // 收合 / 展開 / 固定 狀態
  let isPinnedOpen = false;
  let collapseTimer = null;
  const COLLAPSE_DELAY_MS = 200;

  // 篩選狀態：'all' | 'gemini' | 'user'
  let currentFilter = "all";

  // 供 diagnostics 使用：最後使用的 selector 策略
  let lastStrategy = "none";

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
   * Heuristic 判定訊息類型（僅在 data-author / data-message-author 都不存在時使用）。
   * 順序：第一優先 user、第二優先 gemini、第三 unknown。
   * 單純有 p 不排除 user；重度結構（pre/code/table/blockquote/ul/ol/h1-h6）才作為 gemini 強訊號。
   */
  function detectMessageTypeByHeuristic(node) {
    if (!node || !(node instanceof HTMLElement)) return "unknown";

    const main =
      document.querySelector("main[role='main']") ||
      document.querySelector("main") ||
      document.body;
    if (!main) return "unknown";

    const heavyStructureSelector =
      "pre, code, table, blockquote, ul, ol, h1, h2, h3, h4, h5, h6";
    const hasHeavyStructure = !!node.querySelector(heavyStructureSelector);

    const textLen = (node.textContent || "").trim().length;
    const mainRect = main.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const mainCenterX = mainRect.left + mainRect.width / 2;
    const mainWidth = mainRect.width || 1;

    const isRight = nodeRect.left > mainCenterX;
    const isNarrow = nodeRect.width < mainWidth * 0.6;
    const isShort = textLen < 250;

    if (isRight && isNarrow && isShort && !hasHeavyStructure) return "user";
    if (
      hasHeavyStructure ||
      textLen >= 150 ||
      nodeRect.width >= mainWidth * 0.5
    )
      return "gemini";
    return "unknown";
  }

  /**
   * 判定訊息類型：gemini | user | unknown。
   * 第一層：優先 data-author、data-message-author；無則第二層 heuristic fallback。
   */
  function detectMessageType(node) {
    if (!node || !(node instanceof HTMLElement)) return "unknown";

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

    let el = node;
    const main =
      document.querySelector("main[role='main']") ||
      document.querySelector("main") ||
      document.body;
    while (el && el !== main) {
      const result = check(el);
      if (result) return result;
      el = el.parentElement;
    }

    return detectMessageTypeByHeuristic(node);
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

      toolbarEl.appendChild(filterEl);
      bodyEl.appendChild(toolbarEl);

      container.appendChild(handleEl);
      container.appendChild(bodyEl);
      console.info("[GRA][sidebar] Sidebar container created.");
    }

    if (!listEl) {
      listEl = document.createElement("div");
      listEl.className = "gra-sidebar-nav__list";
      bodyEl.appendChild(listEl);
    }

    return { container, listEl };
  }

  /**
   * 依 currentFilter 顯示/隱藏節點。
   */
  function applyFilter() {
    items.forEach((item) => {
      const match =
        currentFilter === "all" ||
        (currentFilter === "gemini" && item.messageType === "gemini") ||
        (currentFilter === "user" && item.messageType === "user");
      item.navEl.style.display = match ? "" : "none";
    });
    updateActiveItem();
  }

  /**
   * 保守、可維護的訊息節點選取策略：
   *
   * 1. 優先鎖定主內容區：
   *    - 嘗試抓取 <main role="main"> 或 <main>
   * 2. 在主內容區內，依序嘗試以下 selector：
   *    - [data-message-id]：常見於聊天訊息元素
   *    - [data-qa="message"], [data-qa="conversation-turn"]：常見 QA / 內部測試標記
   *    - [role="listitem"][data-author] 或 [data-message-author]
   *    - 最後退回到 <article> 作為一般內容區塊
   *
   * 不使用自動產生的 class 名稱（例如含隨機 hash 的類名），
   * 以降低 DOM 更新時壞掉的機率。
   */
  function findMessageElements() {
    const main =
      document.querySelector("main[role='main']") ||
      document.querySelector("main") ||
      document.body;

    if (!main) return [];

    const strategies = [
      () => Array.from(main.querySelectorAll("[data-message-id]")),
      () =>
        Array.from(
          main.querySelectorAll(
            "[data-qa='message'], [data-qa='conversation-turn']"
          )
        ),
      () =>
        Array.from(
          main.querySelectorAll(
            "[role='listitem'][data-author], [role='listitem'][data-message-author]"
          )
        ),
      () => Array.from(main.querySelectorAll("article"))
    ];

    const strategyLabels = [
      "[data-message-id]",
      "[data-qa='message'], [data-qa='conversation-turn']",
      "[role='listitem'][data-author], [role='listitem'][data-message-author]",
      "article"
    ];

    const seen = new Set();
    const messages = [];

    for (let si = 0; si < strategies.length; si++) {
      const nodes = strategies[si]();
      for (const node of nodes) {
        if (!node || !(node instanceof HTMLElement)) continue;
        if (seen.has(node)) continue;
        seen.add(node);
        messages.push(node);
      }
      if (messages.length > 0) {
        lastStrategy = strategyLabels[si];
        console.info(`[GRA][sidebar] selector used: ${strategyLabels[si]}, found: ${messages.length}`);
        return messages;
      }
    }

    const fallback = runFallbackScan(main);
    if (fallback.length > 0) {
      lastStrategy = "fallback-text-block-scan";
      console.info(
        `[GRA][sidebar] selector used: fallback block scan, found: ${fallback.length}`
      );
      return fallback;
    }

    lastStrategy = "none";
    console.info("[GRA][sidebar] No message elements found for current page structure.");
    return messages;
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
     * 父子去重：若父元素包含另一個命中元素，移除父元素，保留內層子元素。
     * 這樣可以避免 sidebar 出現巢狀的重複大容器節點。
     */
    function deduplicateParentChild(els) {
      const set = new Set(els);
      return els.filter((el) => {
        for (const other of set) {
          if (other !== el && el.contains(other)) return false;
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

  /**
   * 根據目前的訊息節點重建側邊導覽清單。
   * 會清空舊項目並重新建立，但不會重複插入外層容器。
   */
  function rebuildNavigation() {
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
      console.info("[GRA][sidebar] Sidebar hidden because no message elements were found.");
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

      const msgType = detectMessageType(node);
      const label = buildLabelFromMessage(node, index);
      const tooltipData = buildTooltipContent(node, msgType);

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
        try {
          node.scrollIntoView({
            behavior: "smooth",
            block: "center",
            inline: "nearest"
          });
        } catch (error) {
          node.scrollIntoView();
        }
      });

      listEl.appendChild(itemEl);
      items.push({
        id,
        navEl: itemEl,
        targetEl: node,
        summary: tooltipData.summary,
        messageType: msgType
      });
    });

    const counts = { gemini: 0, user: 0, unknown: 0 };
    for (const it of items) counts[it.messageType] = (counts[it.messageType] || 0) + 1;
    console.info("[GRA][sidebar] message type counts:", counts);

    applyFilter();
    updateActiveItem();
  }

  /**
   * 以 debounce 方式排程重新掃描 DOM。
   */
  function scheduleRescan() {
    if (rescanTimer) {
      clearTimeout(rescanTimer);
    }
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      rebuildNavigation();
    }, 250);
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
      if (item.navEl.style.display === "none") continue;
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

    const main =
      document.querySelector("main[role='main']") ||
      document.querySelector("main") ||
      document.body;

    if (!main) return;

    observer = new MutationObserver(() => {
      scheduleRescan();
    });

    observer.observe(main, {
      subtree: true,
      childList: true
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
  }

  return {
    /**
     * 初始化側邊導覽模組，必要時會建立 DOM 容器、掃描訊息並綁定事件。
     */
    init(settings) {
      console.info("[GRA][sidebar] init called", {
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
      console.info("[GRA][sidebar] Sidebar destroyed.");
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
      if (!settings || !settings.extensionEnabled || !settings.showNavigator) {
        this.destroy();
      } else if (!container) {
        this.init(settings);
      } else {
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
        messageType: detectMessageType(node)
      }));
    }
  };
})();

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
    btnAddQuote.textContent = "加入引用";
    btnAddQuote.addEventListener("click", handleAddQuoteClick);

    const btnExplain = document.createElement("button");
    btnExplain.type = "button";
    btnExplain.className = "gra-selection-toolbar__button";
    btnExplain.textContent = "解釋這段";
    btnExplain.addEventListener("click", handleExplainClick);

    const btnCopy = document.createElement("button");
    btnCopy.type = "button";
    btnCopy.className = "gra-selection-toolbar__button";
    btnCopy.textContent = "複製";
    btnCopy.addEventListener("click", handleCopyClick);

    row1.appendChild(btnAddQuote);
    row1.appendChild(btnExplain);
    row1.appendChild(btnCopy);

    const row2 = document.createElement("div");
    row2.className = "gra-selection-toolbar__row";

    const templateButtons = [
      { text: "白話解釋", handler: handlePlainExplainClick },
      { text: "幫我舉例", handler: handleExampleClick },
      { text: "條列整理", handler: handleBulletSummaryClick },
      { text: "幫我反駁", handler: handleCounterArgumentClick },
      { text: "Cursor 指令", handler: handleCursorInstructionClick }
    ];

    templateButtons.forEach(({ text, handler }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gra-selection-toolbar__button";
      btn.textContent = text;
      btn.addEventListener("click", handler);
      row2.appendChild(btn);
    });

    buttonsContainer.appendChild(row1);
    buttonsContainer.appendChild(row2);
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
        console.info("[GRA][selection-toolbar] Copied to clipboard.");
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
        console.info("[GRA][selection-toolbar] Copied to clipboard (fallback).");
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
   * 「加入引用」按鈕：
   * 將選取文字加入引用暫存夾，並記錄來源資訊供回跳使用。
   */
  function handleAddQuoteClick() {
    if (!currentSelectionText) return;

    const source =
      currentRange && findSourceContainerFromRange(currentRange);

    CitationClipboardModule.addQuote({
      text: currentSelectionText,
      sourceUrl: source?.sourceUrl,
      sourceMessageId: source?.sourceMessageId,
      sourceTextPreview: source?.sourceTextPreview,
      sourceSelectorHint: source?.sourceSelectorHint
    });
    hideToolbar();
  }

  /**
   * 「解釋這段」按鈕：
   * 將選取文字以解釋模板插入 Gemini 輸入框，插入後隱藏工具列。
   */
  function handleExplainClick() {
    if (!currentSelectionText) return;
    const template = GeminiInputIntegrationModule.buildExplainTemplate(currentSelectionText);
    GeminiInputIntegrationModule.insertTextIntoInput(template);
    hideToolbar();
  }

  /**
   * 模板按鈕通用邏輯：建立模板、插入輸入框、隱藏工具列。
   */
  function handleTemplateClick(buildFn) {
    if (!currentSelectionText) return;
    const template = buildFn(currentSelectionText);
    GeminiInputIntegrationModule.insertTextIntoInput(template);
    hideToolbar();
  }

  function handlePlainExplainClick() {
    handleTemplateClick(GeminiInputIntegrationModule.buildPlainExplainTemplate);
  }

  function handleExampleClick() {
    handleTemplateClick(GeminiInputIntegrationModule.buildExampleTemplate);
  }

  function handleBulletSummaryClick() {
    handleTemplateClick(GeminiInputIntegrationModule.buildBulletSummaryTemplate);
  }

  function handleCounterArgumentClick() {
    handleTemplateClick(GeminiInputIntegrationModule.buildCounterArgumentTemplate);
  }

  function handleCursorInstructionClick() {
    handleTemplateClick(GeminiInputIntegrationModule.buildCursorInstructionTemplate);
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
      return `[引用 ${i + 1}]\n「${q.text}」`;
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
    if (!listEl) return;
    listEl.textContent = "";

    syncSelectionWithQuotes(quotes);
    updateFooterButtons(quotes);

    if (!quotes || quotes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "gra-citation-panel__empty";
      empty.textContent = "尚無引用";
      listEl.appendChild(empty);
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
      const preview =
        quote.text.length > 60
          ? quote.text.slice(0, 59) + "…"
          : quote.text;
      textEl.textContent = preview;
      textEl.title = quote.text;

      const insertBtn = document.createElement("button");
      insertBtn.type = "button";
      insertBtn.className = "gra-citation-panel__item-insert";
      insertBtn.textContent = "↑";
      insertBtn.setAttribute("aria-label", "插入 Gemini 輸入框");
      insertBtn.title = "插入輸入框";
      insertBtn.addEventListener("click", () => {
        const template = GeminiInputIntegrationModule.buildQuoteTemplate(quote.text);
        GeminiInputIntegrationModule.insertTextIntoInput(template);
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
      console.info("[GRA][citation] Duplicate quote skipped:", text);
      return;
    }

    const newQuote = {
      id: `gra-quote-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text,
      createdAt: Date.now(),
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
   * 判斷 text node 是否位於插件自身的 UI 容器內。
   * 向上遍歷祖先，只要找到 class 以 gra- 開頭的元素即返回 true。
   */
  function isInsideGraUI(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el !== document.body) {
      if (
        el.className &&
        typeof el.className === "string" &&
        el.className.split(" ").some((c) => c.startsWith("gra-"))
      ) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
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
   * - class 以 gra- 開頭的插件 UI 子樹
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
 * 從已保存 snapshot 匯出為指定格式。
 * 僅從 storage 讀取，不掃描 DOM。
 */
async function exportSnapshotAsFormat(format) {
  const conversationKey = detectConversationKey();
  const GRA = typeof GRAStorage !== "undefined" ? GRAStorage : null;

  if (!GRA?.getConversationSnapshot) {
    return { success: false, reason: "no_storage" };
  }

  const snapshot = await GRA.getConversationSnapshot(conversationKey);
  if (!snapshot?.entries?.length) {
    return { success: false, reason: "no_snapshot" };
  }

  const content =
    format === "md"
      ? serializeSnapshotToMarkdown(snapshot)
      : serializeSnapshotToTxt(snapshot);

  const ext = format === "md" ? "md" : "txt";
  const safeKey = (conversationKey || "conversation")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 40);
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
  const filename = `gemini-${safeKey}-${timestamp}.${ext}`;

  return {
    success: true,
    content,
    format,
    filename
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
      console.info("[GRA] Not a supported Gemini page. Content script will stay idle.");
      return;
    }

    initialized = true;
    currentSettings = await loadSettings();

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
          applySettings(message.payload || {});
          saveSettings(currentSettings);
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
              sendResponse({ ...status, autoSave });
            } catch (e) {
              sendResponse({
                conversationKey: detectConversationKey(),
                pageType: detectPageType(),
                blockCount: 0,
                savedEntryCount: 0,
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
              const format =
                message.format === "md" || message.format === "txt"
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
        default:
          // 未識別的訊息類型可在此忽略或記錄。
          break;
      }
    });

    console.info("[GRA] Gemini Reading Assistant content script initialized.");
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

