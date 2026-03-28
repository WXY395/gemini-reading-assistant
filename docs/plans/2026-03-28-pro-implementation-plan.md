# Pro Version Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Pro license system and 4 Pro features (condense, memory recall, usage meter, snapshot handoff) to GRA.

**Architecture:** Feature-gated modules behind a `LicenseModule.isPro()` check. License verified once via Gumroad API, cached locally. All Pro modules are IIFE patterns matching existing codebase style in `content.js`. No external module bundler.

**Tech Stack:** Chrome Extension MV3, vanilla JS (IIFE pattern), chrome.storage.local, Gumroad License API

---

## Task 1: License Storage + isPro Gate

**Files:**
- Modify: `utils/storage.js`
- Modify: `content.js` (init section, ~line 6735)

**Step 1: Add license storage helpers to `utils/storage.js`**

Add after the existing `QUOTES_KEY` constant (line 13):

```javascript
const LICENSE_KEY = "gra_license";
```

Add these functions before the `return` statement that exposes `window.GRAStorage`:

```javascript
async function getLicense() {
  const stored = await readFromStorage([LICENSE_KEY]);
  return stored[LICENSE_KEY] || null;
}

async function saveLicense(licenseData) {
  await writeToStorage({ [LICENSE_KEY]: licenseData });
}

async function clearLicense() {
  await writeToStorage({ [LICENSE_KEY]: null });
}

function isPro(license) {
  if (!license || !license.valid) return false;
  // Optional: check expiry (30-day re-verify)
  if (license.verifiedAt) {
    const daysSinceVerify = (Date.now() - license.verifiedAt) / (1000 * 60 * 60 * 24);
    if (daysSinceVerify > 30) return false;
  }
  return true;
}
```

Expose them in the `window.GRAStorage` return object:

```javascript
getLicense,
saveLicense,
clearLicense,
isPro,
```

**Step 2: Add isPro flag to content.js init**

In `GeminiReadingAssistant` IIFE, add after `currentSettings = await loadSettings();` (line 6743):

```javascript
const license = await GRAStorage.getLicense();
const proEnabled = GRAStorage.isPro(license);
console.info("[GRA] Pro status:", proEnabled);
```

**Step 3: Commit**

```bash
git add utils/storage.js content.js
git commit -m "feat: add license storage helpers and isPro gate"
```

---

## Task 2: License Verification via Gumroad API

**Files:**
- Modify: `utils/storage.js`
- Modify: `manifest.json` (add permissions if needed)

**Step 1: Add Gumroad verification function to `utils/storage.js`**

Add before the `return` statement:

```javascript
/**
 * Verify license key via Gumroad API.
 * @param {string} key - License key (e.g., GRA-PRO-XXXXXXXX)
 * @param {string} productId - Gumroad product permalink
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
async function verifyLicenseOnline(key, productId) {
  try {
    const response = await fetch("https://api.gumroad.com/v2/licenses/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        product_id: productId,
        license_key: key,
        increment_uses_count: "true"
      })
    });

    if (!response.ok) {
      return { valid: false, error: "network_error" };
    }

    const data = await response.json();

    if (data.success) {
      const licenseData = {
        code: key,
        valid: true,
        verifiedAt: Date.now(),
        purchaseEmail: data.purchase?.email || "",
        uses: data.uses || 1
      };
      await saveLicense(licenseData);
      return { valid: true };
    } else {
      return { valid: false, error: data.message || "invalid_key" };
    }
  } catch (e) {
    return { valid: false, error: "fetch_failed" };
  }
}
```

Expose in `window.GRAStorage`:

```javascript
verifyLicenseOnline,
```

**Step 2: Check if `fetch` needs permission**

Gumroad API is `https://api.gumroad.com`. Chrome MV3 content scripts can use `fetch` to any HTTPS origin without extra permissions. No manifest change needed.

**Step 3: Commit**

```bash
git add utils/storage.js
git commit -m "feat: add Gumroad license verification API"
```

---

