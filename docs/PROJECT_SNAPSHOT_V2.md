# Gemini Reading Assistant — V2 Project Snapshot

本文件描述 Gemini Reading Assistant 在 v2.1.0 封版時的功能、限制與後續規劃，用於開發接續、版本比對與協作同步。

> **版本**: v2.1.0
> **封版日期**: 2026-03-19
> **Manifest**: V3
> **目標瀏覽器**: Chromium-based (Chrome, Edge)
> **目標網域**: `https://gemini.google.com/*`

---

## 一句話定位

在 Gemini 網頁版注入閱讀輔助、引用、搜尋、對話保存與備份能力，全部本機執行、無遠端呼叫、僅用最小必要權限。

---

## 功能模組（已完成）

### 1. 右側段落導航 (`SidebarNavigationModule`)
- 在頁面右側建立固定浮動導航列
- 自動掃描 Gemini 對話訊息節點並建立編號清單
- 點擊平滑捲動至對應訊息
- MutationObserver + debounce 監聽 DOM 變化自動重建
- Scroll 事件高亮最接近視窗中心的節點

**MVP 範圍限制**: selector 策略保守（優先 `[data-message-id]` → `article`），不保證 Gemini DOM 改版後持續有效。

### 2. 選字浮動工具列 (`SelectionToolbarModule`)
- 選取任意文字後顯示浮動工具列
- 提供「加入引用」「解釋這段」「複製」，以及「白話解釋」「幫我舉例」「條列整理」「幫我反駁」「Cursor 指令」等多組 template 按鈕
- 點擊頁面任意處或工具列外自動隱藏

**MVP 範圍限制**: 模板為固定預設，尚無自訂 template 管理。

### 3. 引用暫存夾 (`CitationClipboardModule`)
- 面板可展開/收合，顯示所有已儲存引用
- 支援逐筆刪除、全部清空
- 自動去重（相同文字不重複新增）
- 每筆引用可直接插入 Gemini 輸入框
- 資料持久化至 `chrome.storage.local`，重新整理後不遺失

**資料格式**: `{ id: string, text: string, createdAt: number }[]`

### 4. 插入 Gemini 輸入框 (`GeminiInputIntegrationModule`)
- 三段 selector 策略安全定位 Gemini contenteditable 輸入框
- 優先透過既有可用的 DOM 插入策略寫入 Gemini 輸入框
- 目前 fallback 仍包含 `document.execCommand('insertText')`
- 目標是在不自動送出的前提下，盡量觸發 Gemini 輸入框可接受的變更事件
- 插入策略：textarea 優先 `setRangeText`；contenteditable 優先 Selection API，再 fallback execCommand

**MVP 範圍限制**: execCommand 為 deprecated API，長期應替換；不自動送出。

### 5. 本頁關鍵字搜尋 (`PageSearchModule`)
- 在頁面底部顯示浮動式搜尋列
- 可由 Popup「開啟搜尋列」重新開啟
- 已支援 Ctrl+F / Cmd+F 觸發插件搜尋列
- TreeWalker 掃描純文字節點，`splitText` 反向算法安全高亮（不修改 innerHTML）
- 上/下導航，支援 wrap-around
- 防抖 200ms 觸發搜尋
- 最大 500 筆匹配安全上限（MAX_MATCHES）
- 關閉時 `root.normalize()` 合併碎裂文字節點，不影響 Gemini 框架 DOM

**MVP 範圍限制**: 與瀏覽器原生搜尋快捷鍵存在接管與相容性風險；若 Gemini DOM 或事件傳遞變動，快捷鍵行為需再驗收。

---

## 對話保存與備份（V2）

### 核心概念

- **detectConversationKey()**：依 URL path 產生 `conversationKey`（如 `gemini:/u/1/gem/coding-partner/f3a7e7476a28b420`），作為 journal / snapshot 的 storage key 後綴
- **collectConversationBlocks()**：重用 SidebarNavigationModule 掃描能力，收集目前頁面對話 blocks
- **normalizeConversationBlock()**：將訊息節點正規化為 journal entry 格式（index、messageFingerprint、type、text、summary、sourceMessageId、capturedAt）
- **buildMessageFingerprint(text)**：從正規化文字建立指紋，供 journal 去重用

### Journal

- 採 **append-only** 設計
- 以 `messageFingerprint` 去重，避免重複寫入相同 block
- 儲存於 `gra_conversation_journal_<conversationKey>`
- 結構：`conversationKey`、`pageType`、`title`、`createdAt`、`updatedAt`、`entries[]`

### Snapshot

- 保存當下的對話狀態快照，供匯出、顯示與快速比對使用
- 儲存於 `gra_conversation_snapshot_<conversationKey>`
- 包含 `lastSavedAt`、`isPartial`、已保存訊息 entries、block count 等概念
- `isPartial: true` 表示僅保存可見區塊；`isPartial: false` 表示完整補抓後的全量快照

### 立即保存

