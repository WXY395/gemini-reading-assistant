# Gemini Reading Assistant — Pro Version Design

**Date:** 2026-03-28
**Version:** 2.3.0 → Pro
**Status:** Approved

---

## 1. Monetization Model

**License key activation** via Gumroad / LemonSqueezy.

- User purchases on platform → receives key (format: `GRA-PRO-XXXXXXXX`)
- Enters key in popup settings → first-time online verification via platform API
- Verified result cached in `chrome.storage.local` → offline use thereafter
- Optional: re-verify every 30 days
- Device limit: configurable (e.g., max 3 activations per key)
- Suggested price: one-time US$9-15

### Verification Flow

```
Purchase → License key
  → Popup input field
    → POST to Gumroad/LemonSqueezy verify API (first time only)
      → Valid: cache { code, valid: true, verifiedAt, machineId: hash(browser fingerprint) }
      → Invalid: show error, do not unlock
    → Subsequent launches: read local cache, no network needed
    → Optional: re-verify after 30 days
```

### Privacy

- Only the license key is sent for verification — no conversation data ever leaves the browser.
- All Pro features operate locally, same as Free.

---

## 2. Free vs Pro Feature Split

| Feature | Free | Pro |
|---------|------|-----|
| Sidebar navigation | ✅ | ✅ |
| Page search (Ctrl+F) | ✅ | ✅ |
| Selection toolbar (Quote + Copy) | ✅ | ✅ |
| Citation clipboard | ✅ | ✅ |
| Conversation export (MD/TXT/JSON) | ✅ | ✅ |
| Conversation persistence | ✅ | ✅ |
| Store search | 20 results max | **Unlimited** |
| **One-click condense** | ❌ | ✅ |
| **Context memory recall** | ❌ | ✅ |
| **Context usage meter** | ❌ | ✅ |
| **Snapshot handoff** | ❌ | ✅ |

---

## 3. Pro Feature Specifications

### A. One-Click Condense

**Purpose:** Gemini responses are often verbose. One click generates a condensed summary via Gemini itself.

**Mechanism:** Insert a structured prompt into Gemini's input box, let Gemini summarize its own output.

**UI:**
- "濃縮" button on each Gemini message in the sidebar
- Clicking assembles the prompt template with the message text and inserts into input box

**Prompt template:**
```
請用 3-5 個重點條列濃縮以下內容，保留關鍵數據和結論：
---
[original message text]
---
```

**Send behavior:**
- Default: insert but do not send (user can review/edit, then press Enter)
- Settings option: enable auto-send for faster workflow

**Dependencies:** `GeminiInputIntegrationModule.insertTextIntoInput()` (existing)

---

### B. Context Memory Recall

**Purpose:** In long conversations, AI drifts and forgets earlier context. Users can pin key points and "wake up" the AI's memory.

**Components:**

1. **Memory Store** — new in-memory + storage collection
   - Key: `gra_memory_pins` in `chrome.storage.local`
   - Entry: `{ id, text, sourceMessageId, pinnedAt }`
   - Scoped per conversation (keyed by conversationKey)

2. **Pin button** — "📌" on each message in sidebar
   - Click: extract message summary (first 200 chars or user selection) → add to memory store
   - Visual indicator on pinned messages

3. **Recall button** — "🧠 喚醒記憶" in sidebar footer or popup
   - Assembles all pinned memories into a structured prompt:
   ```
   以下是我們目前討論的重點摘要，請重新聚焦：
   1. [memory 1]
   2. [memory 2]
   3. [memory 3]
   請基於以上重點繼續回答。
   ```
   - Inserts into Gemini input box

**Difference from Citation Clipboard:**

| | Citation Clipboard (Free) | Memory Recall (Pro) |
|---|---|---|
| Purpose | Copy-paste fragments | Manage conversation context |
| Content | User-selected raw text | Auto/semi-auto extracted summaries |
| Output format | Raw quote | Structured recall prompt |
| After insert | Auto-removed | **Retained** (may need multiple recalls) |

---

### C. Context Usage Meter

**Purpose:** Users cannot see how much context window space remains. This meter provides a visual estimate.

**UI:** Persistent bar at sidebar bottom.

```
📊 ██████████░░░░░ 67%
   32 輪 · 約 48,000 字
   ⚠️ 建議準備快照
```

**Estimation logic:**
```javascript
// Calculated during each rebuildNavigation()
totalChars = Σ all message text lengths
totalRounds = messageStore.size / 2
estimatedTokens = totalChars × 1.5  // Chinese average
usagePercent = estimatedTokens / contextLimit
```