## Task 3: License UI in Popup

**Files:**
- Modify: `popup.html`
- Modify: `popup.js`

**Step 1: Add license section to `popup.html`**

Add before the closing `</main>` or after the last settings toggle, a new section:

```html
<!-- Pro License -->
<div class="gra-popup-section" id="gra-license-section">
  <h3 class="gra-popup-section__title">Pro</h3>
  <div id="gra-license-status" class="gra-popup-license__status">檢查中...</div>
  <div id="gra-license-input-row" style="display:none;">
    <input
      id="gra-license-key"
      type="text"
      placeholder="GRA-PRO-XXXXXXXX"
      class="gra-popup-input"
    />
    <button id="gra-btn-activate" type="button" class="gra-popup-btn gra-popup-btn--sm">
      啟用
    </button>
  </div>
  <div id="gra-license-active-row" style="display:none;">
    <span id="gra-license-active-text"></span>
    <button id="gra-btn-deactivate" type="button" class="gra-popup-btn gra-popup-btn--sm gra-popup-btn--secondary">
      取消授權
    </button>
  </div>
</div>
```

**Step 2: Add license logic to `popup.js`**

Add inside the main IIFE, after elements mapping:

```javascript
// ---- License UI ----
const GUMROAD_PRODUCT_ID = "YOUR_PRODUCT_ID"; // TODO: replace after Gumroad setup

async function initLicenseUI() {
  const statusEl = document.getElementById("gra-license-status");
  const inputRow = document.getElementById("gra-license-input-row");
  const activeRow = document.getElementById("gra-license-active-row");
  const activeText = document.getElementById("gra-license-active-text");
  const keyInput = document.getElementById("gra-license-key");
  const activateBtn = document.getElementById("gra-btn-activate");
  const deactivateBtn = document.getElementById("gra-btn-deactivate");

  if (!statusEl) return;

  const license = await GRAStorage.getLicense();
  const isPro = GRAStorage.isPro(license);

  if (isPro) {
    statusEl.textContent = "Pro 已啟用";
    statusEl.style.color = "#4ade80";
    inputRow.style.display = "none";
    activeRow.style.display = "flex";
    activeText.textContent = license.code.slice(0, 12) + "...";
  } else {
    statusEl.textContent = "Free 版本";
    inputRow.style.display = "flex";
    activeRow.style.display = "none";
  }

  activateBtn?.addEventListener("click", async () => {
    const key = (keyInput.value || "").trim();
    if (!key) return;
    activateBtn.disabled = true;
    activateBtn.textContent = "驗證中...";
    const result = await GRAStorage.verifyLicenseOnline(key, GUMROAD_PRODUCT_ID);
    if (result.valid) {
      statusEl.textContent = "Pro 已啟用";
      statusEl.style.color = "#4ade80";
      inputRow.style.display = "none";
      activeRow.style.display = "flex";
      activeText.textContent = key.slice(0, 12) + "...";
    } else {
      statusEl.textContent = "授權碼無效: " + (result.error || "unknown");
      statusEl.style.color = "#f87171";
      activateBtn.disabled = false;
      activateBtn.textContent = "啟用";
    }
  });

  deactivateBtn?.addEventListener("click", async () => {
    await GRAStorage.clearLicense();
    statusEl.textContent = "Free 版本";
    statusEl.style.color = "";
    inputRow.style.display = "flex";
    activeRow.style.display = "none";
    keyInput.value = "";
  });
}
```

Call `initLicenseUI()` at the end of the existing `DOMContentLoaded` handler.

**Step 3: Commit**

```bash
git add popup.html popup.js
git commit -m "feat: add Pro license activation UI in popup"
```

---

## Task 4: Context Usage Meter

**Files:**
- Modify: `content.js` (inside `SidebarNavigationModule` IIFE)
- Modify: `content.css`
- Modify: `utils/storage.js` (add `geminiPlan` to DEFAULT_SETTINGS)

**Step 1: Add `geminiPlan` setting**

