# Gemini Reading Assistant — Engineering Snapshot (V10)

## System Version

**V10 — Pro Launch & Gumroad Integration**

---

## Changes from V9

### Pro Infrastructure
- **Gumroad License Key verification** — Unique keys auto-generated per sale. Verification routed through Service Worker to avoid popup CORS issues.
- **Product ID configured** — `AR4HmEQdU1OmdDAm2V3ayA==` (Gumroad's internal ID, not permalink).
- **`host_permissions` updated** — Added `https://api.gumroad.com/*` for license verification.
- **Background script upgraded** — `background.js` now handles `GRA_VERIFY_LICENSE` message for API relay.

### Fixes
- **Usage Meter not appearing on dynamic Pro activation** — `rebuildNavigation()` only called `updateUsageMeter()` without first ensuring DOM existed. Added `ensureUsageMeter()` + `ensureRecallButton()` calls.
- **Quote button missing prefix** — Direct quote insertion now uses `buildQuoteTemplate()` to prepend contextual prompt.

### UX
- **AI 回覆濃縮 toggle removed** — Feature was disabled/unused; toggle removed from popup to avoid confusion.
- **Version display updated** — Popup header now shows `V3.0.1`.

---

## Current Capabilities

| Capability | Status |
|---|---|
| Sidebar navigation | ✅ |
| Selection toolbar (引用 + 複製) | ✅ |
| Citation clipboard | ✅ |
| Page search | ✅ |
| Store search | ✅ (Pro: unlimited) |
| Conversation export (MD/TXT/JSON) | ✅ |
| Conversation persistence (journal + snapshot) | ✅ |
| **Pro: License system (Gumroad API)** | ✅ verified |
| **Pro: Context usage meter** | ✅ |
| **Pro: Critical condense (批判性基點)** | ✅ |
| **Pro: Memory pin/recall (動態權重)** | ✅ |
| **Pro: Snapshot handoff (環境快照)** | ✅ |
| **Pro: Gemini plan selector** | ✅ |
| **Pro: Custom condense prompt** | ✅ |
| XHR interception | ❌ removed |
| Condense engine | ⏸️ disabled (file in repo, not loaded) |
| Fetch hook | ❌ removed |

---

## Known Remaining Issues

1. MutationObserver root may go stale on SPA navigation
2. `messageStore` grows without eviction in long sessions
3. Auto-save interval captures stale settings reference
4. `innerHTML` usage in condense/search (low risk — condense disabled)
5. **Usage Meter round-count sync** — In rare cases where Gemini's DOM is not detected by Sidebar in time, round count may diverge from Sidebar items. Character count and percentage remain accurate.

---

## Current Status

- **Version: 3.0.1**
- **Pro features: gated behind Gumroad license verification (Service Worker relay)**
- **Gumroad product ID: `AR4HmEQdU1OmdDAm2V3ayA==`**
- **Condense feature: ⏸️ disabled in free tier** (toggle removed from popup)
- All core features stable; Pro features verified end-to-end

## Core Principles

- UX > Accuracy perfection
- Lite default, Pro optional
- UNKNOWN over hallucination
