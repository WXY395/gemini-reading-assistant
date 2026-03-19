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

// 未來可在此加入與 content script / popup 的簡單訊息橋接：
// chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
//   switch (message.type) {
//     case "GRA_SOME_BACKGROUND_TASK":
//       // TODO: 實作輕量的背景邏輯
//       break;
//     default:
//       break;
//   }
// });

