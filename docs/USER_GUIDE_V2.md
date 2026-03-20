# Gemini Reading Assistant — 使用手冊 V2

本手冊適用於需要在本機安裝、使用、備份與還原 Gemini Reading Assistant 的使用者。

> **版本**: v2.1.0  
> **封版日期**: 2026-03-19

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
- 若移除後重裝，需再次「載入未封裝項目」並選擇專案目錄

---

## 如何立即保存

1. 開啟 Gemini 對話頁面（`https://gemini.google.com/` 或 coding-partner 等）
2. 點擊擴充功能圖示開啟 Popup
3. 在「對話保存」區塊點「立即保存」
4. 狀態會顯示已保存筆數與上次保存時間

**說明**：僅保存目前可見的對話 blocks；若對話很長且 lazy-load，請使用「完整補抓」。

---

## 如何完整補抓

1. 在 Gemini 對話頁面開啟 Popup
2. 點「完整補抓」
3. 插件會自動捲動對話區，載入所有 lazy-loaded 訊息
4. 完成後會顯示補抓到的筆數

**說明**：適合長對話、需完整備份時使用。

---

## 如何匯出 Markdown / TXT

1. 先完成「立即保存」或「完整補抓」
2. 在 Popup「對話保存」區塊點「匯出 Markdown」或「匯出 TXT」
3. 瀏覽器會下載 `.md` 或 `.txt` 檔

**說明**：匯出的是「已保存」的 snapshot，不是即時 DOM。若尚未保存，按鈕會顯示「尚無保存」。

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

## 如何用快照喚醒新對話

目前尚未有 snapshot 列表 UI，可依下列步驟操作：

1. 先匯入 JSON
2. 確認 Popup 已顯示保存資料（例如已保存筆數）
3. 依 `conversationKey` 或對應 URL 手動開啟原對話頁（`conversationKey` 通常對應 Gemini 對話頁的 URL path，可從備份資料或相關快照記錄中查看）
4. 需要閱讀版輸出時，再匯出 Markdown / TXT

---

## 專案結構說明

以下結構說明主要供開發者或協作者參考；一般使用者可略過。

```
gemini-reading-assistant/
├── docs/
│   ├── PROJECT_SNAPSHOT_V2.md
│   └── USER_GUIDE_V2.md
├── backups/
│   └── .gitignore
├── manifest.json
├── content.js
├── popup.html
├── ...
└── .gitignore
```

- `docs/` 進 Git
- `backups/*.json` 不進 Git
- `backups/.gitignore` 建議內容：
  ```
  *
  !.gitignore
  ```
