# Changelog

All notable changes to this project will be documented in this file.

## [3.0.2] - 2026-04-16

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