- Popup「立即保存」或 content script 收到 `GRA_SAVE_CONVERSATION`
- 流程：收集 blocks → append journal（去重）→ 更新 snapshot → 更新 index

### Auto Save

- 每 10 分鐘檢查一次：若對話有變動（block 數或最後幾筆 fingerprint 不同），則執行與「立即保存」相同流程
- 無變動則略過寫入

### Full Backfill

- Popup「完整補抓」：自動捲動對話區，逐步載入 lazy-loaded blocks，直到 block 數不再增加
- 將完整 blocks 寫入 journal 並更新 snapshot（`isPartial: false`）

### Export Markdown / TXT

- Popup「匯出 Markdown」「匯出 TXT」：從 storage 讀取目前對話的 snapshot，序列化為 `.md` 或 `.txt` 並觸發下載
- 僅匯出「已保存」的 snapshot，不掃描 DOM

### Export / Import JSON

- **匯出 JSON**：將 `chrome.storage.local` 中所有 `gra_*` 資料匯出為單一 `.json` 檔（格式：`schemaVersion`、`exportedAt`、`app`、`data`）
- **匯入 JSON**：從檔案讀取並寫回 storage，可於新電腦或新瀏覽器還原設定、引用、journal、snapshot

---

## Popup 設定項目

| 設定鍵 | 預設值 | 說明 |
|--------|--------|------|
| `extensionEnabled` | `true` | 全域開關，關閉後所有模組停用 |
| `showNavigator` | `true` | 右側段落導航 |
| `showSelectionToolbar` | `true` | 選字浮動工具列 |
| `showQuotePanel` | `true` | 引用暫存夾面板 |
| `showGeminiInputInsertion` | `true` | 插入 Gemini 輸入框功能 |
| `showPageSearch` | `true` | 本頁關鍵字搜尋 |

---

## Storage 結構

```json
// chrome.storage.local

"gra_settings": { ... }

"gra_quotes": [ { "id", "text", "createdAt" } ]

"gra_conversation_index": { "keys": [...], "updatedAt": number }

"gra_conversation_journal_<conversationKey>": {
  "conversationKey", "pageType", "title", "createdAt", "updatedAt",
  "entries": [ { "entryId", "messageFingerprint", "messageType", "text", "summary", ... } ]
}

"gra_conversation_snapshot_<conversationKey>": {
  "conversationKey", "pageType", "title", "createdAt", "updatedAt",
  "lastSavedAt", "isPartial",
  "entries": [ { "entryId", "messageFingerprint", "messageType", "text", "summary", ... } ]
}
```

---

## 主要檔案結構

```
gemini-reading-assistant/
├── docs/
│   ├── PROJECT_SNAPSHOT_V2.md
│   └── USER_GUIDE_V2.md
├── backups/
│   └── .gitignore
├── manifest.json
├── background.js
├── content.js
├── content.css
├── popup.html
├── popup.js
├── popup.css
├── utils/
│   └── storage.js
└── .gitignore
```

- `docs/` 進 Git
- `backups/*.json` 不進 Git
- `backups/.gitignore` 建議內容：
  ```
  *
  !.gitignore
  ```

---

## 權限說明（最小必要權限）

| 權限 | 用途 |
|------|------|
| `storage` | 設定、引用、journal、snapshot 儲存至本機 |
| `host_permissions: gemini.google.com/*` | 注入 content script 至 Gemini 頁面 |

- 未使用較高權限，如 `activeTab`、`scripting`、`identity`、全站 host 權限
- 所有功能目前以最小必要權限運作
- 無遠端 API 呼叫，資料僅存本機

---

## 已知限制（V2）

1. Sidebar 類型判定仍屬 heuristic，尤其 coding-partner 頁型並非 100% 準確
2. `detectPageType()` 仍需持續驗收（coding-partner / gemini-chat / unknown）
3. execCommand 仍存在於 fallback 路徑，長期應替換
4. 匯入 JSON 後目前雖可更新設定，但若要更完整同步 quotes / snapshot / diagnostics，後續可考慮新增 `GRA_STORAGE_IMPORTED` 訊息
5. 尚未提供 snapshot 列表 UI 來直接喚醒已保存對話
6. 無雲端同步，跨裝置仍以手動 JSON 匯出 / 匯入為主

---

## 下一步 Roadmap

### P1
- Sidebar heuristic 再收斂
- 匯出 Markdown / TXT 增加 meta header（Conversation Key、Exported At、Page Type、URL、Title、Completeness、Message Count）
- 匯入後增加 `GRA_STORAGE_IMPORTED`
- `detectPageType` 驗收與修補
- Diagnostics 顯示項與 pageType / 保存狀態的一致性驗收

### P2
- 部分引用勾選後插入（若尚未完整驗收）
- 自訂模板管理
- snapshot 列表 UI / 喚醒已保存對話

### P3
- execCommand 替換為更現代的 InputEvent + Selection API 路徑
- 更完整 context export package
- 評估雲端同步
