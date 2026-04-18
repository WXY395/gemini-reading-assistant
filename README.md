# Gemini Reading Assistant

> The missing reading layer for Gemini.

[![Install](https://img.shields.io/badge/Chrome%20Web%20Store-Install-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/gemini-reading-assistant/pkjhdddhfmiobolikabciojnkigjopkg)
[![Website](https://img.shields.io/badge/Website-gemini--reading--assistant-f97316)](https://wxy395.github.io/gemini-reading-assistant/)
[![Privacy](https://img.shields.io/badge/Privacy-Policy-blue)](https://wxy395.github.io/gemini-reading-assistant/privacy.html)
[![Support](https://img.shields.io/badge/Support-FAQ-green)](https://wxy395.github.io/gemini-reading-assistant/support.html)
[![Pro](https://img.shields.io/badge/Pro-Gumroad-pink)](https://gumroad.com/l/hsiowq)
[![License](https://img.shields.io/badge/License-MIT-lightgrey)](./LICENSE)

A Chrome Extension that transforms long Gemini conversations into a structured, searchable, and reusable knowledge experience.

🌐 **Live site**: https://wxy395.github.io/gemini-reading-assistant/

---

## ✨ Why this exists

Gemini is powerful — but long conversations quickly become:

* Hard to navigate
* Hard to search
* Hard to reuse
* Easy to lose context

This extension solves that by adding a **reading layer** on top of Gemini.

---

## 🚀 Core Features (Free)

### 🧭 Sidebar Navigation

* Jump between messages instantly
* Filter by: All / Gemini / User
* Structured reading for long conversations

### 🔍 In-Page Search (Enhanced Ctrl+F)

* Search only inside conversation content
* Highlight + next / previous navigation
* Ignores extension UI noise

### ✂️ Selection Toolbar

* **引用 (Quote)** — Click: insert into Gemini input / Shift+Click: save to citation clipboard
* **複製 (Copy)** — Copy selected text to clipboard

### 📌 Citation Clipboard

* Save useful outputs as reusable knowledge cards
* Insert back into Gemini input (auto-removed after insertion)
* Lightweight knowledge capture

### 🔎 Store Search (Ctrl+Shift+S)

* Search conversation content from messageStore
* Keyword highlighting + click to jump
* **IME-friendly** — Zhuyin/CJK input supported (v3.0.3+)
* Esc or Ctrl+Shift+S to close

### 📷 Screenshot Tools (Ctrl+Shift+X)

* **Region** — Drag to select rectangle
* **Element** — Hover and click to capture a block
* **Scroll** — Auto-scroll and stitch long screenshots
* Esc to cancel at any time

### 💾 Conversation Persistence

* Auto-save conversations
* Snapshot + journal system
* Export: Markdown / TXT / JSON
* TXT export uses UTF-8 BOM for Windows compatibility (v3.0.3+)

---

## ⚡ Pro Features

Unlock cognitive defense tools for power users. [Purchase on Gumroad](https://gumroad.com/l/hsiowq)

| Feature | Free | Pro |
|---------|------|-----|
| Sidebar navigation | ✅ | ✅ |
| Selection toolbar | ✅ | ✅ |
| Citation clipboard | ✅ | ✅ |
| Store search | 20 results | **Unlimited** |
| Critical Condense | — | ✅ |
| Weighted Memory (Pin & Recall) | — | ✅ |
| Context Usage Meter | — | ✅ |
| Snapshot Handoff | — | ✅ |
| Gemini Plan Selector | — | ✅ |
| Custom Condense Prompt | — | ✅ |

---

## 📦 Installation

### Chrome Web Store

[Install from Chrome Web Store](https://chromewebstore.google.com/detail/gemini-reading-assistant/pkjhdddhfmiobolikabciojnkigjopkg)

### Manual (Developer)

1. Clone the repository:

```bash
git clone https://github.com/WXY395/gemini-reading-assistant.git
```

2. Open `chrome://extensions/`
3. Enable **Developer Mode** (top right)
4. Click **Load unpacked** → select this project folder

---

## 🔐 Permissions

* `storage` → save settings & data locally
* `activeTab` → capture visible tab for screenshot feature (user-initiated only)
* `https://gemini.google.com/*` → interact with Gemini
* `https://api.gumroad.com/*` → license key verification (Pro)

No external data collection.

---

## 🔒 Privacy

1. All data is stored locally in your browser
2. No external servers are used (except Gumroad license verification)
3. No tracking or analytics
4. Conversation data never leaves your local environment

---

## 📄 License

MIT License

---

## ⚠️ Disclaimer

This project is not affiliated with Google or Gemini.

---

## ⭐ If this helps you

Give it a star — it helps a lot.

---

## 🇹🇼 中文簡介

Gemini Reading Assistant 是一款 Chrome 擴充功能，為 Google Gemini 對話加上結構化的閱讀層。

### 解決的問題

Gemini 的長對話容易失控——難以導航、難以搜尋、容易遺失重要結論。本擴充功能在 Gemini 頁面上疊加側邊欄導航、頁內搜尋、選字工具列、引用暫存夾等功能，讓你的對話不再是一條無盡的訊息流。

### 免費功能

- **側邊欄導航** — 快速跳轉訊息，支援 全部 / Gemini / 使用者 篩選
- **頁內搜尋** — 增強版 Ctrl+F，只搜尋對話內容
- **選字工具列** — 選取文字後出現「引用」+「複製」按鈕
- **引用暫存夾** — 儲存重要段落，一鍵插入 Gemini 輸入框
- **對話搜尋** — Ctrl+Shift+S 搜尋完整對話內容（支援注音輸入）
- **對話匯出** — Markdown / TXT / JSON 格式匯出（TXT 含 UTF-8 BOM）
- **截圖工具** — Ctrl+Shift+X 呼叫浮動選單，支援框選 / 元素 / 長截圖三種模式

### Pro 進階功能

透過 [Gumroad 購買授權](https://gumroad.com/l/hsiowq) 解鎖：

- **批判性濃縮** — 一鍵讓 AI 檢索邏輯漏洞、反面因素與決策基點
- **記憶錨點（Pin & Recall）** — 雙階釘選（藍色階段共識 / 金色核心目標），一鍵召回所有錨點
- **Context 用量追蹤** — 即時監控對話輪數、字數與 Context 消耗百分比
- **環境快照銜接** — 對話空間不足時，一鍵將完整環境轉移到新分頁
- **自訂濃縮提示詞** — 根據專業領域自訂批判性分析角度

### 隱私保護

所有資料儲存在本地瀏覽器，不會傳送至外部伺服器（Pro 授權驗證除外）。無追蹤、無分析。
