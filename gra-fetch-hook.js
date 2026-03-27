(() => {
  const TAG = "[GRA][fetch-hook]";

  // 避免重複注入
  if (window.__GRA_FETCH_HOOK__) return;
  window.__GRA_FETCH_HOOK__ = true;

  const originalFetch = window.fetch;

  function isTarget(url) {
    return (
      url.includes("gemini.google.com") ||
      url.includes("generativelanguage.googleapis.com") ||
      url.includes("clients") ||
      url.includes("batchexecute")
    );
  }

  function isStatic(url) {
    return /\.(js|css|png|jpg|jpeg|svg|gif|woff|woff2)$/.test(url);
  }

  function stripXSSI(text) {
    if (text.startsWith(")]}'")) {
      return text.slice(4);
    }
    return text;
  }

  function tryParseJSON(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function extractText(data) {
    try {
      // 標準 Gemini API 結構
      if (data?.candidates?.[0]?.content?.parts) {
        return data.candidates[0].content.parts
          .map(p => p.text || "")
          .join("\n");
      }

      // 深度掃描（fallback）
      const found = [];

      function deepSearch(obj) {
        if (!obj) return;

        if (typeof obj === "string" && obj.length > 50) {
          found.push(obj);
        } else if (Array.isArray(obj)) {
          obj.forEach(deepSearch);
        } else if (typeof obj === "object") {
          Object.values(obj).forEach(deepSearch);
        }
      }

      deepSearch(data);

      return found.join("\n---\n");
    } catch {
      return "";
    }
  }

  function storeResult(result) {
    if (!window.__GEMINI_RAW__) {
      window.__GEMINI_RAW__ = [];
    }

    window.__GEMINI_RAW__.push(result);

    // 限制數量
    if (window.__GEMINI_RAW__.length > 50) {
      window.__GEMINI_RAW__.shift();
    }
  }

  window.fetch = async (...args) => {
    const res = await originalFetch(...args);

    try {
      const input = args[0];
      const url = (typeof input === 'string')
        ? input
        : (input instanceof Request ? input.url : String(input || ""));

      if (!isTarget(url) || isStatic(url)) {
        return res;
      }

      const clone = res.clone();
      const text = await clone.text();

      const clean = stripXSSI(text);

      let parsed = tryParseJSON(clean);

      // 如果不是 JSON，嘗試 newline JSON / batchexecute
      if (!parsed) {
        try {
          const lines = clean.split("\n").filter(l => l.trim());
          parsed = lines.map(l => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          }).filter(Boolean);
        } catch {}
      }

      const extracted = extractText(parsed);

      const result = {
        url,
        time: new Date().toISOString(),
        rawLength: text.length,
        preview: text.slice(0, 500),
        extractedText: extracted
      };

      storeResult(result);

      console.log(TAG, "Intercepted:");
      console.log(result);

    } catch (e) {
      console.warn(TAG, "Error:", e);
    }

    return res;
  };

  console.log(TAG, "Fetch hook installed");
})();

// =========================
// XHR HOOK
// =========================
// XHR hook 由 content.js（isolated world）注入 gra-xhr-hook-page.js，
// 因為 MAIN world 無法存取 chrome.runtime.getURL()。
// 見 content.js 最末段。