In `utils/storage.js`, add to `DEFAULT_SETTINGS`:

```javascript
geminiPlan: "pro-128k"  // "flash-32k" | "pro-128k" | "ultra-1m" | custom number
```

**Step 2: Add usage meter to sidebar**

In `SidebarNavigationModule`, inside `ensureContainer()` or after it, add meter DOM creation:

```javascript
function createUsageMeter() {
  if (!_moduleSettings || !proEnabled) return null;
  if (document.getElementById("gra-usage-meter")) return;

  const meter = document.createElement("div");
  meter.id = "gra-usage-meter";
  meter.className = "gra-usage-meter";
  meter.innerHTML =
    '<div class="gra-usage-meter__bar"><div class="gra-usage-meter__fill"></div></div>' +
    '<div class="gra-usage-meter__label"></div>';
  return meter;
}
```

**Step 3: Add estimation logic**

In `rebuildNavigation()`, after the existing `messageElements.forEach(...)` loop, add:

```javascript
// ---- Usage Meter (Pro) ----
if (proEnabled) {
  let totalChars = 0;
  messageStore.forEach(function (msg) { totalChars += (msg.text || "").length; });
  const totalRounds = Math.ceil(messageStore.size / 2);

  const PLAN_LIMITS = {
    "flash-32k": 32000,
    "pro-128k": 128000,
    "ultra-1m": 1000000
  };
  const plan = (_moduleSettings && _moduleSettings.geminiPlan) || "pro-128k";
  const limit = typeof plan === "number" ? plan : (PLAN_LIMITS[plan] || 128000);

  const estimatedTokens = Math.round(totalChars * 1.5);
  const usagePercent = Math.min(100, Math.round((estimatedTokens / limit) * 100));

  updateUsageMeter(usagePercent, totalRounds, totalChars);
}
```

```javascript
function updateUsageMeter(percent, rounds, chars) {
  const meter = document.getElementById("gra-usage-meter");
  if (!meter) return;

  const fill = meter.querySelector(".gra-usage-meter__fill");
  const label = meter.querySelector(".gra-usage-meter__label");

  fill.style.width = percent + "%";
  fill.className = "gra-usage-meter__fill" +
    (percent >= 75 ? " gra-usage-meter__fill--danger" :
     percent >= 50 ? " gra-usage-meter__fill--warning" : "");

  const charsK = Math.round(chars / 1000);
  let hint = "";
  if (percent >= 75) hint = " · 建議匯出並開新對話";
  else if (percent >= 50) hint = " · 建議準備快照";

  label.textContent = rounds + " 輪 · 約 " + charsK + "K 字 · " + percent + "%" + hint;
}
```

**Step 4: Add CSS**

In `content.css`:

```css
/* ---- Context Usage Meter (Pro) ---- */
.gra-usage-meter {
  padding: 8px 10px;
  border-top: 1px solid rgba(148, 163, 184, 0.2);
}

.gra-usage-meter__bar {
  height: 4px;
  background: rgba(148, 163, 184, 0.2);
  border-radius: 2px;
  overflow: hidden;
}

.gra-usage-meter__fill {
  height: 100%;
  background: #4ade80;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.gra-usage-meter__fill--warning {
  background: #fbbf24;
}

.gra-usage-meter__fill--danger {
  background: #f87171;
}

.gra-usage-meter__label {
  font-size: 10px;
  color: #94a3b8;
  margin-top: 4px;
}
```

**Step 5: Commit**

```bash
git add content.js content.css utils/storage.js
git commit -m "feat: add context usage meter (Pro)"
```

---

## Task 5: One-Click Condense

**Files:**
- Modify: `content.js` (inside `SidebarNavigationModule` IIFE, `rebuildNavigation` loop)

**Step 1: Add condense button to sidebar items**

In `rebuildNavigation()`, inside the `messageElements.forEach(...)` loop, after the collapse button creation and before `listEl.appendChild`, add for Gemini messages only:

