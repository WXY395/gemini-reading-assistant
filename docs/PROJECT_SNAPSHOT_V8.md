# Gemini Reading Assistant — Engineering Snapshot (V9)

## System Version

**V9 — Stability & Architecture Cleanup**

---

## Changes from V8

### Fixes
- **Sidebar navigation crash** — `runCondenseV75()` referenced `currentSettings` across IIFE scope boundary, causing `ReferenceError` that crashed `rebuildNavigation()`. Fixed with module-level `_moduleSettings`.
- **Settings race condition** — `GRA_UPDATE_SETTINGS` handler wrote stale `currentSettings` to storage concurrently with popup. Removed redundant `saveSettings()` call (popup already persists).
- **Storage error handling** — `chrome.runtime.lastError` was never checked in `readFromStorage` / `writeToStorage`. Now properly rejects promises on error.

### Architecture
- **Export system unified** — `exportSnapshotAsFormat()` now tries messageStore first (live DOM data with condense), falls back to storage snapshot. Removed orphaned `GRA_EXPORT_STORE_MD/JSON` handlers.
- **`finalizeMessage()` integrated into `rebuildNavigation()`** — messageStore stays populated during browsing, not just at export time.
- **`condenseObserver` removed** — global `MutationObserver` on `document.body` with `subtree:true` was never disconnected and is no longer needed.
- **`overlay-renderer.js` deleted** — dead code, incompatible DOM structure with actual `runCondenseV75()`.
- **`condense-engine.js` removed from manifest** — 4,254 lines loaded but unused (condense disabled by default). File kept in repo.
- **`gra-fetch-hook.js` removed from manifest** — MAIN world script, bridge to isolated world never connected. File kept in repo.

### UX
- **Selection toolbar simplified** — reduced from 8 buttons to 2 (引用 + 複製).
- **Quote button dual-mode** — Click: insert into Gemini input. Shift+Click: save to citation clipboard.
- **Citation clipboard collapses** — empty state shows as small "引用暫存" label; expands when quotes exist.
- **Auto-clear on insert** — quotes are removed from clipboard after being inserted into input.

---

## Current Capabilities

| Capability | Status |
|---|---|
| Sidebar navigation | ✅ |
| Selection toolbar | ✅ |
| Citation clipboard | ✅ |
| Page search | ✅ |
| Store search | ✅ |
| Conversation export (MD/TXT/JSON) | ✅ |
| Conversation persistence (journal + snapshot) | ✅ |
| XHR interception | ❌ removed (reverse engineering risk) |
| Condense engine | ⏸️ disabled (file in repo, not loaded) |
| Fetch hook | ❌ removed (reverse engineering risk) |

---

## Known Remaining Issues

1. MutationObserver root may go stale on SPA navigation
2. `messageStore` grows without eviction in long sessions
3. Auto-save interval captures stale settings reference
4. `innerHTML` usage in condense/search (low risk — condense disabled)

---

## Current Status

- **Version: 2.3.0**
- **Condense feature: ⏸️ disabled** (showMessageCondense = false, engine not loaded)
- All core features stable and tested

## Core Principles

- UX > Accuracy perfection
- Lite default, Pro optional
- UNKNOWN over hallucination
