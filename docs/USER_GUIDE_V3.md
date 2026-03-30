# Gemini Reading Assistant — User Guide / 使用手冊

> **Version**: v3.0.1
> **Date**: 2026-03-30

---

## Installation / 安裝方式

### Chrome Web Store（推薦）

Search "Gemini Reading Assistant" in Chrome Web Store, or visit the extension page directly.

在 Chrome Web Store 搜尋「Gemini Reading Assistant」，或直接前往擴充功能頁面安裝。

### Manual / 手動安裝（開發者）

1. Clone or download the project / 將專案 clone 或下載到本機
2. Open `chrome://extensions/` / 前往 `chrome://extensions/`
3. Enable **Developer Mode** / 開啟「開發人員模式」
4. Click **Load unpacked** → select the project folder / 點選「載入未封裝項目」→ 選擇專案根目錄
5. Reload Gemini page / 重新整理 Gemini 頁面

---

## Feature Overview / 功能總覽

| Feature / 功能 | Description / 說明 | Trigger / 觸發方式 | Free | Pro |
|---|---|---|---|---|
| Sidebar Navigation / 側邊欄導航 | Jump between messages, filter by role / 快速跳轉訊息、篩選角色 | Hover right edge / 滑鼠移到右側邊緣 | ✅ | ✅ |
| Page Search / 頁內搜尋 | Search visible text on page / 搜尋頁面可見文字 | `Ctrl+F` | ✅ | ✅ |
| Store Search / 對話搜尋 | Search full conversation content / 搜尋完整對話內容 | `Ctrl+Shift+S` or sidebar 🔍 | 20 results | Unlimited |
| Selection Toolbar / 選字工具列 | Quote & Copy selected text / 引用與複製選取文字 | Select text / 選取文字後出現 | ✅ | ✅ |
| Citation Clipboard / 引用暫存夾 | Save & reuse important excerpts / 儲存引用片段 | Toolbar → Quote (Shift+Click) | ✅ | ✅ |
| Export / 對話匯出 | Markdown / TXT / JSON export / 匯出對話紀錄 | Popup buttons / Popup 按鈕 | ✅ | ✅ |
| Critical Condense / 批判性濃縮 | One-click decision analysis / 一鍵決策分析 | Sidebar「濃」button | — | ✅ |
| Memory Pin & Recall / 記憶錨點 | Pin insights, recall as prompt / 釘選重要結論並召回 | Sidebar 📌 + 🧠 button | — | ✅ |
| Context Usage Meter / 上下文用量 | Track rounds, tokens, percentage / 追蹤輪數、字數、百分比 | Sidebar bottom / 側邊欄底部 | — | ✅ |
| Snapshot Handoff / 環境快照銜接 | Transfer context to new tab / 跨分頁轉移對話環境 | Usage Meter 80% alert | — | ✅ |
| Custom Condense Prompt / 自訂濃縮提示詞 | Customize analysis angle / 自訂批判性分析角度 | Popup → Pro tab | — | ✅ |
| Gemini Plan Selector / 方案選擇器 | Set context limit (32K/128K/1M) / 設定上下文上限 | Popup → Pro tab | — | ✅ |

---

## Free Features / 免費功能

### Sidebar Navigation / 側邊欄導航

Hover over the right edge of the page to expand the sidebar. Click any message item to scroll to it. Use the filter tabs (All / Gemini / User) to narrow down messages.

將滑鼠移到頁面右側邊緣，側邊欄自動展開。點擊任一訊息項目跳轉到該位置。使用頂部篩選器切換：**全部** / **Gemini** / **使用者**。

### Page Search / 頁內搜尋

Press `Ctrl+F` to open. Searches only conversation content (ignores extension UI). Use ↑ ↓ buttons to navigate between results.

按 `Ctrl+F` 開啟。只搜尋對話區域的文字內容。使用 ↑ ↓ 按鈕切換搜尋結果。

### Selection Toolbar / 選字工具列

Select any text in a Gemini conversation to trigger the floating toolbar:

在 Gemini 對話中選取任意文字，浮動工具列自動出現：

- **Quote / 引用** — Click: insert into Gemini input with context prompt. Shift+Click: save to citation clipboard.
- **Copy / 複製** — Copy selected text to clipboard.

點擊「引用」：將選取文字以引用模板插入輸入框。Shift+點擊：存入引用暫存夾。

### Citation Clipboard / 引用暫存夾

Located at the bottom-right corner. Save important excerpts from conversations and insert them back into Gemini input.

位於頁面右下角。儲存對話中的重要片段，一鍵插回 Gemini 輸入框。

- **Insert Selected / 插入勾選** — Insert checked quotes into input
- **Insert All / 全部插入** — Insert all quotes at once
- Quotes are auto-removed after insertion / 插入後自動清除

### Store Search / 對話搜尋

Press `Ctrl+Shift+S` or click the 🔍 button in the sidebar. Searches the full conversation content from messageStore.

按 `Ctrl+Shift+S` 或點擊側邊欄的 🔍 按鈕。搜尋範圍為完整對話內容。

- Free: max 20 results / 免費版：最多 20 筆
- Pro: unlimited / Pro 版：無限制

### Export / 對話匯出

Open the extension popup and use the export buttons:

開啟擴充功能 Popup，使用匯出按鈕：