```javascript
if (msgType === "gemini" && proEnabled) {
  const condenseBtn = document.createElement("button");
  condenseBtn.type = "button";
  condenseBtn.className = "gra-sidebar-nav__condense-btn";
  condenseBtn.textContent = "濃";
  condenseBtn.title = "一鍵濃縮此回覆";
  condenseBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    const text = __gra_getSourceText(node);
    if (!text || text.length < 30) return;
    const prompt = "請用 3-5 個重點條列濃縮以下內容，保留關鍵數據和結論：\n---\n" + text + "\n---";
    GeminiInputIntegrationModule.insertTextIntoInput(prompt);

    // Auto-send if setting enabled
    if (_moduleSettings && _moduleSettings.proAutoSend) {
      setTimeout(function () {
        const sendBtn = document.querySelector('[aria-label="傳送訊息"], [data-testid="send-button"], button.send-button');
        if (sendBtn) sendBtn.click();
      }, 200);
    }
  });
  rowEl.appendChild(condenseBtn);
}
```

**Step 2: Add `proAutoSend` to DEFAULT_SETTINGS**

In `utils/storage.js`:

```javascript
proAutoSend: false
```

**Step 3: Add CSS**

```css
.gra-sidebar-nav__condense-btn {
  background: none;
  border: 1px solid rgba(148, 163, 184, 0.3);
  color: #94a3b8;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  cursor: pointer;
  margin-left: 4px;
  flex-shrink: 0;
}

.gra-sidebar-nav__condense-btn:hover {
  background: rgba(251, 191, 36, 0.2);
  color: #fbbf24;
  border-color: #fbbf24;
}
```

**Step 4: Commit**

```bash
git add content.js content.css utils/storage.js
git commit -m "feat: add one-click condense button (Pro)"
```

---

## Task 6: Context Memory Recall

**Files:**
- Modify: `utils/storage.js`
- Modify: `content.js`
- Modify: `content.css`

**Step 1: Add memory pin storage to `utils/storage.js`**

Add constant:

```javascript
const MEMORY_PINS_PREFIX = "gra_memory_pins_";
```

Add functions:

```javascript
async function getMemoryPins(conversationKey) {
  const key = MEMORY_PINS_PREFIX + conversationKey;
  const stored = await readFromStorage([key]);
  return stored[key] || [];
}

async function saveMemoryPins(conversationKey, pins) {
  const key = MEMORY_PINS_PREFIX + conversationKey;
  await writeToStorage({ [key]: pins });
}

async function addMemoryPin(conversationKey, pin) {
  const pins = await getMemoryPins(conversationKey);
  // Deduplicate by text
  if (pins.some(function (p) { return p.text === pin.text; })) return pins;
  pins.push({
    id: "pin-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
    text: pin.text,
    sourceMessageId: pin.sourceMessageId || null,
    pinnedAt: Date.now()
  });
  await saveMemoryPins(conversationKey, pins);
  return pins;
}

async function removeMemoryPin(conversationKey, pinId) {
  const pins = await getMemoryPins(conversationKey);
  const filtered = pins.filter(function (p) { return p.id !== pinId; });
  await saveMemoryPins(conversationKey, filtered);
  return filtered;
}

async function clearMemoryPins(conversationKey) {
  await saveMemoryPins(conversationKey, []);
}
```

Expose all in `window.GRAStorage`.

**Step 2: Add pin button to sidebar items**

In `rebuildNavigation()` forEach loop, add for all messages when Pro:

```javascript
if (proEnabled) {
  const pinBtn = document.createElement("button");
  pinBtn.type = "button";
  pinBtn.className = "gra-sidebar-nav__pin-btn";
  pinBtn.textContent = "📌";
  pinBtn.title = "記住此訊息重點";
  pinBtn.addEventListener("click", async function (e) {
    e.stopPropagation();
    const text = __gra_getSourceText(node);
    const summary = text.length > 200 ? text.slice(0, 197) + "..." : text;
    const convKey = detectConversationKey();
    await GRAStorage.addMemoryPin(convKey, {
      text: summary,
      sourceMessageId: id
    });
    pinBtn.textContent = "✅";
    setTimeout(function () { pinBtn.textContent = "📌"; }, 1500);
    updateRecallButton();
  });
  rowEl.appendChild(pinBtn);
}
```

