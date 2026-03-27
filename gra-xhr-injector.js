/**
 * gra-xhr-injector.js
 *
 * Runs at document_start in the ISOLATED world.
 * Its sole job: inject gra-xhr-hook-page.js via <script src> into the page's
 * native JavaScript realm BEFORE Gemini's scripts load and cache XHR methods.
 *
 * Why this works:
 * - document_start: runs before any page scripts
 * - Isolated world: has access to chrome.runtime.getURL()
 * - <script src="chrome-extension://...">: executes in page's native realm
 *   (bypasses MAIN world content script realm isolation)
 * - web_accessible_resources: allows the page to load the extension file
 */
(function () {
  try {
    var src = chrome.runtime.getURL("gra-xhr-hook-page.js");
    var s = document.createElement("script");
    s.src = src;
    // Append to documentElement (document.head may not exist yet at document_start)
    (document.head || document.documentElement).appendChild(s);
    console.log("[GRA][xhr-injector] Injected at document_start:", src);
  } catch (e) {
    console.warn("[GRA][xhr-injector] Failed:", e);
  }
})();
