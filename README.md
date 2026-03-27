# Gemini Reading Assistant (Beta)

> The missing reading layer for Gemini.

A Chrome Extension that transforms long Gemini conversations into a structured, searchable, and reusable knowledge experience.

---

## ⚠️ Beta Disclaimer

This extension is currently in **beta**.

* Features may change without notice
* Some behaviors are still being refined
* Gemini UI updates may temporarily break functionality

### Stability Expectations

* Core features are usable
* Edge cases may still exist
* Debug utilities are currently more permissive than production-level tools

Feedback and issue reports are highly appreciated.

---

## ✨ Why this exists

Gemini is powerful — but long conversations quickly become:

* Hard to navigate
* Hard to search
* Hard to reuse
* Easy to lose context

This extension solves that by adding a **reading layer** on top of Gemini.

---

## 🚀 Core Features

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
* Collapses to a minimal label when empty
* Lightweight knowledge capture

### 🔎 Store Search (Ctrl+Shift+S)

* Search conversation content from messageStore
* Keyword highlighting + click to jump
* Also accessible via 🔍 button in sidebar

### 💾 Conversation Persistence

* Auto-save conversations
* Snapshot + journal system
* Export: Markdown / TXT / JSON

> ⚠️ **Note:** The message condense feature is currently **disabled by default** due to extraction instability. It can be manually enabled in the popup settings.

---

## 📦 Installation (Manual)

1. Clone the repository:

```bash
git clone https://github.com/WXY395/gemini-reading-assistant.git
```

2. Open Chrome:

```
chrome://extensions/
```

3. Enable:

* Developer Mode (top right)

4. Click:

* "Load unpacked"

5. Select this project folder

---

## 🔐 Permissions

* `storage` → save settings & data
* `https://gemini.google.com/*` → interact with Gemini

No external data collection.

---

## 🔒 Privacy

1. All data is stored locally in your browser
2. No external servers are used
3. No tracking or analytics are implemented
4. This extension does **not** send any conversation data outside of your local environment

---

### Local Debug Behavior

During development or debugging, some internal state may be:

* Logged to the browser console
* Temporarily stored in DOM attributes (e.g. `data-*`)
* Exposed via debug utilities in the page context

These mechanisms are used **only for local debugging** and are not transmitted externally.

> ⚠️ Avoid sharing console logs or debug outputs if they may contain sensitive conversation content.

---

## 🧪 Debug & Inspect Utilities

This project includes internal debugging and inspection tools, such as:

* Sidebar scan diagnostics
* DOM structure inspection
* Page-context bridge utilities

These tools may expose partial conversation structure or text previews **within the local page context**.

### Important Notes

* These utilities do **not** send data externally
* They operate entirely within the local browser environment
* They may be refined or restricted in future production versions

If you are using this extension in a sensitive environment, you may choose to disable or remove these debug features.

---

## 🧠 What makes this different

This is not just a UI enhancement.

It introduces a **structured reading system for LLM conversations**:

* Message-level awareness
* DOM-aware navigation
* Persistent knowledge layer

---

## 🧭 Roadmap

### Phase 1.5

* Search + collapse coordination
* Focus mode refinement
* UX stabilization

### Phase 2

* Cross-conversation search
* Knowledge cards upgrade
* Conversation map

### Future

* Personal AI memory layer
* Local RAG integration

---

## 🤝 Contributing

Issues and feedback are welcome.

If Gemini UI updates break something, feel free to open an issue.

---

## 📄 License

MIT License

---

## ⚠️ Disclaimer

This project is not affiliated with Google or Gemini.

---

## ⭐ If this helps you

Give it a star — it helps a lot.