**Step 3: Add recall button to sidebar footer**

After the sidebar list element, add a recall button area:

```javascript
function createRecallButton() {
  if (!proEnabled) return;
  if (document.getElementById("gra-recall-btn")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "gra-recall-btn";
  btn.className = "gra-sidebar-nav__recall-btn";
  btn.textContent = "🧠 喚醒記憶";
  btn.title = "將已釘選的重點注入對話，喚醒 AI 記憶";
  btn.style.display = "none";
  btn.addEventListener("click", async function () {
    const convKey = detectConversationKey();
    const pins = await GRAStorage.getMemoryPins(convKey);
    if (!pins.length) return;

    const segments = pins.map(function (p, i) {
      return (i + 1) + ". " + p.text;
    });
    const prompt =
      "以下是我們目前討論的重點摘要，請重新聚焦：\n\n" +
      segments.join("\n\n") +
      "\n\n請基於以上重點繼續回答。";
    GeminiInputIntegrationModule.insertTextIntoInput(prompt);
  });

  // Append after listEl inside bodyEl
  if (bodyEl) bodyEl.appendChild(btn);
}

async function updateRecallButton() {
  const btn = document.getElementById("gra-recall-btn");
  if (!btn) return;
  const convKey = detectConversationKey();
  const pins = await GRAStorage.getMemoryPins(convKey);
  btn.style.display = pins.length > 0 ? "block" : "none";
  btn.textContent = "🧠 喚醒記憶 (" + pins.length + ")";
}
```

Call `createRecallButton()` in `ensureContainer()` and `updateRecallButton()` at end of `rebuildNavigation()`.

**Step 4: Add CSS**

```css
.gra-sidebar-nav__pin-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
  flex-shrink: 0;
  opacity: 0.5;
}

.gra-sidebar-nav__pin-btn:hover {
  opacity: 1;
}

.gra-sidebar-nav__recall-btn {
  display: block;
  width: 100%;
  padding: 8px;
  margin-top: 8px;
  background: rgba(139, 92, 246, 0.15);
  border: 1px solid rgba(139, 92, 246, 0.3);
  border-radius: 8px;
  color: #c4b5fd;
  font-size: 12px;
  cursor: pointer;
  text-align: center;
}

.gra-sidebar-nav__recall-btn:hover {
  background: rgba(139, 92, 246, 0.3);
}
```

**Step 5: Commit**

```bash
git add utils/storage.js content.js content.css
git commit -m "feat: add context memory pin and recall (Pro)"
```

---

## Task 7: Snapshot Handoff

**Files:**
- Modify: `content.js`

**Step 1: Add handoff function**

Add as a top-level function (near the export functions):

