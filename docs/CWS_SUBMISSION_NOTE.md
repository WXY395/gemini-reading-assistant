# Chrome Web Store — v3.0.0 Submission Note

## Version Update Description (Public - for CWS listing)

**English:**

> Performance improvements and internal architecture optimization.
> - Improved long-conversation loading performance with optimized DOM scanning
> - Enhanced memory management for extended browsing sessions
> - Refined UI rendering synchronization to reduce visual flickering
> - Internal logic restructuring for better maintainability

**Chinese (zh-TW):**

> 效能提升與內部架構優化。
> - 改善長對話加載速度，優化 DOM 掃描效能
> - 強化擴充使用記憶體管理機制
> - 修正 UI 渲染同步問題，減少視覺閃爍
> - 內部邏輯重構，提升可維護性

---

## Reviewer Note (Private - for CWS review team)

This update focuses on internal performance and architecture improvements:

1. **DOM scanning optimization** — Reduced sidebar rebuild frequency during streaming responses using burst-weight debounce logic.

2. **Memory management** — Added storage cleanup mechanisms for expired temporary data (auto-purge after 60 seconds) to prevent chrome.storage.local bloat in long sessions.

3. **Settings architecture** — Unified settings propagation between popup and content script via chrome.runtime messaging, eliminating race conditions in concurrent read/write scenarios.

4. **CSS rendering** — Added transition properties to sidebar elements for smoother visual updates during conversation navigation.

No new permissions requested. No changes to host_permissions or web_accessible_resources.

---

## Checklist Before Submission

- [ ] Replace `YOUR_PRODUCT_ID` in `popup.js` with actual Gumroad product permalink
- [ ] Verify manifest.json version is `3.0.0`
- [ ] Test on Chrome stable (latest)
- [ ] Confirm no console errors on gemini.google.com
- [ ] Take fresh screenshots for CWS listing (if updating visuals)
- [ ] Zip extension directory (exclude `.git`, `docs/`, `node_modules/` if any)
