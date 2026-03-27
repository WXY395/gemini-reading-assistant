# Gemini Reading Assistant — 使用手冊 V3

本手冊適用於需要在本機安裝、使用、備份與還原 Gemini Reading Assistant 的使用者。

> **版本**: v2.3.1
> **封版日期**: 2026-03-26

---

## 如何在新電腦安裝插件

1. 將專案 clone 或下載到本機（例如 `git clone` 或 ZIP 解壓）
2. 開啟 Chrome，前往 `chrome://extensions/`
3. 開啟右上角「開發人員模式」
4. 點選「載入未封裝項目」
5. 選擇專案根目錄（含 `manifest.json` 的資料夾）
6. 安裝完成後，擴充功能圖示會出現在工具列

---

## 如何更新已安裝的未封裝擴充功能

- 每次從 repo 更新程式碼後，到 `chrome://extensions/` 點該擴充功能的「重新載入」圖示
- 重新整理 Gemini 頁面（F5）使新版生效
- 若移除後重裝，需再次「載入未封裝項目」並選擇專案目錄

---

## 功能總覽

| 功能 | 說明 | 觸發方式 |
|------|------|----------|
| 側邊欄導航 | 快速跳轉訊息、篩選 User/Gemini | 滑鼠移到右側邊緣 |
| 頁內搜尋 | 搜尋頁面可見文字 | `Ctrl+F` |
| 對話搜尋 | 搜尋 messageStore 中的對話內容 | `Ctrl+Shift+S` 或側邊欄 🔍 |
| 選取工具列 | 引用、解釋、摘要、展開 | 選取文字後自動出現 |
| 知識卡片 | 儲存引用片段 | 選取工具列 → 引用 |
| 訊息濃縮 | AI 回應自動摘要（⏸️ 暫停中） | Popup 手動開啟 |
| 對話匯出 | 匯出 Markdown / JSON | Popup 或快捷鍵 |

---

## 側邊欄導航

1. 將滑鼠移到頁面右側邊緣，側邊欄會自動展開
2. 點擊「≡」按鈕可固定/收合側邊欄
3. 使用頂部篩選器切換：**全部** / **Gemini** / **使用者**
4. 點擊任一訊息項目，頁面會自動捲動到該訊息
5. 點擊 **🔍** 按鈕開啟對話搜尋

---

## 對話搜尋（Store Search）

對話搜尋基於 messageStore，可搜尋完整對話內容（包含已濃縮的摘要）。

### 開啟方式

- **快捷鍵**：`Ctrl+Shift+S`（Mac：`Cmd+Shift+S`）
- **側邊欄**：點擊篩選器旁的 🔍 按鈕

### 使用方式

1. 搜尋面板會出現在頁面頂部
2. 輸入關鍵字，結果會即時顯示
3. 點擊搜尋結果，頁面會跳轉到對應訊息
4. 點擊 ✕ 關閉搜尋面板

### 搜尋範圍

- **Free 版**（預設）：搜尋訊息原文 + 摘要，最多顯示 20 筆
- **Pro 版**（未來）：加搜方法說明、無數量上限、支援多關鍵字

---

## 頁內搜尋（Page Search）

用於搜尋頁面上可見的文字內容。

- **快捷鍵**：`Ctrl+F`
- 搜尋框出現在頁面左下角
- 使用 ↑ ↓ 按鈕切換搜尋結果
- 與瀏覽器原生搜尋不同，此搜尋只搜對話區域

---

## 選取工具列

1. 在 Gemini 對話中選取任意文字
2. 工具列自動出現在選取文字上方
3. 可用操作：
   - **引用**：將選取文字加入知識卡片
   - **解釋 / 摘要 / 展開**：自動將 prompt 插入 Gemini 輸入框

---

## 知識卡片（Citation Clipboard）

- 位於頁面右下角
- 儲存從對話中引用的文字片段
- 可「插入勾選」或「全部插入」回 Gemini 輸入框
- 支援「清空全部」

