/**
 * XHR Hook: 注入到頁面的原生 JavaScript realm。
 * 由 gra-xhr-injector.js（isolated world, document_start）以
 * <script src="chrome-extension://..."> 注入。
 *
 * 攔截方式：Object.defineProperty 覆蓋 responseText getter。
 * 原因：<script src="chrome-extension://..."> 注入的腳本中，
 *       addEventListener("load") 的 callback 不會觸發（Chrome realm 隔離），
 *       但 property getter 是同步攔截，不受此限制。
 *
 * batchexecute 回應格式（chunked）：
 *   )]}'
 *   \n
 *   332
 *   [["wrb.fr",null,"[escaped JSON]",...]]
 *   1200
 *   [["wrb.fr","DmBxoe","[actual response with candidates]",...]]
 *   ...
 * 每個 JSON 陣列前面有一行數字表示該塊的 byte 長度。
 */
(function () {
  if (window.__GRA_XHR_SEND_HOOK__) return;
  window.__GRA_XHR_SEND_HOOK__ = true;

  var TAG = "[GRA][xhr-hook]";

  if (!window.__GEMINI_RAW__) window.__GEMINI_RAW__ = [];

  function isTargetURL(url) {
    return url && (
      url.indexOf("batchexecute") !== -1 ||
      url.indexOf("StreamGenerate") !== -1 ||
      url.indexOf("BardChatUi") !== -1
    );
  }

  /**
   * 解析 batchexecute chunked 格式。
   * 將 "332\n[[...]]\n1200\n[[...]]" 拆成各個 JSON 陣列。
   */
  function parseChunkedResponse(text) {
    var chunks = [];
    var lines = text.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      // 跳過純數字行（長度前綴）
      if (/^\d+$/.test(line)) continue;
      // 嘗試解析為 JSON
      try {
        var parsed = JSON.parse(line);
        if (Array.isArray(parsed)) {
          chunks.push(parsed);
        }
      } catch (e) {}
    }
    return chunks;
  }

  /**
   * 從 wrb.fr 陣列中提取 Gemini 回應文字。
   * wrb.fr 格式：[["wrb.fr","rpcId","<escaped JSON string>", ...]]
   * 第三個元素是一個 JSON 字串，可能包含 candidates 結構。
   */
  function extractFromWrbFr(chunks) {
    var extracted = "";
    for (var c = 0; c < chunks.length; c++) {
      var chunk = chunks[c];
      if (!Array.isArray(chunk)) continue;
      for (var i = 0; i < chunk.length; i++) {
        var entry = chunk[i];
        if (!Array.isArray(entry)) continue;
        // wrb.fr 結構：entry[0] === "wrb.fr", entry[2] === JSON string
        if (entry[0] !== "wrb.fr" || typeof entry[2] !== "string") continue;
        var jsonStr = entry[2];
        if (jsonStr.length < 50) continue;
        try {
          var data = JSON.parse(jsonStr);
          // 嘗試從 data 中找出文字內容
          var text = deepExtractText(data);
          if (text && text.length > extracted.length) {
            extracted = text;
          }
        } catch (e) {}
      }
    }
    return extracted;
  }

  /**
   * 深度搜尋資料結構，找出最長的文字內容。
   * Gemini 回應可能在 candidates[0].content.parts[].text，
   * 或在深層嵌套的陣列中。
   */
  function deepExtractText(data) {
    // 嘗試標準 candidates 結構
    try {
      if (data && data.candidates && data.candidates[0] &&
          data.candidates[0].content && data.candidates[0].content.parts) {
        var parts = data.candidates[0].content.parts;
        var text = parts.map(function(p) { return p.text || ""; }).join("\n");
        if (text.length > 30) return text;
      }
    } catch (e) {}

    // 深度掃描：找出所有長字串
    var found = [];
    function scan(obj, depth) {
      if (depth > 15 || !obj) return;
      if (typeof obj === "string" && obj.length > 100) {
        // 過濾掉明顯的非內容字串
        if (obj.indexOf("wrb.fr") === -1 && obj.indexOf("rpcId") === -1 &&
            obj.indexOf("generic_web") === -1) {
          found.push(obj);
        }
      } else if (Array.isArray(obj)) {
        for (var i = 0; i < obj.length; i++) scan(obj[i], depth + 1);
      } else if (typeof obj === "object") {
        var keys = Object.keys(obj);
        for (var k = 0; k < keys.length; k++) scan(obj[keys[k]], depth + 1);
      }
    }
    scan(data, 0);

    if (found.length > 0) {
      // 嘗試解析找到的字串（可能是嵌套的 JSON）
      for (var i = 0; i < found.length; i++) {
        if (found[i].charAt(0) === "[" || found[i].charAt(0) === "{") {
          try {
            var nested = JSON.parse(found[i]);
            var nestedText = deepExtractText(nested);
            if (nestedText && nestedText.length > 30) return nestedText;
          } catch (e) {}
        }
      }
      // 回傳最長的非 JSON 字串
      found.sort(function(a, b) { return b.length - a.length; });
      return found[0];
    }
    return "";
  }

  function processRaw(raw, url) {
    try {
      if (!raw || raw.length < 500) return;

      if (raw.substring(0, 4) === ")]}'") raw = raw.slice(4);

      var extracted = "";

      // 方法 1：直接 JSON.parse（標準 API 格式）
      try {
        var direct = JSON.parse(raw);
        extracted = deepExtractText(direct);
      } catch (e) {}

      // 方法 2：chunked batchexecute 格式
      if (!extracted) {
        var chunks = parseChunkedResponse(raw);
        if (chunks.length > 0) {
          extracted = extractFromWrbFr(chunks);
        }
      }

      // 方法 3：逐行嘗試（最後手段）
      if (!extracted) {
        var lines = raw.split("\n");
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line || /^\d+$/.test(line)) continue;
          try {
            var lineData = JSON.parse(line);
            var lineText = deepExtractText(lineData);
            if (lineText && lineText.length > extracted.length) {
              extracted = lineText;
            }
          } catch (e) {}
        }
      }

      // 品質過濾
      if (!extracted || extracted.length < 30) return;
      if (extracted.indexOf("wrb.fr") !== -1 || extracted.indexOf("rpcId") !== -1) return;

      // 去重（只保留最新最長的版本）
      if (window.__GEMINI_LAST__ && window.__GEMINI_LAST__ === extracted) return;
      window.__GEMINI_LAST__ = extracted;

      // 存儲
      var result = { url: url, rawLength: raw.length, extractedText: extracted };
      window.__GEMINI_RAW__.push(result);
      if (window.__GEMINI_RAW__.length > 20) window.__GEMINI_RAW__.shift();

      console.log(TAG, "CAPTURED:", { url: url, rawLength: raw.length, textLen: extracted.length });
    } catch (e) {
      console.warn(TAG, "processRaw error:", e);
    }
  }

  // ---- responseText getter hook ----
  var desc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "responseText");
  if (desc && desc.get) {
    var origGetter = desc.get;
    Object.defineProperty(XMLHttpRequest.prototype, "responseText", {
      get: function () {
        var val = origGetter.call(this);
        try {
          var url = this.responseURL || "";
          if (isTargetURL(url) && val && val.length >= 500) {
            // 避免對同一 XHR 重複處理（streaming 時 getter 會被多次呼叫）
            if (this.__gra_lastLen !== val.length) {
              this.__gra_lastLen = val.length;
              processRaw(val, url);
            }
          }
        } catch (e) {}
        return val;
      },
      configurable: true
    });
    console.log(TAG, "responseText getter hook installed");
  } else {
    console.warn(TAG, "Cannot find responseText getter");
  }

  console.log(TAG, "XHR hook ready (getter-based)");
})();