**Gemini plan settings (in popup):**

| Plan | Context limit | Default |
|------|--------------|---------|
| Gemini Flash | ~32K tokens | |
| Gemini Pro | ~128K tokens | ✅ |
| Gemini Ultra / Advanced | ~1M tokens | |
| Custom | User-defined | |

**Alert thresholds:**

| Usage | Color | Behavior |
|-------|-------|----------|
| 0-50% | Green | Quiet display |
| 50-75% | Yellow | Show "建議準備快照" |
| 75%+ | Red | Show "建議匯出並開新對話" + one-click export button |

---

### D. Snapshot Handoff

**Purpose:** When context is running out, seamlessly continue the conversation in a new chat without losing context.

**One-click flow (3 steps automated):**

1. **Export** — Generate structured summary Markdown (including memory pins, not full raw text)
2. **New chat** — Open `gemini.google.com` in a new tab
3. **Inject continuation prompt** — Auto-insert into input box:
   ```
   以下是上一輪對話的重點摘要和結論，請閱讀後繼續協助我：
   ---
   [exported summary content]
   ---
   請確認你已理解以上內容，然後等待我的下一個問題。
   ```

**Difference from existing export:**

| | Export (Free) | Snapshot Handoff (Pro) |
|---|---|---|
| Output | Full raw text dump | Refined summary with memory pins |
| Flow | Manual download → manual new chat → manual paste | **One-click automated** |
| Purpose | Backup/archive | Seamless work continuation |

---

## 4. Architecture Overview

```
┌─────────────────────────────────────────┐
│ popup.js                                │
│ ┌─────────────────────────────────────┐ │
│ │ License key input + status          │ │
│ │ Gemini plan selector                │ │
│ │ Pro settings (auto-send toggle)     │ │
│ └─────────────────────────────────────┘ │
└──────────────┬──────────────────────────┘
               │ chrome.storage.local
               │ ┌──────────────────────┐
               │ │ gra_license          │
               │ │ gra_settings (plan)  │
               │ │ gra_memory_pins_*    │
               │ └──────────────────────┘
               ▼
┌─────────────────────────────────────────┐
│ content.js                              │
│ ┌───────────────────┐                   │
│ │ LicenseModule     │ ← checks isPro   │
│ └────────┬──────────┘                   │
│          ▼                              │
│ ┌───────────────────┐                   │
│ │ CondenseModule    │ Pro only          │
│ │ MemoryModule      │ Pro only          │
│ │ UsageMeterModule  │ Pro only          │
│ │ HandoffModule     │ Pro only          │
│ └───────────────────┘                   │
│ ┌───────────────────┐                   │
│ │ SidebarNavigation │ Free (enhanced)   │
│ │ SelectionToolbar  │ Free              │
│ │ CitationClipboard │ Free              │
│ │ PageSearch        │ Free              │
│ │ StoreSearch       │ Free (Pro:unlim)  │
│ └───────────────────┘                   │
└─────────────────────────────────────────┘
```

---

## 5. Implementation Priority

| Phase | Feature | Effort | Dependency |
|-------|---------|--------|------------|
| 1 | License system (verify + cache + isPro gate) | Medium | Gumroad account setup |
| 2 | Context usage meter | Low | messageStore (exists) |
| 3 | One-click condense | Low | insertTextIntoInput (exists) |
| 4 | Context memory recall | Medium | New storage + UI |
| 5 | Snapshot handoff | Medium | Memory module + export (exists) |
| 6 | Store search unlimited | Trivial | Remove limit check |

---

## 6. Files to Create/Modify

### New files
- `utils/license.js` — License verification, caching, isPro check
- `modules/condense-pro.js` — Condense prompt builder + UI
- `modules/memory.js` — Memory pin store + recall prompt builder
- `modules/usage-meter.js` — Context usage estimation + progress bar UI
- `modules/handoff.js` — Snapshot handoff automation

### Modified files
- `manifest.json` — Add new scripts, bump version
- `popup.html` — License input, plan selector, Pro settings
- `popup.js` — License UI logic, plan setting
- `content.js` — Pro module initialization gated by isPro
- `content.css` — Pro feature styles (meter, pin button, condense button)
- `utils/storage.js` — Memory pin storage keys

---

## 7. Core Principles

- **Privacy first** — Only license key verification touches the network. All features remain fully local.
- **Free stays complete** — Free version is a fully functional product, not a crippled demo.
- **Pro = productivity multiplier** — Pro features save time and manage complexity, not gate basic functionality.
- **UX > feature count** — Each Pro feature must be one-click simple.
