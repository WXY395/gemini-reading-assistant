// Gemini Reading Assistant - Popup Script
// ---------------------------------------
// 這個檔案負責：
// - 從 chrome.storage.local 讀取目前設定
// - 將設定同步到 popup UI
// - 監聽使用者切換開關，立即儲存設定
// - 通知目前的 Gemini 分頁更新設定

(function () {
  /**
   * 取得 popup 中會用到的 DOM 元素。
   */
  function getElements() {
    return {
      extensionEnabled: document.getElementById("gra-toggle-enabled"),
      showNavigator: document.getElementById("gra-toggle-sidebar"),
      showSelectionToolbar: document.getElementById("gra-toggle-selection-toolbar"),
      showQuotePanel: document.getElementById("gra-toggle-citation"),
      showGeminiInputInsertion: document.getElementById("gra-toggle-gemini-input"),
      showPageSearch: document.getElementById("gra-toggle-page-search"),
      showMessageCondense: document.getElementById("gra-toggle-message-condense"),
      btnOpenSearch: document.getElementById("gra-btn-open-search"),
      btnRefreshDiagnostics: document.getElementById("gra-btn-refresh-diagnostics"),
      btnSaveConversation: document.getElementById("gra-btn-save-conversation"),
      btnFullBackfill: document.getElementById("gra-btn-full-backfill"),
      btnExportMd: document.getElementById("gra-btn-export-md"),
      btnExportTxt: document.getElementById("gra-btn-export-txt"),
      btnExportData: document.getElementById("gra-btn-export-data"),
      btnImportData: document.getElementById("gra-btn-import-data"),
      inputImportFile: document.getElementById("gra-input-import-file"),
      dataIoStatus: document.getElementById("gra-data-io-status"),
      journalStatusText: document.getElementById("gra-journal-status-text"),
      journalSavedCount: document.getElementById("gra-journal-saved-count"),
      autoSaveStatus: document.getElementById("gra-auto-save-status"),
      diagPageType: document.getElementById("gra-diag-page-type"),
      diagSidebar: document.getElementById("gra-diag-sidebar"),
      diagToolbar: document.getElementById("gra-diag-toolbar"),
      diagCitation: document.getElementById("gra-diag-citation"),
      diagSearch: document.getElementById("gra-diag-search"),
      diagInput: document.getElementById("gra-diag-input"),
      cardsSearch: document.getElementById("gra-cards-search"),
      cardsList: document.getElementById("gra-cards-list")
    };
  }

  /**
   * 自 gra_quotes 讀取卡片並依搜尋框即時篩選（text / note / tags）。
   */
  async function renderKnowledgeCards(elements) {
    const listEl = elements.cardsList;
    const inputEl = elements.cardsSearch;
    if (!listEl || !inputEl || typeof GRAStorage === "undefined" || !GRAStorage.getQuotes) {
      return;
    }
    let all = [];
    try {
      all = await GRAStorage.getQuotes();
    } catch (_) {
      all = [];
    }
    const query = inputEl.value || "";
    const filtered =
      typeof GRAStorage.searchCards === "function"
        ? GRAStorage.searchCards(all, query)
        : all;

    listEl.textContent = "";
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "gra-popup-cards__empty";
      empty.textContent = all.length === 0 ? "尚無卡片" : "無符合結果";
      listEl.appendChild(empty);
      return;
    }

    filtered.forEach((c) => {
      const row = document.createElement("div");
      row.className = "gra-popup-cards__row";
      const text = document.createElement("div");
      text.className = "gra-popup-cards__text";
      const raw = String(c.text || "");
      text.textContent = raw.length > 140 ? raw.slice(0, 139) + "…" : raw;
      row.appendChild(text);
      if (c.source) {
        const meta = document.createElement("div");
        meta.className = "gra-popup-cards__meta";
        meta.textContent = String(c.source).slice(0, 100);
        row.appendChild(meta);
      }
      listEl.appendChild(row);
    });
  }

  /**
   * 觸發檔案下載（blob + anchor）。
   */
  function triggerDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * 匯出 snapshot 為指定格式並觸發下載。
   */
  async function exportSnapshotAndDownload(elements, format) {
    const btn = format === "md" ? elements.btnExportMd : elements.btnExportTxt;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "匯出中…";
    }

    try {
      const tabs = await new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, resolve);
      });
      const activeTab = tabs && tabs[0];
      if (!activeTab?.id) {
        if (btn) {
          btn.textContent = format === "md" ? "匯出 Markdown" : "匯出 TXT";
          btn.disabled = false;
        }
        return;
      }

      const result = await new Promise((resolve) => {
        chrome.tabs.sendMessage(
          activeTab.id,
          { type: "GRA_EXPORT_SNAPSHOT", format },
          (res) => {
            if (chrome.runtime.lastError)
              resolve({ success: false, reason: "content_unavailable" });
            else resolve(res || { success: false, reason: "no_response" });
          }
        );
      });

      if (result.success && result.content && result.filename) {
        const mime = format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8";
        triggerDownload(result.content, result.filename, mime);
        if (btn) btn.textContent = "已下載";
      } else {
        if (btn) btn.textContent = result.reason === "no_snapshot" ? "尚無保存" : "匯出失敗";
      }

      if (btn) {
        setTimeout(() => {
          btn.textContent = format === "md" ? "匯出 Markdown" : "匯出 TXT";
          btn.disabled = false;
        }, 1500);
      }
    } catch (_) {
      if (btn) {
        btn.textContent = format === "md" ? "匯出 Markdown" : "匯出 TXT";
        btn.disabled = false;
      }
    }
  }

  /**
   * 向目前分頁請求對話保存狀態並更新 UI。
   */
  async function fetchAndRenderJournalStatus(elements) {
    const fallback = () => {
      if (elements.journalStatusText) elements.journalStatusText.textContent = "非 Gemini 分頁";
      if (elements.journalSavedCount) elements.journalSavedCount.textContent = "—";
      if (elements.autoSaveStatus) elements.autoSaveStatus.textContent = "—";
      if (elements.btnFullBackfill) elements.btnFullBackfill.disabled = true;
      if (elements.btnExportMd) elements.btnExportMd.disabled = true;
      if (elements.btnExportTxt) elements.btnExportTxt.disabled = true;
    };

    try {
      const tabs = await new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, resolve);
      });
      const activeTab = tabs && tabs[0];
      if (!activeTab || !activeTab.id) {
        fallback();
        return;
      }

      const status = await new Promise((resolve) => {
        chrome.tabs.sendMessage(
          activeTab.id,
          { type: "GRA_GET_CONVERSATION_STATUS" },
          (res) => {
            if (chrome.runtime.lastError) resolve(null);
            else resolve(res);
          }
        );
      });

      if (!status) {
        fallback();
        return;
      }

      if (elements.journalStatusText) {
        const blockInfo = `${status.blockCount} blocks`;
        const savedInfo = status.lastSavedAt
          ? `上次保存 ${new Date(status.lastSavedAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}`
          : "尚未保存";
        elements.journalStatusText.textContent = `${blockInfo} · ${savedInfo}`;
      }
      if (elements.journalSavedCount) {
        elements.journalSavedCount.textContent = `${status.savedEntryCount} 筆`;
      }
      if (elements.autoSaveStatus && status.autoSave) {
        const a = status.autoSave;
        const enabled = a.enabled ? "每 10 分鐘" : "關閉";
        const result =
          a.lastResult === "saved"
            ? "已自動保存"
            : a.lastResult === "skipped"
              ? "無變動略過"
              : a.lastResult === "error"
                ? "錯誤"
                : "待檢查";
        const last =
          a.lastAutoSavedAt
            ? new Date(a.lastAutoSavedAt).toLocaleTimeString("zh-TW", {
                hour: "2-digit",
                minute: "2-digit"
              })
            : "—";
        elements.autoSaveStatus.textContent = `${enabled} · ${result} · ${last}`;
      }
      if (elements.btnFullBackfill) {
        elements.btnFullBackfill.disabled = !(status.blockCount > 0);
      }
      const hasData = (status.savedEntryCount ?? 0) > 0 || (status.messageStoreCount ?? 0) > 0;
      if (elements.btnExportMd) {
        elements.btnExportMd.disabled = !hasData;
      }
      if (elements.btnExportTxt) {
        elements.btnExportTxt.disabled = !hasData;
      }
    } catch (_) {
      fallback();
    }
  }

  /**
   * 向目前分頁請求 diagnostics 並更新 UI。
   */
  async function fetchAndRenderDiagnostics(elements) {
    const fallback = () => {
      if (elements.diagPageType) elements.diagPageType.textContent = "非 Gemini 分頁";
      if (elements.diagSidebar) elements.diagSidebar.textContent = "—";
      if (elements.diagToolbar) elements.diagToolbar.textContent = "—";
      if (elements.diagCitation) elements.diagCitation.textContent = "—";
      if (elements.diagSearch) elements.diagSearch.textContent = "—";
      if (elements.diagInput) elements.diagInput.textContent = "—";
    };

    try {
      const tabs = await new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, resolve);
      });
      const activeTab = tabs && tabs[0];
      if (!activeTab || !activeTab.id) {
        fallback();
        return;
      }

      const response = await new Promise((resolve) => {
        chrome.tabs.sendMessage(activeTab.id, { type: "GRA_GET_DIAGNOSTICS" }, (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        });
      });

      if (!response) {
        fallback();
        return;
      }

      if (elements.diagPageType) elements.diagPageType.textContent = response.pageType || "—";
      if (elements.diagSidebar) {
        const s = response.sidebar;
        elements.diagSidebar.textContent = s
          ? `${s.initialized ? "✓" : "✗"} ${s.messageCount ?? "—"} blocks, ${s.strategy ?? "—"}`
          : "—";
      }
      if (elements.diagToolbar) {
        const t = response.selectionToolbar;
        elements.diagToolbar.textContent = t ? (t.initialized ? "✓ 已啟用" : "✗") : "—";
      }
      if (elements.diagCitation) {
        const c = response.citationPanel;
        elements.diagCitation.textContent = c
          ? `${c.initialized ? "✓" : "✗"} ${c.quoteCount ?? 0} 筆`
          : "—";
      }
      if (elements.diagSearch) {
        const s = response.searchUI;
        elements.diagSearch.textContent = s
          ? `${s.initialized ? "✓" : "✗"} ${s.visible ? "顯示中" : "隱藏"}`
          : "—";
      }
      if (elements.diagInput) {
        const i = response.inputIntegration;
        elements.diagInput.textContent = i ? (i.selectorType || "—") : "—";
      }
    } catch (_) {
      fallback();
    }
  }

  /**
   * 從 storage 讀取設定並更新 UI 狀態。
   * 優先使用 utils/storage.js 中的 GRAStorage，如不可用則回落到直接呼叫 chrome.storage.local。
   */
  async function loadSettings() {
    if (typeof GRAStorage !== "undefined" && GRAStorage.getSettings) {
      return GRAStorage.getSettings();
    }

    // 後備實作：直接從 chrome.storage.local 讀取。
    const DEFAULT_SETTINGS = {
      extensionEnabled: true,
      showNavigator: true,
      showQuotePanel: true,
      showMessageCondense: false
    };

    return new Promise((resolve) => {
      chrome.storage.local.get(["gra_settings"], (result) => {
        const stored = result.gra_settings || {};
        resolve({ ...DEFAULT_SETTINGS, ...stored });
      });
    });
  }

  /**
   * 儲存設定到 storage。
   */
  async function saveSettings(partialSettings) {
    if (typeof GRAStorage !== "undefined" && GRAStorage.saveSettings) {
      return GRAStorage.saveSettings(partialSettings);
    }

    // 後備實作：讀取舊設定後合併寫回。
    const current = await loadSettings();
    const next = { ...current, ...partialSettings };

    return new Promise((resolve) => {
      chrome.storage.local.set({ gra_settings: next }, () => resolve());
    });
  }

  /**
   * 對目前作用中的分頁發送 GRA_OPEN_SEARCH_UI，要求重新顯示搜尋列。
   * 若分頁不是 Gemini 或 content script 未注入，靜默略過。
   */
  function sendOpenSearchUI() {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs && tabs[0];
        if (!activeTab || !activeTab.id) return;

        chrome.tabs.sendMessage(
          activeTab.id,
          { type: "GRA_OPEN_SEARCH_UI" },
          () => {
            if (chrome.runtime.lastError) {
              console.warn(
                "[GRA][popup] Could not open search UI (tab may not be Gemini):",
                chrome.runtime.lastError.message
              );
            }
          }
        );
      });
    } catch (error) {
      console.warn("[GRA][popup] Failed to send open search UI:", error);
    }
  }

  /**
   * 嘗試通知目前作用中的 Gemini 分頁更新設定。
   * 若沒有對應的 content script 存在，則靜默失敗即可。
   */
  function notifyActiveTab(newSettings) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs && tabs[0];
        if (!activeTab || !activeTab.id) return;

        chrome.tabs.sendMessage(
          activeTab.id,
          {
            type: "GRA_UPDATE_SETTINGS",
            payload: newSettings
          },
          () => {
            // 若 content script 尚未注入或頁面不在 host_permissions 範圍內，
            // 這裡可能會收到錯誤，屬於預期情況，無須特別處理。
            void chrome.runtime.lastError;
          }
        );
      });
    } catch (error) {
      // popup 層不需要因為通知失敗而阻斷使用體驗。
      console.warn("[GRA][popup] Failed to notify active tab:", error);
    }
  }

  /**
   * 將設定套用到 UI。
   */
  function applySettingsToUI(settings, elements) {
    if (!elements.extensionEnabled) return;

    elements.extensionEnabled.checked = !!settings.extensionEnabled;

    const moduleKeys = [
      "showNavigator",
      "showSelectionToolbar",
      "showQuotePanel",
      "showGeminiInputInsertion",
      "showPageSearch",
      "showMessageCondense"
    ];
    moduleKeys.forEach((key) => {
      if (elements[key]) {
        elements[key].checked = !!settings[key];
      }
    });

    const canOpenSearch =
      !!settings.extensionEnabled && !!settings.showPageSearch;
    if (elements.btnOpenSearch) {
      elements.btnOpenSearch.disabled = !canOpenSearch;
    }
  }

  /**
   * 綁定 UI 事件：切換開關時即時更新設定。
   */
  function bindEvents(elements, currentSettings) {
    if (!elements.extensionEnabled) return;

    elements.extensionEnabled.addEventListener("change", async () => {
      const next = { extensionEnabled: elements.extensionEnabled.checked };
      await saveSettings(next);
      Object.assign(currentSettings, next);
      notifyActiveTab(next);
      applySettingsToUI(currentSettings, elements);
    });

    // 所有模組開關使用相同模式綁定，key 對應 settings 欄位名稱。
    const moduleKeys = [
      "showNavigator",
      "showSelectionToolbar",
      "showQuotePanel",
      "showGeminiInputInsertion",
      "showPageSearch",
      "showMessageCondense"
    ];
    moduleKeys.forEach((key) => {
      const el = elements[key];
      if (!el) return;
      el.addEventListener("change", async () => {
        const next = { [key]: el.checked };
        await saveSettings(next);
        Object.assign(currentSettings, next);
        notifyActiveTab(next);
        applySettingsToUI(currentSettings, elements);
      });
    });

    if (elements.btnOpenSearch) {
      elements.btnOpenSearch.addEventListener("click", sendOpenSearchUI);
    }

    if (elements.btnRefreshDiagnostics) {
      elements.btnRefreshDiagnostics.addEventListener("click", () => {
        fetchAndRenderDiagnostics(elements);
        fetchAndRenderJournalStatus(elements);
        renderKnowledgeCards(elements);
      });
    }

    if (elements.cardsSearch) {
      elements.cardsSearch.addEventListener("input", () => {
        renderKnowledgeCards(elements);
      });
    }

    if (elements.btnSaveConversation) {
      elements.btnSaveConversation.addEventListener("click", async () => {
        const btn = elements.btnSaveConversation;
        btn.disabled = true;
        btn.textContent = "保存中…";
        try {
          const tabs = await new Promise((resolve) => {
            chrome.tabs.query({ active: true, currentWindow: true }, resolve);
          });
          const activeTab = tabs && tabs[0];
          if (!activeTab?.id) {
            btn.textContent = "立即保存";
            btn.disabled = false;
            return;
          }

          const result = await new Promise((resolve) => {
            chrome.tabs.sendMessage(
              activeTab.id,
              { type: "GRA_SAVE_CONVERSATION" },
              (res) => {
                if (chrome.runtime.lastError) resolve({ ok: false });
                else resolve(res || { ok: false });
              }
            );
          });

          if (result.ok) {
            btn.textContent = "已保存";
            await fetchAndRenderJournalStatus(elements);
            setTimeout(() => {
              btn.textContent = "立即保存";
            }, 1500);
          } else {
            btn.textContent = "保存失敗";
            setTimeout(() => {
              btn.textContent = "立即保存";
            }, 1500);
          }
        } catch (_) {
          btn.textContent = "立即保存";
        }
        btn.disabled = false;
      });
    }

    if (elements.btnFullBackfill) {
      elements.btnFullBackfill.addEventListener("click", async () => {
        const btn = elements.btnFullBackfill;
        btn.disabled = true;
        btn.textContent = "補抓中…";
        try {
          const tabs = await new Promise((resolve) => {
            chrome.tabs.query({ active: true, currentWindow: true }, resolve);
          });
          const activeTab = tabs && tabs[0];
          if (!activeTab?.id) {
            btn.textContent = "完整補抓";
            btn.disabled = false;
            return;
          }

          const result = await new Promise((resolve) => {
            chrome.tabs.sendMessage(
              activeTab.id,
              { type: "GRA_RUN_FULL_BACKFILL" },
              (res) => {
                if (chrome.runtime.lastError)
                  resolve({ success: false, reason: "content_unavailable" });
                else resolve(res || { success: false, reason: "no_response" });
              }
            );
          });

          if (result.success) {
            btn.textContent = `已補抓 ${result.afterBlockCount - result.beforeBlockCount} 筆`;
            await fetchAndRenderJournalStatus(elements);
            setTimeout(() => {
              btn.textContent = "完整補抓";
            }, 2000);
          } else {
            btn.textContent = "補抓失敗";
            setTimeout(() => {
              btn.textContent = "完整補抓";
            }, 1500);
          }
        } catch (_) {
          btn.textContent = "完整補抓";
        }
        btn.disabled = false;
      });
    }

    if (elements.btnExportMd) {
      elements.btnExportMd.addEventListener("click", () => {
        exportSnapshotAndDownload(elements, "md");
      });
    }
    if (elements.btnExportTxt) {
      elements.btnExportTxt.addEventListener("click", () => {
        exportSnapshotAndDownload(elements, "txt");
      });
    }

    // 資料匯出 / 匯入（本地 storage JSON）
    if (elements.btnExportData) {
      elements.btnExportData.addEventListener("click", async () => {
        const btn = elements.btnExportData;
        const statusEl = elements.dataIoStatus;
        btn.disabled = true;
        if (statusEl) statusEl.textContent = "";
        try {
          const payload = await GRAStorage.exportAllPluginData();
          const json = JSON.stringify(payload, null, 2);
          const filename = `gra-backup-${new Date().toISOString().slice(0, 10)}.json`;
          triggerDownload(json, filename, "application/json;charset=utf-8");
          if (statusEl) {
            statusEl.textContent = "已匯出";
            statusEl.className = "gra-popup-data-io__status gra-popup-data-io__status--success";
          }
        } catch (err) {
          if (statusEl) {
            statusEl.textContent = "匯出失敗";
            statusEl.className = "gra-popup-data-io__status gra-popup-data-io__status--error";
          }
        }
        setTimeout(() => {
          btn.disabled = false;
          if (statusEl) {
            statusEl.textContent = "";
            statusEl.className = "gra-popup-data-io__status";
          }
        }, 2000);
      });
    }

    if (elements.btnImportData && elements.inputImportFile) {
      elements.btnImportData.addEventListener("click", () => {
        elements.inputImportFile.click();
      });
      elements.inputImportFile.addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        const statusEl = elements.dataIoStatus;
        elements.inputImportFile.value = "";
        if (!file) return;

        const btn = elements.btnImportData;
        btn.disabled = true;
        if (statusEl) statusEl.textContent = "匯入中…";
        try {
          const text = await file.text();
          const payload = JSON.parse(text);
          const result = await GRAStorage.importAllPluginData(payload);
          if (result.success) {
            if (statusEl) {
              statusEl.textContent = `已匯入 ${result.importedKeys?.length ?? 0} 筆`;
              statusEl.className = "gra-popup-data-io__status gra-popup-data-io__status--success";
            }
            const fresh = await loadSettings();
            Object.assign(currentSettings, fresh);
            applySettingsToUI(fresh, elements);
            notifyActiveTab(fresh);
            renderKnowledgeCards(elements);
          } else {
            if (statusEl) {
              statusEl.textContent = result.error === "invalid_payload" ? "無效的檔案" : "匯入失敗";
              statusEl.className = "gra-popup-data-io__status gra-popup-data-io__status--error";
            }
          }
        } catch (_) {
          if (statusEl) {
            statusEl.textContent = "檔案格式錯誤";
            statusEl.className = "gra-popup-data-io__status gra-popup-data-io__status--error";
          }
        }
        setTimeout(() => {
          btn.disabled = false;
          if (statusEl) {
            statusEl.textContent = "";
            statusEl.className = "gra-popup-data-io__status";
          }
        }, 2500);
      });
    }
  }

  // ---- License UI (Pro) -----------------------------------------------------

  var GUMROAD_PRODUCT_ID = "YOUR_PRODUCT_ID"; // TODO: replace after Gumroad setup

  async function initLicenseUI() {
    var statusEl = document.getElementById("gra-license-status");
    var inputRow = document.getElementById("gra-license-input-row");
    var activeRow = document.getElementById("gra-license-active-row");
    var activeText = document.getElementById("gra-license-active-text");
    var keyInput = document.getElementById("gra-license-key");
    var activateBtn = document.getElementById("gra-btn-activate");
    var deactivateBtn = document.getElementById("gra-btn-deactivate");

    if (!statusEl || typeof GRAStorage === "undefined") return;

    var license = await GRAStorage.getLicense();
    var isPro = GRAStorage.isPro(license);

    // Plan selector (Pro only)
    var planSelect = document.getElementById("gra-plan-select");
    var planRow = document.getElementById("gra-plan-selector-row");

    if (isPro) {
      statusEl.textContent = "Pro 已啟用";
      statusEl.style.color = "#4ade80";
      inputRow.style.display = "none";
      activeRow.style.display = "flex";
      activeText.textContent = license.code.slice(0, 12) + "...";

      // Show plan selector for Pro users
      if (planRow) planRow.style.display = "flex";
      if (planSelect) {
        var currentSettings = await loadSettings();
        if (currentSettings.geminiPlan) planSelect.value = currentSettings.geminiPlan;
        planSelect.addEventListener("change", async function () {
          await saveSettings({ geminiPlan: planSelect.value });
          notifyActiveTab({ geminiPlan: planSelect.value });
        });
      }
    } else {
      statusEl.textContent = "Free 版本";
      inputRow.style.display = "flex";
      activeRow.style.display = "none";
    }

    if (activateBtn) {
      activateBtn.addEventListener("click", async function () {
        var key = (keyInput.value || "").trim();
        if (!key) return;
        activateBtn.disabled = true;
        activateBtn.textContent = "驗證中...";
        var result = await GRAStorage.verifyLicenseOnline(key, GUMROAD_PRODUCT_ID);
        if (result.valid) {
          statusEl.textContent = "Pro 已啟用";
          statusEl.style.color = "#4ade80";
          inputRow.style.display = "none";
          activeRow.style.display = "flex";
          activeText.textContent = key.slice(0, 12) + "...";
        } else {
          statusEl.textContent = "授權碼無效: " + (result.error || "unknown");
          statusEl.style.color = "#f87171";
          activateBtn.disabled = false;
          activateBtn.textContent = "啟用";
        }
      });
    }

    if (deactivateBtn) {
      deactivateBtn.addEventListener("click", async function () {
        await GRAStorage.clearLicense();
        statusEl.textContent = "Free 版本";
        statusEl.style.color = "";
        inputRow.style.display = "flex";
        activeRow.style.display = "none";
        if (keyInput) keyInput.value = "";
      });
    }
  }

  // ---- 初始化流程 -----------------------------------------------------------

  document.addEventListener("DOMContentLoaded", async () => {
    const elements = getElements();
    const settings = await loadSettings();

    applySettingsToUI(settings, elements);
    bindEvents(elements, settings);
    fetchAndRenderDiagnostics(elements);
    fetchAndRenderJournalStatus(elements);
    renderKnowledgeCards(elements);
    initLicenseUI();
  });
})();