```javascript
/**
 * Pro: 一鍵銜接 — 匯出重點摘要 + 開新對話 + 注入延續提示詞。
 */
async function snapshotHandoff() {
  const convKey = detectConversationKey();
  const pins = typeof GRAStorage !== "undefined"
    ? await GRAStorage.getMemoryPins(convKey)
    : [];

  // Build summary from memory pins + last few messages
  let summary = "";

  if (pins.length > 0) {
    summary += "## 重點記憶\n\n";
    pins.forEach(function (p, i) {
      summary += (i + 1) + ". " + p.text + "\n";
    });
    summary += "\n";
  }

  // Add last 3 exchanges from messageStore
  const messages = Array.from(messageStore.values())
    .sort(function (a, b) { return a.seq - b.seq; });
  const lastMessages = messages.slice(-6); // last 3 exchanges
  if (lastMessages.length > 0) {
    summary += "## 最近對話\n\n";
    lastMessages.forEach(function (msg) {
      var label = msg.role === "user" ? "使用者" : "Gemini";
      var text = msg.text.length > 300 ? msg.text.slice(0, 297) + "..." : msg.text;
      summary += "**" + label + ":** " + text + "\n\n";
    });
  }

  const continuationPrompt =
    "以下是上一輪對話的重點摘要和結論，請閱讀後繼續協助我：\n---\n" +
    summary +
    "---\n請確認你已理解以上內容，然後等待我的下一個問題。";

  // Copy to clipboard as backup
  try {
    await navigator.clipboard.writeText(continuationPrompt);
  } catch (_) {}

  // Open new Gemini tab
  window.open("https://gemini.google.com/app", "_blank");

  // After a delay, the new tab's content script will detect
  // a pending handoff and inject the prompt.
  // Store the prompt for the new tab to pick up:
  if (typeof GRAStorage !== "undefined") {
    await GRAStorage.writeToStorage({
      gra_pending_handoff: {
        prompt: continuationPrompt,
        createdAt: Date.now()
      }
    });
  }
}
```

**Step 2: Add handoff pickup in init**

In `GeminiReadingAssistant.init()`, after module initialization:

```javascript
// Check for pending handoff from previous conversation
if (proEnabled) {
  const stored = await GRAStorage.readFromStorage(["gra_pending_handoff"]);
  const handoff = stored.gra_pending_handoff;
  if (handoff && handoff.prompt && (Date.now() - handoff.createdAt) < 60000) {
    // Clear the pending handoff
    await GRAStorage.writeToStorage({ gra_pending_handoff: null });
    // Wait for page to settle, then inject
    setTimeout(function () {
      GeminiInputIntegrationModule.insertTextIntoInput(handoff.prompt);
    }, 2000);
  }
}
```

**Step 3: Wire handoff to usage meter red alert**

In `updateUsageMeter()`, when percent >= 75, add a handoff button:

```javascript
if (percent >= 75) {
  let handoffBtn = meter.querySelector(".gra-usage-meter__handoff");
  if (!handoffBtn) {
    handoffBtn = document.createElement("button");
    handoffBtn.type = "button";
    handoffBtn.className = "gra-usage-meter__handoff";
    handoffBtn.textContent = "一鍵銜接新對話";
    handoffBtn.addEventListener("click", snapshotHandoff);
    meter.appendChild(handoffBtn);
  }
} else {
  const existing = meter.querySelector(".gra-usage-meter__handoff");
  if (existing) existing.remove();
}
```

**Step 4: Add CSS**

```css
.gra-usage-meter__handoff {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 5px 8px;
  background: rgba(248, 113, 113, 0.2);
  border: 1px solid rgba(248, 113, 113, 0.4);
  border-radius: 6px;
  color: #fca5a5;
  font-size: 11px;
  cursor: pointer;
  text-align: center;
}

.gra-usage-meter__handoff:hover {
  background: rgba(248, 113, 113, 0.35);
}
```

**Step 5: Commit**

```bash
git add content.js content.css
git commit -m "feat: add snapshot handoff with auto-inject (Pro)"
```

---

## Task 8: Unlock Store Search for Pro

**Files:**
- Modify: `content.js` (~line 6381)

**Step 1: Wire `FEATURES.SEARCH_ADVANCED` to Pro status**

Replace the hardcoded `var FEATURES = { SEARCH_ADVANCED: false };` (line 6381) with:

```javascript
var FEATURES = { SEARCH_ADVANCED: false };

// Updated by init when Pro status is known
function updateProFeatures(isPro) {
  FEATURES.SEARCH_ADVANCED = isPro;
}
```

In `GeminiReadingAssistant.init()`, after the `proEnabled` check:

```javascript
updateProFeatures(proEnabled);
```

**Step 2: Commit**

```bash
git add content.js
git commit -m "feat: unlock unlimited store search for Pro"
```

---

## Task 9: Gemini Plan Selector in Popup

**Files:**
- Modify: `popup.html`
- Modify: `popup.js`

