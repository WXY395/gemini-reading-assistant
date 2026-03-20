# Gemini Reading Assistant — V1 Project Snapshot

> **版本**: v1.0.0
> **封版日期**: 2026-03-18
> **Manifest**: V3
> **目標瀏覽器**: Chromium-based (Chrome, Edge)
> **目標網域**: `https://gemini.google.com/*`

---

## 一句話定位

在 Gemini 網頁版注入 5 項閱讀輔助工具，全部本機執行、無遠端呼叫、僅需 `storage` 權限。

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
- 提供「加入引用」「解釋這段」兩個動作按鈕
- 點擊頁面任意處或工具列外自動隱藏

**MVP 範圍限制**: 僅 2 個固定動作，無自訂 template。

### 3. 引用暫存夾 (`CitationClipboardModule`)
- 面板可展開/收合，顯示所有已儲存引用
- 支援逐筆刪除、全部清空
- 自動去重（相同文字不重複新增）
- 每筆引用可直接插入 Gemini 輸入框
- 資料持久化至 `chrome.storage.local`，重新整理後不遺失

**資料格式**: `{ id: string, text: string, createdAt: number }[]`

### 4. 插入 Gemini 輸入框 (`GeminiInputIntegrationModule`)
- 三段 selector 策略安全定位 Gemini contenteditable 輸入框
- 使用 `document.execCommand('insertText')` 產生 trusted DOM event，確保 Gemini 框架正確接收
- 提供「引用 template」與「解釋 template」兩種插入格式
- 若輸入框已有內容則 append（加兩行空白），否則直接覆寫

**MVP 範圍限制**: `execCommand` 為 deprecated API，目前仍可用；不自動送出。

### 5. 本頁關鍵字搜尋 (`PageSearchModule`)
- 在頁面底部顯示搜尋列
- TreeWalker 掃描純文字節點，`splitText` 反向算法安全高亮（不修改 innerHTML）
- 上/下導航，支援 wrap-around
- 防抖 200ms 觸發搜尋
- 最大 500 筆匹配安全上限
- 關閉時 `root.normalize()` 合併碎裂文字節點，不影響 Gemini 框架 DOM

**MVP 範圍限制**: 無快捷鍵開啟，關閉後需重整頁面或 Popup 重新啟用。

---

## 使用方式

1. 前往 `chrome://extensions/` 開啟「開發人員模式」
2. 點選「載入未封裝項目」，選取本專案根目錄
3. 前往 `https://gemini.google.com/` 即可看到右側導航列
4. 點擊擴充圖示開啟 Popup，可獨立開啟/關閉每個模組

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

"gra_settings": {
  "extensionEnabled": true,
  "showNavigator": true,
  "showSelectionToolbar": true,
  "showQuotePanel": true,
  "showGeminiInputInsertion": true,
  "showPageSearch": true
}

"gra_quotes": [
  {
    "id": "gra-quote-{timestamp}-{random5}",
    "text": "引用文字",
    "createdAt": 1710000000000
  }
]
```

---

## 主要檔案結構

```
gemini-reading-assistant/
├── manifest.json          # MV3 宣告，permissions: [storage]
├── background.js          # Service Worker 骨架（onInstalled only）
├── content.js             # 5 大模組 + 初始化流程
├── content.css            # 所有模組 UI 樣式
├── popup.html             # 擴充功能彈窗（6 個開關）
├── popup.js               # Popup 邏輯（讀/寫 storage，通知 tab）
├── popup.css              # Popup 樣式
└── utils/
    └── storage.js         # GRAStorage 工具（settings + quotes CRUD）
```

---

## 已知限制（V1 不修復）

1. **SidebarNavigation** selector 依賴 Gemini 現有 DOM 屬性，不保證長期穩定
2. `document.execCommand` 已 deprecated，預計 V2/V3 替換
3. SelectionToolbar 無自訂 template
4. PageSearch 關閉後無快捷鍵/Popup 按鈕重新開啟
5. 引用暫存夾無數量上限（受 storage 5MB 自然限制）
6. 無 Ctrl+F 快捷鍵（與瀏覽器原生衝突）

---

## V2 Roadmap（優先順序）

### P1
- [ ] PageSearch 從 Popup 一鍵重新開啟
- [ ] `chrome.commands` 自訂快捷鍵觸發 PageSearch

### P2
- [ ] SelectionToolbar 自訂 template（最多 5 個動作）
- [ ] CitationPanel「全部插入」合併按鈕
- [ ] Navigator 訊息數 < 2 時自動隱藏

### P3
- [ ] `execCommand` 替換為 `InputEvent` + `Selection` API
- [ ] background.js message bridge（支援 SPA 路由切換）
- [ ] 引用暫存夾增加 `sourceUrl`、`sourceTitle` 欄位

---

## 權限說明

| 權限 | 用途 |
|------|------|
| `storage` | 儲存設定和引用暫存夾至本機 |
| `host_permissions: gemini.google.com/*` | 注入 content script 至 Gemini 頁面 |

**無 `tabs` 權限**（Popup 使用 `chrome.tabs.query` 仍可用，不需額外宣告）
**無遠端 API 呼叫**，所有資料僅存本機。
