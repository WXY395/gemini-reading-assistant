// Gemini Reading Assistant - Background Service Worker (Manifest V3)
// -------------------------------------------------------------------
// 目前僅提供最小可用的背景腳本骨架。
// 不做任何輪詢、遠端 API 呼叫或同步行為，僅保留日後擴充的掛點。

// 在擴充功能安裝或更新時觸發，可用於初始化資料結構或遷移設定。
chrome.runtime.onInstalled.addListener((details) => {
  console.info(
    "[GRA][background] Extension installed/updated:",
    details.reason
  );

  // 未來可在此加入：
  // - 初始化預設設定到 chrome.storage.local
  // - 做版本遷移（migrations）
  // 目前 V1 不進行任何寫入以保持行為最小化。
});

// Message handler (license verification, screenshot capture, etc.)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ---- Screenshot: captureVisibleTab (must run in service worker) ----
  // ⚠️ 必須明確傳入 windowId，不能傳 null：
  //   service worker 沒有「current window」概念，傳 null Chrome 會拒絕
  //   ("Either the '<all_urls>' or 'activeTab' permission is required")。
  //   正確做法是從 sender.tab.windowId 取得發送端所在的 window。
  if (message.type === "GRA_CAPTURE_VISIBLE_TAB") {
    const windowId = sender && sender.tab && sender.tab.windowId;
    if (typeof windowId !== "number") {
      sendResponse({ ok: false, error: "no_window_id_from_sender" });
      return false;
    }
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else if (!dataUrl) {
        sendResponse({ ok: false, error: "no_data_returned" });
      } else {
        sendResponse({ ok: true, dataUrl });
      }
    });
    return true; // async sendResponse
  }

  // ---- License verification via Service Worker (avoids popup CORS issues) ----
  if (message.type === "GRA_VERIFY_LICENSE") {
    fetch("https://api.gumroad.com/v2/licenses/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        product_id: message.productId,
        license_key: message.licenseKey,
        increment_uses_count: message.incrementUses ? "true" : "false"
      })
    })
      .then((r) => r.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async sendResponse
  }
});