- **Export Markdown / 匯出 Markdown** — Human-readable format / 適合閱讀
- **Export TXT / 匯出 TXT** — Plain text format / 純文字格式
- **Save Now / 立即保存** — Save current conversation state / 保存目前對話狀態
- **Full Capture / 完整補抓** — Auto-scroll to capture all lazy-loaded messages / 自動捲動載入所有訊息

### JSON Backup / JSON 備份

- **Export JSON / 匯出 JSON** — Downloads `gra-backup-YYYY-MM-DD.json` containing settings, citations, journal, and snapshots
- **Import JSON / 匯入 JSON** — Restore from a previous backup file

匯出包含設定、引用、journal、snapshot 的完整備份。匯入會覆寫現有資料。

---

## Pro Features / Pro 進階功能

Purchase a license key from [Gumroad](https://gumroad.com/l/hsiowq) to unlock Pro features.

透過 [Gumroad 購買授權](https://gumroad.com/l/hsiowq) 解鎖 Pro 功能。

### Activation / 啟用方式

1. Purchase on Gumroad → receive your unique license key / 在 Gumroad 購買後取得唯一授權碼
2. Click the GRA icon in Chrome toolbar → open popup / 點擊工具列的 GRA 圖示
3. Go to the **Pro** section → paste your key → click **Activate** / 在 Pro 區塊貼上授權碼 → 點擊「啟用」
4. All Pro features activate immediately / 所有 Pro 功能立即啟用

### Critical Condense / 批判性濃縮

Click the「濃」button next to any Gemini response in the sidebar. A critical analysis prompt is injected into the input box:

點擊側邊欄中 Gemini 回覆旁的「濃」按鈕，批判性分析提示詞會注入輸入框：

- Surfaces logical gaps / 檢索邏輯漏洞
- Identifies overlooked counter-arguments / 識別被忽略的反面因素
- Locks decision basepoints / 鎖定決策基點

You can customize the prompt in Popup → Pro → "Decision Condense Lens" textarea.

可在 Popup → Pro →「決策濃縮鏡頭」文字區域自訂提示詞。

### Memory Pin & Recall / 記憶錨點與喚醒

**Pin / 釘選:**

Click the 📌 button next to any message in the sidebar. Three-state cycle:

點擊側邊欄中訊息旁的 📌 按鈕，三態循環切換：

1. Not pinned / 未釘選 → 📌 Blue (Phase consensus / 藍色：階段共識)
2. Blue → 📌 Gold (Core objective / 金色：核心目標)
3. Gold → Unpinned / 取消釘選

**Recall / 喚醒:**

When pins exist, the「🧠 喚醒記憶」button appears at the bottom of the sidebar. Click it to inject all pinned content into the input box. Core pins are marked with `[CRITICAL PROJECT BASEPOINT]` and placed first.

當有釘選內容時，側邊欄底部出現「🧠 喚醒記憶」按鈕。點擊後將所有釘選內容注入輸入框。核心錨點標記為 `[CRITICAL PROJECT BASEPOINT]` 並優先排列。

### Context Usage Meter / 上下文用量追蹤

Displayed at the bottom of the sidebar. Shows:

顯示在側邊欄底部：

- Rounds / 對話輪數
- Character count / 字數估算
- Context window percentage / 上下文消耗百分比

Alerts at 50%, 80%, and 95% thresholds. At 80%, a handoff prompt appears.

在 50%、80%、95% 時發出警告。80% 時會出現環境快照銜接提示。

### Snapshot Handoff / 環境快照銜接

When context usage is high, click the handoff button to export your conversation state — including memory pins and Gemini plan settings — to a new tab. Continue working without losing project context.

對話空間不足時，點擊銜接按鈕將對話狀態（含記憶錨點和 Gemini 方案設定）匯出至新分頁，無縫延續工作。

### Gemini Plan Selector / 方案選擇器

In Popup → Pro, select your Gemini plan to calibrate the usage meter:

在 Popup → Pro 中選擇你的 Gemini 方案以校準用量計算：

- Flash (~32K) — Free Gemini users
- Pro (~128K) — Google AI Plus subscribers
- Ultra (~1M) — Future large-context models

---

## Keyboard Shortcuts / 快捷鍵

| Shortcut / 快捷鍵 | Function / 功能 |
|---|---|
| `Ctrl+F` | Page Search / 頁內搜尋 |
| `Ctrl+Shift+S` | Store Search / 對話搜尋 |

---

## Privacy / 隱私保護

- All data is stored locally in your browser / 所有資料儲存在本地瀏覽器
- No external servers (except Gumroad license verification) / 不使用外部伺服器（Pro 授權驗證除外）
- No tracking or analytics / 無追蹤、無分析
- Conversation data never leaves your local environment / 對話資料不會離開本地環境

---

## Troubleshooting / 疑難排解

| Issue / 問題 | Solution / 解決方式 |
|---|---|
| Sidebar not appearing / 側邊欄未出現 | Reload extension + refresh Gemini page / 重新載入擴充功能 + 重新整理頁面 |
| Pro features not showing / Pro 功能未顯示 | Check license status in Popup → Pro / 檢查 Popup 的 Pro 授權狀態 |
| Usage Meter missing / 用量計未出現 | Refresh Gemini page after Pro activation / 啟用 Pro 後重新整理頁面 |
| Export produces empty file / 匯出檔案為空 | Click "Save Now" first, then export / 先點「立即保存」再匯出 |