---

## 訊息濃縮（Condense）⏸️ 暫停中

> ⚠️ **此功能目前預設關閉。** 由於 Gemini 回應的資料擷取穩定性尚未解決，濃縮功能暫時停用。未來將以更穩定的方式重新啟用。

- 可在 Popup 中手動開啟（`showMessageCondense` 開關）
- 開啟後，Gemini 的回應會嘗試進行規則式摘要
- 摘要顯示在原始回應上方（橙色標記區塊）
- 包含「重點」（summary）與「說明」（method）

---

## 對話匯出（Export）

### 方式一：透過 Popup

1. 點擊擴充功能圖示開啟 Popup
2. 「匯出 Markdown」→ 下載 `.md` 檔
3. 「匯出 TXT」→ 下載 `.txt` 檔

### 方式二：Store Export（新功能）

基於 messageStore 匯出，資料更完整：

- **Markdown 匯出**：包含摘要 + 原文，適合人類閱讀
- **JSON 匯出**：結構化資料，適合後續 RAG / 搜尋系統使用

JSON 格式範例：
```json
{
  "conversation": [
    {
      "id": "msg-id",
      "role": "user",
      "text": "...",
      "summary": "...",
      "method": "...",
      "condenseStatus": "ok",
      "condenseVersion": "v1",
      "createdAt": 1234567890
    }
  ]
}
```

---

## 立即保存 / 完整補抓

### 立即保存

1. 開啟 Gemini 對話頁面
2. 點擊擴充功能圖示開啟 Popup
3. 在「對話保存」區塊點「立即保存」
4. 狀態會顯示已保存筆數與上次保存時間

**說明**：僅保存目前可見的對話 blocks；若對話很長且 lazy-load，請使用「完整補抓」。

### 完整補抓

1. 在 Gemini 對話頁面開啟 Popup
2. 點「完整補抓」
3. 插件會自動捲動對話區，載入所有 lazy-loaded 訊息
4. 完成後會顯示補抓到的筆數

**說明**：適合長對話、需完整備份時使用。

---

## 如何匯出 / 匯入 JSON 備份

### 匯出

1. 開啟 Popup
2. 在「資料匯出 / 匯入」區塊點「匯出 JSON」
3. 會下載 `gra-backup-YYYY-MM-DD.json`，內含設定、引用、journal、snapshot

### 匯入

1. 在新電腦或新瀏覽器安裝插件後，開啟 Popup
2. 點「匯入 JSON」
3. 選擇先前匯出的 `.json` 檔
4. 完成後會顯示「已匯入 N 筆」

**提醒**：匯入完成後，若當前頁面狀態未立即更新，可重新整理 Gemini 分頁或關閉再開 Popup。

**說明**：匯入會覆寫現有 storage 中對應的 key，建議在全新環境使用，或先備份。

---

## 快捷鍵一覽

| 快捷鍵 | 功能 |
|--------|------|
| `Ctrl+F` | 頁內搜尋（Page Search） |
| `Ctrl+Shift+S` | 對話搜尋（Store Search） |

---

## 專案結構說明

以下結構說明主要供開發者或協作者參考；一般使用者可略過。

```
gemini-reading-assistant/
├── docs/
│   ├── PROJECT_SNAPSHOT_V8.md
│   └── USER_GUIDE_V3.md
├── utils/
│   └── storage.js
├── backups/
│   └── .gitignore
├── manifest.json
├── background.js
├── content.js
├── content.css
├── condense-engine.js
├── popup.html
├── popup.js
├── popup.css
├── gra-xhr-hook-page.js
├── gra-xhr-injector.js
├── gra-fetch-hook.js
├── gra-inspect-bridge-page.js
├── overlay-renderer.js
└── .gitignore
```

- `docs/` 進 Git
- `backups/*.json` 不進 Git
- `backups/.gitignore` 建議內容：
  ```
  *
  !.gitignore
  ```