**Step 1: Add plan selector UI**

In `popup.html`, inside the license section or settings area:

```html
<div id="gra-plan-selector-row" style="display:none;">
  <label class="gra-popup-label">Gemini 方案</label>
  <select id="gra-plan-select" class="gra-popup-select">
    <option value="flash-32k">Flash (~32K)</option>
    <option value="pro-128k" selected>Pro (~128K)</option>
    <option value="ultra-1m">Ultra / Advanced (~1M)</option>
  </select>
</div>
```

**Step 2: Wire to settings in `popup.js`**

In the settings init section, show/hide plan selector based on Pro status, and save on change:

```javascript
const planSelect = document.getElementById("gra-plan-select");
const planRow = document.getElementById("gra-plan-selector-row");

if (isPro && planRow) {
  planRow.style.display = "flex";
  if (planSelect && currentSettings.geminiPlan) {
    planSelect.value = currentSettings.geminiPlan;
  }
  planSelect?.addEventListener("change", async () => {
    await saveSettings({ geminiPlan: planSelect.value });
    notifyActiveTab({ geminiPlan: planSelect.value });
  });
}
```

**Step 3: Commit**

```bash
git add popup.html popup.js
git commit -m "feat: add Gemini plan selector in popup (Pro)"
```

---

## Task 10: Bump Version + Final Integration Test

**Files:**
- Modify: `manifest.json`
- Modify: `docs/PROJECT_SNAPSHOT_V8.md`

**Step 1: Bump version**

In `manifest.json`:

```json
"version": "3.0.0"
```

**Step 2: Update project snapshot**

Update `PROJECT_SNAPSHOT_V8.md` capabilities table to reflect Pro features.

**Step 3: Test all Pro features on live Gemini page**

1. Enter a valid license key → verify Pro status shows in popup
2. Open a conversation → verify usage meter appears in sidebar
3. Click "濃" button on a Gemini message → verify prompt inserted
4. Click "📌" on messages → verify pin saved, recall button appears
5. Click "🧠 喚醒記憶" → verify recall prompt inserted
6. Store Search → verify no 20-result limit
7. Usage meter at 75%+ → verify handoff button appears
8. Click handoff → verify new tab opens with continuation prompt

**Step 4: Commit**

```bash
git add manifest.json docs/PROJECT_SNAPSHOT_V8.md
git commit -m "release: v3.0.0 — Pro version with license, condense, memory, meter, handoff"
```

---

## Optimizations (applied during implementation)

### Opt-1: Condense → 批判性決策基點 (Task 5)
Prompt 從單純摘要升級為含邏輯漏洞檢查、反面因素、決策基點的批判性分析。

### Opt-2: Memory Pin → 動態權重 (Task 6)
Pin 新增 `type` 欄位（`"core"` 核心目標 / `"phase"` 階段性結論），喚醒時依權重排序，核心目標優先。

### Opt-3: Handoff → 環境快照 (Task 7)
Handoff payload 一併傳遞 `geminiPlan` 設定值，確保新分頁 Usage Meter 立即載入正確計量標準。

### Opt-4: DOM 彈性緩衝層 (補充)
將散落各模組的 CSS Selector 集中到 `GRASelectors` 物件，提高 Gemini DOM 更新時的維護性。此項於 Task 4 開始時實作，後續 Task 5-7 共用。

---

## Summary

| Task | Feature | Estimated Effort |
|------|---------|-----------------|
| 1 | License storage + isPro gate | 10 min |
| 2 | Gumroad API verification | 15 min |
| 3 | License UI in popup | 20 min |
| 4 | Context usage meter | 20 min |
| 5 | One-click condense | 10 min |
| 6 | Context memory recall | 25 min |
| 7 | Snapshot handoff | 20 min |
| 8 | Unlock store search | 5 min |
| 9 | Gemini plan selector | 10 min |
| 10 | Version bump + integration test | 15 min |
| **Total** | | **~2.5 hours** |
