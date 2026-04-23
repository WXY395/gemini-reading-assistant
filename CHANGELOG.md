# Changelog

All notable changes to this project will be documented in this file.

## [3.0.12] - 2026-04-23

### Removed
- **`tabs` permission** — removed from `manifest.json` to comply with Chrome Web Store's "Purple Potassium" minimum-permission rule. The background service worker only reads `sender.tab.windowId` (a non-sensitive numeric property that requires **no** permission) to forward `chrome.tabs.captureVisibleTab(windowId, …)`. The `tabs` permission is only needed to read sensitive tab properties (`url`, `pendingUrl`, `title`, `favIconUrl`), none of which this extension reads. Permissions declared in `manifest.json` are now only `storage` + `activeTab`. No functional change.

### Changed
- `privacy.html` §4 permission table (EN + zh-TW) — removed the `tabs` row to match the updated manifest.

## [3.0.11] - 2026-04-19

### Fixed
- **Full-text search panel positioning with sidebar open** — the search panel was being pushed entirely off-screen (`left: 2048px`, `width: 0`) when Gemini's left sidebar was open. The old selector `[class*='side-nav']` accidentally matched `<chat-app class="... side-nav-open">` (a state flag on Gemini's root element, not the sidebar itself). Replaced with explicit `bard-sidenav` selector plus a sanity check that rejects any element wider than half the viewport.
- **Full-text search keyboard shortcut (`Ctrl+Shift+S`)** — was inconsistently caught when focus was inside Gemini's left sidebar. Listener now binds at `window` capture phase (earliest event path stage), uses `e.code === "KeyS"` instead of `e.key` (IME can make `e.key` read `"Process"`), and calls `stopImmediatePropagation()`.
- **IME input in search box** — typing Zhuyin/Pinyin no longer causes the candidate window to freeze or disappear. The `input` event now gates on native `InputEvent.isComposing` instead of a custom flag. The custom flag was unreliable because Gemini's capture-phase listeners could swallow `compositionend` and leave the flag stuck at `true`, silently dropping all subsequent keystrokes.
- **Screenshot capture in MV3 service worker** — `chrome.tabs.captureVisibleTab(null, …)` was failing because MV3 service workers have no "current window" concept. Background handler now reads `sender.tab.windowId` from the incoming message and passes it explicitly.
- **Screenshot "Extension context invalidated" handling** — after an extension reload but before the page is refreshed, the orphaned content script would throw an unhelpful error. The capture helper now detects this case and shows a clear toast: "擴充功能剛更新，請按 F5 重新整理頁面後再試".

### Added
- `<all_urls>` host permission — required by `chrome.tabs.captureVisibleTab`, which mandates either `<all_urls>` or `activeTab` and does not accept specific host permissions. The extension's content scripts still match only `https://gemini.google.com/*`, so no code runs on any other site. See `privacy.html` §4 for the full disclosure.

## [3.0.3] - 2026-04-18

Initial Chrome Web Store submission of the v3.0.2 feature set. The
functional content is unchanged from the v3.0.2 tag; the version bump
is only to clear CWS's strictly-monotonic version check against a
previously-reserved 3.0.2 slot.

(Content below is the v3.0.2 feature list, shipping in this CWS release.)

### Added
- **Screenshot tools** (Free tier) — `Ctrl+Shift+X` floating menu with three modes:
  - **Region** — drag to select rectangle area
  - **Element** — hover-highlight + click to capture a block
  - **Scroll** — auto-scroll and stitch into a long screenshot
  - `Esc` to cancel at any time
- **Screenshot UI in popup** — three buttons under "截圖工具" section
- `activeTab` permission added to manifest for `chrome.tabs.captureVisibleTab`

### Fixed
- **TXT export encoding** — added UTF-8 BOM so Windows Notepad opens files without garbling Chinese characters
- **TXT export Unicode normalization** — converts Gemini's math bold characters (U+1D400-U+1D7FF) back to ASCII and strips unrenderable supplementary plane emoji (U+10000+). Markdown export keeps emoji intact.
- **Search panel IME input** — Zhuyin/CJK input now works reliably by shielding keyboard/composition events at document capture phase with `stopImmediatePropagation`
- **Search panel close shortcuts** — `Esc` and `Ctrl+Shift+S` now toggle-close the search panel
- **Scroll screenshot safety** — `Esc` cancel, memory cleanup after stitch, no error recursion, scroll position restored on all exit paths, warn on Canvas truncation (>32000px)
- **captureVisibleTab validation** — background service worker validates `dataUrl` before returning success

### Security
- Removed dev-only `isPro()` bypass before release (matches origin/main)

## [3.0.1] - 2026-04-14

- Pro features with Gumroad license integration
- See [GitHub release notes](https://github.com/WXY395/gemini-reading-assistant/releases/tag/v3.0.1) for details

## [3.0.0] - 2026-04-13

- Pro version release: license verification, condense, memory pins, context meter, snapshot handoff

## [2.3.0] - Earlier

- Condense V7.5 engine, messageStore, export system, store search
