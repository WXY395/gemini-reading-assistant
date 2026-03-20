/**
 * Page-world bridge：由 content script 以 <script src="chrome-extension://..."> 注入。
 * 不受 Gemini CSP 對 inline script 的限制（與內聯字串注入不同）。
 */
(function () {
  "use strict";
  if (typeof window === "undefined") return;
  if (typeof window.__GRA_INSPECT_TURN_STRUCTURE__ === "function") return;

  /** 最近一次探查完整結果（page world）。 */
  window.__GRA_LAST_TURN_STRUCTURE__ = null;

  /**
   * 請求 content script 掃描 DOM，回傳 Promise<payload>。
   * @param {object} [opts]
   */
  window.__GRA_INSPECT_TURN_STRUCTURE__ = function (opts) {
    return new Promise(function (resolve, reject) {
      var id =
        "gra-turn-" +
        Date.now() +
        "-" +
        Math.random().toString(36).slice(2, 11);

      function onDone(e) {
        if (!e || !e.detail || e.detail.id !== id) return;
        document.removeEventListener("__gra_turn_inspect_done__", onDone);
        clearTimeout(tid);

        var payload = e.detail.payload;
        window.__GRA_LAST_TURN_STRUCTURE__ = payload;

        var wCount =
          payload && typeof payload.turnWrapperCount === "number"
            ? payload.turnWrapperCount
            : payload && payload.wrappers
              ? payload.wrappers.length
              : 0;

        var summary = {
          ok: !!(payload && payload.ok),
          generatedAt: payload && payload.generatedAt,
          turnWrapperCount: wCount,
          error: payload && payload.error,
          rootTag: payload && payload.root && payload.root.tag,
          firstWrapperPreview:
            payload &&
            payload.wrappers &&
            payload.wrappers[0] &&
            payload.wrappers[0].textPreview,
          fullResult: "window.__GRA_LAST_TURN_STRUCTURE__"
        };

        console.info("[GRA][inspect][turn-structure]", summary);
        resolve(payload);
      }

      var tid = setTimeout(function () {
        document.removeEventListener("__gra_turn_inspect_done__", onDone);
        reject(new Error("__GRA_INSPECT_TURN_STRUCTURE__ timeout (15s)"));
      }, 15000);

      document.addEventListener("__gra_turn_inspect_done__", onDone);
      document.dispatchEvent(
        new CustomEvent("__gra_turn_inspect_run__", {
          detail: { id: id, opts: opts || {} }
        })
      );
    });
  };
})();
