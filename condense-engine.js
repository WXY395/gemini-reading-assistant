/**
 * Gemini Reading Assistant — Condense Engine (Condense Rules 2.0)
 * ---------------------------------------------------------------
 * 純文字、同步、規則式「機制壓縮」：固定兩段（Summary \n\n Method），禁止 raw data。
 * V7 — Mechanism Ontology：唯一分類入口 classifyMechanismType → 固定 IR（含 data_transformation 清洗／截斷，優先於 data_pipeline）→ render → strip → validate；禁止非 IR 路徑直接拼商用句。
 * validate(output)：\d／ms／bytes／副檔名、因果鏈（因／透過）、instruction 殘留；Hard guard 仍可由呼叫端接 fallbackMechanism。
 * publicationHasForbiddenRawData 等仍用於句子清洗；最終輸出以 V7 validate 為準。
 * maxRatio 預設 0.3；收斂順序 optional → method 子句 → summary；method 不得清空。CTA／問句不進主文。
 * 未來可改為 async / LLM：維持 condenseText 回傳格式即可。
 */
(function () {
  "use strict";

  /**
   * 角色權重：數字越大越重要（選句、排序、tryPromote 皆「就高不就低」）。
   */
  const ROLE_RANK = {
    decision: 110,
    issue: 100,
    summary: 80,
    cause: 70,
    evidence: 60,
    compare: 50,
    general: 20,
    step: 18,
    instruction: 10,
    cta: 5,
    question: 4,
    filler: -10
  };

  const CTA_PATTERNS = [
    /^我可以為你/,
    /^我可以幫你/,
    /^您認為/,
    /^你認為/,
    /下一步.*嗎/,
    /要不要/,
    /是否要/,
    /確立目標後/
  ];

  const QUESTION_PATTERNS = [/嗎$/, /\?$/];

  const INSTRUCTION_PATTERNS = [/^請/, /^第一步/, /^第二步/, /^第三步/];

  /** 決策／方法論訊號（優先於 issue／summary 作文件主結論） */
  const DECISION_PATTERNS = [
    /比.*更重要/,
    /優先/,
    /先.*再/,
    /不要.*而是/,
    /如果.*就/,
    /否則/,
    /徒勞/,
    /沒有意義/,
    /才是/
  ];

  const ISSUE_PATTERNS = [
    /問題是/,
    /主因是/,
    /原因是/,
    /關鍵問題/,
    /這解釋了為什麼/,
    /沒有生效/,
    /失敗原因/,
    /依然在/,
    /鎖死/,
    /沿用舊/,
    /問題在於/,
    /病灶/,
    /出問題點/
  ];

  /** 延伸指令／操作（與 instruction 併入後段；不可作 docSummary） */
  function isExtendedInstructionLike(s, role) {
    const t = (s || "").trim();
    if (!t) return false;
    if (role === "instruction" || role === "cta" || role === "question") return true;
    if (/^第[一二三四五六七八九十\d十]+步([，,、：:\s.]|$)/.test(t)) return true;
    if (/請直接執行|請務必查看|執行以下動作|執行下列步驟|請依下列/.test(t)) return true;
    if (/妳想讓我|你想讓我|是否要我|要不要直接|你是否需要|要我幫你|要我現在|要我直接/.test(t)) {
      return true;
    }
    if (
      /^請(執行|查看|點選|點擊|依序|複製|貼上|輸入|嘗試|確認|檢查|參照|回報|提供|附上|打開|前往|安裝|重啟)/.test(
        t
      )
    ) {
      return true;
    }
    if (/\bRun\s+this\b|\bTry\s+this\b|\bClick\s+here\b/i.test(t)) return true;
    return false;
  }

  /** 輸出長度目標上限（預設 30%；必要時允許略超以保留方法段） */
  const DEFAULT_MAX_OUTPUT_RATIO = 0.3;
  /** 結論段字數上限，避免吃掉 method 配額 */
  const MAX_SUMMARY_LENGTH = 120;

  const FLUFF_LEADING_RE =
    /^(我們可以|我們能夠|基本上|簡單來說|這代表|這表示|以下是|值得一提的是|值得注意的是|總而言之[，,：:]?|總之[，,：:]?|換句話說[，,：:]?)/;
  const FLUFF_PHRASE_RE = /(我們可以|這代表|以下是|讓我為你|讓我們|其實說穿了)/g;
  /** Rewrite Layer：額外冗詞（與 compressSentence 同步維護） */
  const REWRITE_FLUFF_RE = /(在最新的|我們可以看到|這代表|原因分析)[，,、：:\s]*/g;

  const CONCLUSION_LIKE_RE =
    /問題(是|在)|結論|主因|原因是|因此|所以|建議|必須|失敗|錯誤|異常|關鍵|導致|由於|因為|重中之重|整體而言|API\s*回傳|回傳\s*\d{3}|payload|endpoint|validation/i;

  /** Summary 最低門檻：技術訊號、狀態詞，或已套用之決策句骨架 */
  const SUMMARY_MIN_QUALITY_RE =
    /\bAPI\b|endpoint|duration|validation|timestamp|schema|payload|\bHTTP\b|JSON|OAuth|webhook|request|response|\d{3}(?!\d)|\b404\b|\b403\b|\b500\b|502|401|KB|MB|GB|kb|mb|\d+\.?\d*\s*秒|錯誤|失敗|不一致|異常|無效|timeout|TimeOut|N\/A|NA\b|\d+\s*\/\s*\d+|系統透過「/i;

  /** Summary 須含「系統行為」動詞（不可僅形容詞評語） */
  const SUMMARY_SYSTEM_ACTION_RE =
    /對齊|補償|修正|計算|同步|延遲|觸發|路由|驗證|回傳|響應|綁定|校準|更新|寫入|讀取|執行|比對|採用|運作|處理|調度|銜接|對時/i;

  const SUMMARY_ADJECTIVE_ONLY_RE =
    /^(?:[^。]{0,50})?(完全同步|更穩定|非常穩|顯著提升|大幅提升|整體更好|很棒|完美|卓越|令人滿意)/;

  /** 成就／雞血敘述 → filler，不進 summary／method */
  const HYPE_PATTERNS = [
    /值得.*慶祝/,
    /院線級/,
    /導演級/,
    /這是一個.*時刻/,
    /我們可以看到/
  ];

  const BULLET_PHRASE_TWEAKS = [
    [/提升門禁/g, "提高門檻"],
    [/增加檢查/g, "增加檢測"],
    [/優化關鍵字/g, "簡化關鍵字"]
  ];

  function stripListMarkers(line) {
    return String(line || "")
      .replace(/^\s*([•·\-*＊]|\d+[\.)．、]|[\u2460-\u2473]|[a-zA-Z][\.)])\s*/, "")
      .trim();
  }

  function tweakBulletPhrase(s) {
    let o = s;
    for (let bi = 0; bi < BULLET_PHRASE_TWEAKS.length; bi++) {
      o = o.replace(BULLET_PHRASE_TWEAKS[bi][0], BULLET_PHRASE_TWEAKS[bi][1]);
    }
    return o.trim();
  }

  /**
   * 語意壓縮：去冗詞、合併「原因分析：A，導致 B」類骨架，保留主幹與數據。
   * @param {string} sentence
   * @returns {string}
   */
  function compressSentence(sentence) {
    let s = normalizeText(sentence);
    if (!s) return "";
    s = s.replace(REWRITE_FLUFF_RE, "");
    s = s.replace(/原因分析[：:]\s*/g, "");
    s = s.replace(
      /(?:原因分析|分析說明|問題根源|根因說明)[：:]\s*([^。；;\n]+?)[，,]?\s*導致\s*([^。；;\n]+)/,
      "$1導致$2"
    );
    s = s.replace(FLUFF_LEADING_RE, "");
    s = s.replace(FLUFF_PHRASE_RE, "");
    s = s.replace(/^(因此|所以|此外)[，,]\s*/g, "");
    s = s.replace(/\s*，\s*，+/g, "，");
    s = s.replace(/因(?=(?:endpoint|API|HTTP|JSON|payload|validation|alpha|REST)\b)/gi, "因為 ");
    s = s.replace(/\.(?:mp3|mp4|wav|m4a|aac|flac)\b/gi, "");
    return normalizeText(s.trim());
  }

  function ensureFullSentence(s) {
    let t = normalizeText(s);
    if (!t) return "";
    if (!/[。！？…]$/.test(t)) t += "。";
    return t;
  }

  function stripMethodLead(s) {
    return normalizeText(
      String(s || "")
        .replace(/^(因此|所以|此外|另外|接著|再來|最後)[，,、]\s*/g, "")
        .trim()
    );
  }

  function stripTrailingSentencePunct(t) {
    return String(t || "")
      .replace(/[\s\u3000]+$/g, "")
      .replace(/[。．.！？…]+$/g, "")
      .trim();
  }

  function polishRewriteSpacing(s) {
    return normalizeText(
      String(s || "")
        .replace(/[。！？…]\s*，/g, "，")
        .replace(/，{2,}/g, "，")
        .replace(/\s*，\s*。$/g, "。")
        .replace(/\s{2,}/g, " ")
        .trim()
    );
  }

  function isHypeSentence(text) {
    const s = String(text || "").trim();
    if (!s) return false;
    for (let hi = 0; hi < HYPE_PATTERNS.length; hi++) {
      if (HYPE_PATTERNS[hi].test(s)) return true;
    }
    return false;
  }

  function passesSummaryHardQuality(text) {
    return SUMMARY_MIN_QUALITY_RE.test(normalizeText(text || ""));
  }

  function passesSummarySystemBehavior(text) {
    const t = normalizeText(text || "");
    if (!t) return false;
    if (SUMMARY_SYSTEM_ACTION_RE.test(t)) return true;
    if (SUMMARY_ADJECTIVE_ONLY_RE.test(t)) return false;
    return passesSummaryHardQuality(t);
  }

  function passesSummaryPublicationQuality(text) {
    const t = normalizeText(text || "");
    if (!t || !passesSummarySystemBehavior(t)) return false;
    if (passesSummaryHardQuality(t)) return true;
    // ensureSummarySystemBehavior 已補上「對齊／校準」等系統行為前綴時，仍視為可出版
    if (/^系統(?:以對齊|依對齊)/.test(t)) return true;
    return false;
  }

  /**
   * 補上「系統行為」骨架，避免僅有形容詞式評語。
   * @param {string} text
   * @returns {string}
   */
  function ensureSummarySystemBehavior(text) {
    let s = normalizeText(text || "");
    if (!s) return s;
    if (SUMMARY_SYSTEM_ACTION_RE.test(s)) return s;
    if (SUMMARY_ADJECTIVE_ONLY_RE.test(s) || /完全同步|更穩定|顯著提升|大幅提升/.test(s)) {
      return normalizeText(`系統以對齊與校準機制運作：${s.replace(/^[，,、]/, "")}`);
    }
    if (passesSummaryHardQuality(s) && !SUMMARY_SYSTEM_ACTION_RE.test(s)) {
      return normalizeText(
        `系統依對齊與校準機制判定：${s.replace(/^[，,、]/, "")}`
      );
    }
    return s;
  }

  /**
   * 出版用：移除數字、單位、檔名副檔名、SFX／bytes／ms 等（機制壓縮最終階段）。
   * @param {string} s
   * @returns {string}
   */
  function stripRawDataForPublication(s) {
    let t = normalizeText(String(s || ""));
    t = t.replace(/\bSFX\s*0*\d+\b/gi, "");
    t = t.replace(/\bSFX\b/gi, "");
    t = t.replace(/\bbytes?\b/gi, "");
    t = t.replace(/\d+\s*ms\b/gi, "");
    t = t.replace(/\bms\b/gi, "");
    t = t.replace(/\d+\s*(?:KB|MB|GB|kb|mb|gb)\b/g, "");
    t = t.replace(
      /\.(?:mp3|mp4|wav|m4a|aac|flac|txt|json|xml|yaml|yml|cfg|ini)\b/gi,
      ""
    );
    t = t.replace(/\s*\+\s*/g, "與");
    t = t.replace(/[0-9０-９]+(?:\.[0-9０-９]+)?/g, "");
    t = t.replace(/[+\uFF0B]+/g, "");
    t = t.replace(
      /加秒|秒的對齊|約毫秒|量級資料|秒與|與秒|加的對齊|加與|分段時長的對齊/g,
      "分段對齊"
    );
    t = t.replace(/\s{2,}/g, " ");
    t = t.replace(/[，,、]{2,}/g, "，");
    t = t.replace(/^[，,、\s]+|[，,、\s]+$/g, "");
    return normalizeText(t);
  }

  /** @deprecated 與 stripRawDataForPublication 相同，語意標示「句子清洗」 */
  function cleanSentenceForPublication(s) {
    return stripRawDataForPublication(s);
  }

  /**
   * V7 — Mechanism Ontology：唯一分類入口（順序即優先級）。
   * @param {string} text
   * @returns {"timing"|"data_transformation"|"data_pipeline"|"data_quality"|"configuration"|"architecture"|"workflow"|"environment"|"system_operation"|"general"}
   */
  function classifyMechanismType(text) {
    const t = String(text || "");
    if (/delay|sync|timeline|duration|對齊/i.test(t)) {
      return "timing";
    }
    if (/清洗|clean|去除|HTML|tag|regex|長度|截斷|處理|過濾|篩選|符號|字元/i.test(t)) {
      return "data_transformation";
    }
    if (/RSS|fetch|crawler|爬蟲|workflow|retry|抓取|n8n/i.test(t)) {
      return "data_pipeline";
    }
    if (/bytes|threshold|filter|驗證|噪音|門檻/i.test(t)) {
      return "data_quality";
    }
    if (/config|參數|密度|節奏|頻率|調整/i.test(t)) {
      return "configuration";
    }
    if (/模組|架構|重構|解耦/i.test(t)) {
      return "architecture";
    }
    if (/建立|初始化|git|步驟|專案|資料夾/i.test(t)) {
      return "workflow";
    }
    if (/workspace|視窗|context|上下文|隔離|indexing/i.test(t)) {
      return "environment";
    }
    if (/RAM|CPU|記憶體|效能|負載/i.test(t)) {
      return "system_operation";
    }
    return "unknown";
  }

  /**
   * 由已分類句組推斷整篇機制域（供 summary／fallback 對齊）。
   * @param {{ cls: object }[]} classified
   */
  function inferMechanismTypeFromClassified(classified) {
    const j = (classified || [])
      .filter((x) => x && x.cls && x.cls.role !== "filler")
      .map((x) => x.cls.text)
      .join("，");
    return classifyMechanismType(j);
  }

  /**
   * Ontology 類型 → 固定 IR（與分類一對一，禁止以原文欄位覆寫）。
   * @param {string} type
   * @returns {{ type: string, cause: string, bottleneck: string, action: string, result: string }}
   */
  function irFromOntologyType(type) {
    switch (type) {
      case "timing":
        return {
          type,
          cause: "時間軸與輸出未對齊",
          bottleneck: "同步偏移",
          action: "時間補償與對齊",
          result: "確保輸出一致"
        };
      case "data_transformation":
        return {
          type,
          cause: "原始資料包含雜訊與冗餘內容",
          bottleneck: "影響模型判斷與計算效率",
          action: "資料清洗與長度控制",
          result: "確保輸入內容純淨且可控"
        };
      case "data_pipeline":
        return {
          type,
          cause: "資料需持續抓取且存在不穩定性",
          bottleneck: "抓取與請求失敗風險",
          action: "排程抓取並加入重試與錯誤處理",
          result: "確保資料穩定輸入"
        };
      case "data_quality":
        return {
          type,
          cause: "資料品質不穩",
          bottleneck: "噪音與低資訊密度",
          action: "門檻過濾與驗證",
          result: "確保資料可靠"
        };
      case "configuration":
        return {
          type,
          cause: "系統行為受參數控制",
          bottleneck: "配置影響輸出效果",
          action: "調整資訊密度與節奏",
          result: "改變輸出表現"
        };
      case "architecture":
        return {
          type,
          cause: "系統結構影響擴展性",
          bottleneck: "模組耦合",
          action: "模組分離與重構",
          result: "提升系統彈性"
        };
      case "workflow":
        return {
          type,
          cause: "流程依賴正確操作順序",
          bottleneck: "流程未建立",
          action: "建立流程與初始化專案結構",
          result: "確保流程可執行"
        };
      case "environment":
        return {
          type,
          cause: "上下文與執行環境綁定工作區",
          bottleneck: "跨專案干擾與資源衝突",
          action: "多視窗與工作區隔離",
          result: "確保環境獨立"
        };
      case "system_operation":
        return {
          type,
          cause: "系統資源有限",
          bottleneck: "運行負載過高",
          action: "資源調度與限制",
          result: "維持系統穩定"
        };
      default:
        return {
          type: "general",
          cause: "缺乏明確機制",
          bottleneck: "資訊未結構化",
          action: "基本整理",
          result: "提升可讀性"
        };
    }
  }

  /**
   * V7 IR：分類驅動，僅經 Ontology。
   * @param {string} text
   */
  function buildIR(text) {
    return irFromOntologyType(classifyMechanismType(normalizeText(text)));
  }

  /**
   * extractMechanismWithMeta 用的 configuration 機制句（與 Ontology 一致）。
   * @returns {string}
   */
  function configurationOntologyMechanismRule() {
    return normalizeText(ensureFullSentence(renderMethod(irFromOntologyType("configuration"))));
  }

  /**
   * V7 唯一 summary 層：系統行為 + 結果。
   * @param {{ action: string, result: string }} ir
   */
  function renderSummary(ir) {
    const r = ir || {};
    return normalizeText(`系統透過${r.action}，${r.result}`);
  }

  /**
   * V7 唯一 method 層：因果 + bottleneck + action + result。
   * @param {{ cause: string, bottleneck: string, action: string, result: string }} ir
   */
  function renderMethod(ir) {
    const r = ir || {};
    return normalizeText(`因${r.cause}導致${r.bottleneck}，透過${r.action}實現${r.result}`);
  }

  /**
   * data_transformation：若輸出誤帶 data_pipeline 語彙，強制還原為轉換本體模板。
   * @param {string} summary
   * @param {string} method
   * @param {string} irType
   * @returns {{ summary: string, method: string }}
   */
  function ensureDataTransformationNoPipelineLeak(summary, method, irType) {
    if (irType !== "data_transformation") return { summary, method };
    const leak = /抓取|排程|retry|ingestion|重試|排程抓取/i;
    const comb = normalizeText(String(summary || "") + String(method || ""));
    if (!leak.test(comb)) return { summary, method };
    const ir = irFromOntologyType("data_transformation");
    return {
      summary: normalizeText(ensureFullSentence(renderSummary(ir))),
      method: normalizeText(ensureFullSentence(renderMethod(ir)))
    };
  }

  /**
   * 字元 Dice 係數（粗估 summary／method 是否過度重疊）。
   * @param {string} a
   * @param {string} b
   */
  function diceCharSimilarity(a, b) {
    const A = String(a || "").replace(/\s/g, "");
    const B = String(b || "").replace(/\s/g, "");
    if (!A.length || !B.length) return 0;
    const setA = {};
    for (let i = 0; i < A.length; i++) {
      const c = A[i];
      setA[c] = (setA[c] || 0) + 1;
    }
    let inter = 0;
    const used = {};
    for (let j = 0; j < B.length; j++) {
      const c = B[j];
      used[c] = used[c] || 0;
      if ((setA[c] || 0) > used[c]) {
        inter++;
        used[c]++;
      }
    }
    return (2 * inter) / (A.length + B.length);
  }

  /**
   * data_transformation：summary 與 method 過像時，method 強制帶問題來源／影響／具體處理標示，避免與 summary 重複。
   * @param {{ type?: string, cause: string, bottleneck: string, action: string, result: string }} ir
   * @param {string} summary
   * @param {string} method
   * @returns {string}
   */
  function renderTransformationMethodWithDifferentiation(ir, summary, method) {
    const r = ir || {};
    if (r.type !== "data_transformation") return method;
    if (diceCharSimilarity(summary, method) < 0.62) return method;
    return normalizeText(
      `因${r.cause}（問題來源）導致${r.bottleneck}（影響），透過${r.action}（具體處理）實現${r.result}`
    );
  }

  /**
   * V7 強制驗證門（整段兩段式輸出）。
   * @param {string} output
   */
  function validate(output) {
    const o = normalizeText(String(output || ""));
    if (/\d|ms|bytes|\.mp3|\.mp4/i.test(o)) throw "RAW_DATA_DETECTED";
    if (!o.includes("因") || !o.includes("透過")) throw "INVALID_MECHANISM";
    if (/第[一二三四五六七八九]步|Step/i.test(o)) throw "INSTRUCTION_LEAK";
  }

  /**
   * 兩段參數版別名（內部相容）；語意等同 {@link validate}。
   * @param {string} summary
   * @param {string} method
   */
  function validateCondenseIR(summary, method) {
    validate(joinOutputBlocks(summary || "", method || "", ""));
  }

  /**
   * 依類型從 Ontology 產生保底兩段（不經原文 rewrite）。
   * @param {string} [type]
   */
  function fallbackMechanism(type) {
    const ir = irFromOntologyType(type || "general");
    let summary = normalizeText(ensureFullSentence(renderSummary(ir)));
    let method = normalizeText(ensureFullSentence(renderMethod(ir)));
    summary = stripRawDataForPublication(summary).replace(/原因|問題/g, "狀態");
    method = stripRawDataForPublication(method);
    return { summary, method };
  }

  function classifiedToIRSource(classified, mergeRaw) {
    const parts = [];
    if (mergeRaw && String(mergeRaw).trim()) {
      parts.push(String(mergeRaw).trim());
    }
    (classified || []).forEach((x) => {
      if (!x || !x.cls) return;
      if (x.cls.role === "filler") return;
      if (["cta", "instruction", "question"].includes(x.cls.role)) return;
      if (isExtendedInstructionLike(x.cls.text, x.cls.role)) return;
      const tx = String(x.cls.text || "").trim();
      if (tx) parts.push(tx);
    });
    return normalizeText(parts.join("。"));
  }

  /**
   * V7：與 {@link condense} 等同（分類 → IR → render → validate）。
   * @param {string} sourceText
   * @returns {string}
   */
  function condenseViaIRPipeline(sourceText) {
    return condense(normalizeText(sourceText || ""));
  }

  /**
   * V7 主流程：buildIR → renderSummary／renderMethod → 串接 → strip → instruction 清理 → validate。
   * @param {string} text
   * @returns {string}
   */
  function condense(text) {
    const t = normalizeText(text);
    const ir = buildIR(t);
    let summary = normalizeText(ensureFullSentence(renderSummary(ir)));
    let method = normalizeText(ensureFullSentence(renderMethod(ir)));
    const tf = ensureDataTransformationNoPipelineLeak(summary, method, ir.type);
    summary = tf.summary;
    method = tf.method;
    method = normalizeText(
      ensureFullSentence(
        renderTransformationMethodWithDifferentiation(ir, summary, method)
      )
    );
    summary = stripRawDataForPublication(summary).replace(/原因|問題/g, "狀態");
    method = stripRawDataForPublication(method);
    const tfStrip = ensureDataTransformationNoPipelineLeak(summary, method, ir.type);
    summary = tfStrip.summary;
    method = tfStrip.method;
    let output = normalizeText(joinOutputBlocks(summary, method, ""));
    output = stripInstructionLeaksFromCondenseOutput(output);
    validate(output);
    return output;
  }

  /**
   * 最終兩段式驗證（委派 {@link validate}）。
   * @param {string} summary
   * @param {string} method
   */
  function validateOutput(summary, method) {
    validate(joinOutputBlocks(summary || "", method || "", ""));
  }

  /** 避免 /ms/i 誤傷英文單字（如 items）；仍攔截單位 ms、bytes、SFX、任何數字 */
  function publicationHasForbiddenRawData(s) {
    const t = String(s || "");
    if (/[0-9０-９]/.test(t)) return true;
    if (/\bSFX\b/i.test(t)) return true;
    if (/\bbytes\b/i.test(t)) return true;
    if (/\d+\s*ms\b/i.test(t)) return true;
    if (/(?:^|[^A-Za-z])ms(?:$|[^A-Za-z])/i.test(t)) return true;
    return false;
  }

  function msToSecPhrase(ms) {
    const n = parseInt(ms, 10);
    if (isNaN(n)) return "";
    if (n >= 1000) {
      const sec = n / 1000;
      const t = sec % 1 === 0 ? String(sec) : String(Math.round(sec * 10) / 10);
      return t + "秒";
    }
    return "約" + n + "毫秒";
  }

  function abstractSfxCodes(s) {
    return String(s || "").replace(/\bSFX\s*0*\d+\b/gi, "音效片段").replace(/\bSFX\b/gi, "音效");
  }

  /**
   * 禁止 raw 數據堆疊：多段 ms／密集數字改為機制描述用語。
   * @param {string} s
   * @returns {string}
   */
  function abstractNumericDataForMechanism(s) {
    let t = String(s || "");
    const msMatches = t.match(/\d+\s*ms/gi) || [];
    if (msMatches.length >= 2) {
      t = t.replace(/\d+\s*ms(?:\s*[,，、]\s*|\s*與\s*|\s*及\s*|\s*)?/gi, "");
      t = t.replace(/\s*[,，、]{2,}/g, "，").replace(/^[,，、]+|[,，、]+$/g, "").trim();
      if (t && !/規則|對齊|延遲|機制/.test(t)) {
        t += "（分段延遲統整為時間對齊規則）";
      }
      return normalizeText(t);
    }
    if (msMatches.length === 1) {
      t = t.replace(/(\d+)\s*ms/gi, (_, num) => msToSecPhrase(num));
    }
    t = t.replace(/(\d+)\s*KB/gi, "約$1KB量級資料");
    return normalizeText(t);
  }

  function abstractRawDataInJoinedText(joined) {
    let t = abstractSfxCodes(joined);
    t = abstractNumericDataForMechanism(t);
    return normalizeText(t);
  }

  /**
   * 機制抽象（含類型）：依 classifyMechanismType 選模板；configuration 走參數驅動模板。
   * @param {string[]} sentences
   * @returns {{ type: string, rule: string }}
   */
  function extractMechanismWithMeta(sentences) {
    const parts = (sentences || [])
      .map((x) => compressSentence(typeof x === "string" ? x : ""))
      .filter(Boolean);
    if (!parts.length) return { type: "general", rule: "" };

    const joinedRaw = parts.join("，");
    const mechanismType = classifyMechanismType(joinedRaw);

    const hasNum =
      /\d+\s*(?:ms|秒|KB|kb)/i.test(joinedRaw) ||
      (/\d{2,}/.test(joinedRaw) && /ms|秒|KB|duration/i.test(joinedRaw));
    const hasTech =
      /\bVO\b|旁白|\badelay\b|\bapad\b|duration|manifest|\bAPI\b|endpoint|場景|音訊|音軌|時間軸|累積時長/i.test(
        joinedRaw
      );
    const hasBehave =
      /計算|對齊|補償|延遲|累積|同步|觸發|校準|比對|採用|綁定|銜接/i.test(joinedRaw);
    const behaveLine =
      hasBehave || /延遲|對齊|duration|adelay|apad|manifest/i.test(joinedRaw);

    if (!(hasNum || hasTech)) {
      if (mechanismType === "configuration") {
        return { type: "configuration", rule: configurationOntologyMechanismRule() };
      }
      return { type: mechanismType, rule: "" };
    }

    const relaxedBehave =
      behaveLine ||
      mechanismType === "data_quality" ||
      mechanismType === "architecture";
    if (!relaxedBehave) {
      if (mechanismType === "configuration") {
        return { type: "configuration", rule: configurationOntologyMechanismRule() };
      }
      return { type: mechanismType, rule: "" };
    }

    let joined = abstractRawDataInJoinedText(joinedRaw);

    const voLine = joined.match(
      /(?:VO|旁白)\s*(?:音軌|軌道|音訊)?\s*延遲\s*(?:為|是|採用|以)?\s*(.+?)(?:[。]|$)/i
    );
    if (voLine) {
      let rule = voLine[1].trim().replace(/\s*\+\s*/g, "加");
      rule = rule.replace(/累積時長(?!場景)/g, "累積場景時長");
      rule = abstractNumericDataForMechanism(rule);
      rule = rule.replace(/[，,]\s*$/g, "").trim();
      if (!/規則|對齊/.test(rule)) rule += "的對齊";
      const X = "旁白（VO）延遲";
      const Z = "與場景時間軸精確同步";
      return {
        type: "timing",
        rule: polishRewriteSpacing(ensureFullSentence(`${X}採用${rule}規則以達成${Z}`))
      };
    }

    if (mechanismType === "configuration") {
      return { type: "configuration", rule: configurationOntologyMechanismRule() };
    }

    let ruleCore = joined.replace(/^[,，、\s]+/, "").trim();
    if (ruleCore.length > 84) ruleCore = ruleCore.slice(0, 82) + "…";
    ruleCore = abstractNumericDataForMechanism(ruleCore);
    ruleCore = ruleCore.replace(/^[,，、的]+/, "").trim() || "運作條件整合";

    let X;
    let Z;
    if (mechanismType === "timing") {
      X = /場景|VO|旁白|音訊|音軌/.test(joinedRaw)
        ? "場景與音訊時序"
        : /API|endpoint|manifest|adelay|apad/.test(joinedRaw)
          ? "串流與時間參數"
          : "系統時間軸模組";
      Z = /補償/.test(joinedRaw)
        ? "時間銜接與相位補償"
        : /延遲|ms|秒/i.test(joinedRaw)
          ? "時間基準一致"
          : "流程與狀態一致";
    } else if (mechanismType === "data_quality") {
      X = "請求與資料管線";
      Z = "資訊密度與有效訊號比例";
    } else if (mechanismType === "architecture") {
      X = "模組與系統邊界";
      Z = "職責分離與結構可控";
    } else {
      X = /場景|VO|旁白|音訊|音軌/.test(joinedRaw)
        ? "場景與音訊時序"
        : /API|endpoint|manifest|adelay|apad/.test(joinedRaw)
          ? "串流與介面層"
          : "運作條件";
      Z = "目標產出一致";
    }

    const out = `${X}採用${ruleCore}規則以達成${Z}`;
    return {
      type: mechanismType,
      rule: polishRewriteSpacing(ensureFullSentence(out))
    };
  }

  /**
   * 機制規則句（向後相容：僅回傳 rule 字串）。
   * @param {string[]} sentences
   * @returns {string}
   */
  function extractMechanism(sentences) {
    const m = extractMechanismWithMeta(sentences);
    return m.rule || "";
  }

  /**
   * 是否為「技術驗證／數據對齊」語境（用於機制優先 method）。
   * @param {{ cls: object }[]} classified
   * @returns {boolean}
   */
  function isTechnicalValidationContext(classified) {
    if (!classified || !classified.length) return false;
    const j = classified.map((c) => c.cls.text).join(" ");
    return (
      /\d+\s*ms|\d+\s*秒|PASS|check|驗證|測試|對齊|檢查點|duration|adelay|apad/i.test(
        j
      ) && /\d/.test(j)
    );
  }

  /**
   * 決策優先：評論／meta → 客觀技術結論骨架（規則式）。
   * @param {string} sentence
   * @returns {string}
   */
  function rewriteSummaryToDecision(sentence) {
    let s = normalizeText(compressSentence(sentence));
    if (!s) return "";
    s = s.replace(/這代表[著了]?[，,：:\s]*/g, "");
    s = s.replace(/這說明[，,：:\s]*/g, "");
    s = s.replace(/這就是為什麼[，,：:\s]*/g, "");
    s = s.replace(/換句話說[，,：:\s]*/g, "");
    s = s.replace(/^其實[，,：:\s]*/g, "");
    s = s.replace(/^基本上[，,：:\s]*/g, "");
    s = s.replace(/^簡單(來說|講)[，,：:\s]*/g, "");
    s = normalizeText(s.trim());

    const hasProblem = /錯誤|404|403|500|502|失敗|不一致|失效|異常|無效|invalid|timeout/i.test(
      s
    );
    const hasTech =
      /\bAPI\b|endpoint|duration|validation|payload|timestamp|HTTP|JSON|schema|request|response/i.test(
        s
      );
    const hasOutcome = /已解決|已修正|導致改善|已完成|已修復|已落地|已上線/.test(s);

    if ((hasProblem || hasTech) && !hasOutcome) {
      if (
        hasProblem &&
        !/^(問題|錯誤|失敗|API|endpoint|回傳|結論|技術)/.test(s.slice(0, 16))
      ) {
        s = normalizeText(`狀態確認：${s.replace(/^[，,、]/, "")}`);
      } else if (
        hasTech &&
        !hasProblem &&
        !/^(依|根據|結論|技術|驗證|回傳)/.test(s.slice(0, 8))
      ) {
        s = normalizeText(`依技術證據：${s.replace(/^[，,、]/, "")}`);
      }
    }

    return normalizeText(s);
  }

  /**
   * 由句組建 IR 並 render method（V7 Ontology，非 rewrite）。
   * @param {string[]} sentences
   * @returns {string}
   */
  function renderMethodFromJoinedSentences(sentences) {
    const raw = (sentences || [])
      .map((x) => compressSentence(typeof x === "string" ? x : ""))
      .filter(Boolean);
    if (!raw.length) return "";
    let m = normalizeText(renderMethod(buildIR(raw.join("，"))));
    m = stripRawDataForPublication(m);
    try {
      validateCondenseIR("", m);
    } catch (e) {
      m = stripRawDataForPublication(
        fallbackMechanism(classifyMechanismType(raw.join("，"))).method
      );
    }
    return m;
  }

  /**
   * 結論段：IR → renderSummary（與全文 method 同源）。
   * @param {string} raw
   * @param {{ cls: object }[]} [classifiedOpt]
   */
  function finalizeSummaryText(raw, classifiedOpt) {
    const led = rewriteLeadForOutput(raw);
    const ctx =
      classifiedOpt != null
        ? classifiedToIRSource(classifiedOpt, led)
        : normalizeText(led);
    const ir = buildIR(ctx || String(raw || ""));
    let cleaned = normalizeText(ensureFullSentence(renderSummary(ir)));
    cleaned = stripRawDataForPublication(cleaned).replace(/原因|問題/g, "狀態");
    return capSummaryLength(cleaned, MAX_SUMMARY_LENGTH);
  }

  /**
   * @param {{ index: number, cls: object }[]} classified
   * @param {number} excludeIdx 已失敗的 doc 句 index；-1 表示不排除
   * @returns {number|null}
   */
  function pickAlternateSummaryIndexForHardQuality(classified, excludeIdx) {
    const pool = classified.filter(
      (x) =>
        x.cls.role !== "filler" &&
        !["cta", "instruction", "question"].includes(x.cls.role) &&
        !isExtendedInstructionLike(x.cls.text, x.cls.role) &&
        !isHypeSentence(x.cls.text)
    );
    pool.sort(
      (a, b) =>
        scoreInformationDensity(b.cls.text) - scoreInformationDensity(a.cls.text) ||
        scoreSentence(b.cls) - scoreSentence(a.cls)
    );
    for (let pi = 0; pi < pool.length; pi++) {
      if (excludeIdx >= 0 && pool[pi].index === excludeIdx) continue;
      const cand = finalizeSummaryText(pool[pi].cls.text, classified);
      if (passesSummaryPublicationQuality(cand)) return pool[pi].index;
    }
    return null;
  }

  /**
   * 帶「技術／數字／問題」硬門檻的結論段；不合格則換句。
   * @param {{ index: number, cls: object }[]} classified
   * @param {string} raw
   * @param {number} excludeIdx
   * @returns {string}
   */
  function finalizeSummaryTextWithQuality(classified, raw, excludeIdx) {
    let t = finalizeSummaryText(raw, classified);
    if (!passesSummaryPublicationQuality(t)) {
      const altI = pickAlternateSummaryIndexForHardQuality(
        classified,
        excludeIdx != null ? excludeIdx : -1
      );
      if (altI != null) {
        const hit = classified.find((h) => h.index === altI);
        if (hit) t = finalizeSummaryText(hit.cls.text, classified);
      }
    }
    return t;
  }

  function compressSingleSentence(raw) {
    let s = compressSentence(raw);
    if (!s) return "";
    if (s.length > 100) {
      const chunks = s.split(/[，,；;]/).map((p) => p.trim()).filter(Boolean);
      if (chunks.length >= 2) {
        s = chunks.slice(0, 2).join("，");
        if (raw.length > s.length + 8) s += "…";
      } else {
        s = s.slice(0, 96).trim() + "…";
      }
    }
    return normalizeText(s);
  }

  function capSummaryLength(s, maxLen) {
    const lim = maxLen == null ? MAX_SUMMARY_LENGTH : maxLen;
    let t = normalizeText(s);
    if (!t) return "";
    t = compressSingleSentence(t);
    if (t.length <= lim) return t;
    const chunks = t.split(/[，,；;]/).map((p) => p.trim()).filter(Boolean);
    let acc = chunks[0] || t.slice(0, lim);
    for (let ci = 1; ci < chunks.length; ci++) {
      const next = acc + "，" + chunks[ci];
      if (next.length <= lim) acc = next;
      else break;
    }
    if (acc.length > lim) acc = acc.slice(0, Math.max(1, lim - 1)).trim() + "…";
    return normalizeText(acc);
  }

  /**
   * 從 general／evidence 等補方法段（排除 doc／cause 等）。
   * @param {{ index: number, cls: object }[]} classified
   * @param {Set<number>} excludeSet
   * @returns {string}
   */
  function fillMethodFromGeneral(classified, excludeSet) {
    const ex = excludeSet || new Set();
    const roleOk = new Set([
      "general",
      "compare",
      "evidence",
      "step",
      "cause",
      "summary",
      "issue",
      "decision"
    ]);
    const pool = classified.filter(
      (x) =>
        !ex.has(x.index) &&
        x.cls.role !== "filler" &&
        !["cta", "instruction", "question"].includes(x.cls.role) &&
        roleOk.has(x.cls.role)
    );
    pool.sort((a, b) => scoreSentence(b.cls) - scoreSentence(a.cls));
    const texts = pool.slice(0, 3).map((x) => x.cls.text).filter(Boolean);
    if (!texts.length) return "";
    const hint = inferListHeadFromLead(texts[0] || "");
    return (
      renderMethodFromJoinedSentences(texts) ||
      compressSentences(texts, { topicHint: hint }) ||
      ensureFullSentence(compressSentence(texts[0]))
    );
  }

  /**
   * 從非 filler 取 2～3 句壓成一句「做法／要點」。
   * @param {{ index: number, cls: object }[]} classified
   * @param {Set<number>} excludeSet
   * @returns {string}
   */
  function fallbackMethod(classified, excludeSet) {
    const ex = excludeSet || new Set();
    const pool = classified.filter(
      (x) =>
        !ex.has(x.index) &&
        x.cls.role !== "filler" &&
        !["cta", "instruction", "question"].includes(x.cls.role)
    );
    pool.sort((a, b) => scoreSentence(b.cls) - scoreSentence(a.cls));
    const texts = pool.slice(0, 3).map((x) => x.cls.text).filter(Boolean);
    if (!texts.length) return "";
    return (
      renderMethodFromJoinedSentences(texts) ||
      compressSentences(texts, { topicHint: "做法" }) ||
      ensureFullSentence(compressSentence(texts[0]))
    );
  }

  function rewriteLeadForOutput(leadSrc) {
    let s = compressSentence(leadSrc);
    const m = s.match(/(?:所以|因此|總之|結論是|重點是)[:：，,]?\s*(.+)/);
    if (m && m[1] && m[1].length > 6) {
      const before = s.slice(0, m.index).trim();
      if (
        before.length >= 6 &&
        /更重要|優先|才是|不要.*而是|如果.*就|比.*更|關鍵|問題是|否則|徒勞|沒有意義/.test(
          before
        )
      ) {
        return normalizeText(s);
      }
      return normalizeText(m[1]);
    }
    return s;
  }

  function inferListHeadFromLead(leadText) {
    if (!leadText) return "要點";
    const m = leadText.match(/([\u4e00-\u9fff]{2,10})(方面|策略|優化|調整|做法|建議|處理|設定)/);
    if (m) return m[1] + m[2];
    const m2 = leadText.match(/^(.{2,14})[：:]/);
    if (m2) return m2[1].trim();
    const m3 = leadText.match(/([\u4e00-\u9fff]{2,6})(優化|調整)/);
    if (m3) return m3[1] + m3[2];
    return "要點";
  }

  /**
   * 將多條短條列壓成一句「主題：項1、項2、項3」。
   */
  function compressBulletLines(lines, topicHint) {
    const cleaned = lines.map(stripListMarkers).map(tweakBulletPhrase).filter(Boolean);
    if (cleaned.length === 0) return "";
    if (cleaned.length === 1) return compressSingleSentence(cleaned[0]);
    const allShort = cleaned.every((x) => x.length <= 24);
    if (allShort) {
      const head = topicHint || "做法";
      return head + "：" + cleaned.join("、");
    }
    return (
      renderMethodFromJoinedSentences(cleaned.map(compressSentence)) ||
      cleaned.map(compressSingleSentence).join("，")
    );
  }

  function dedupeSimilarStarts(sentences) {
    if (sentences.length <= 1) return sentences;
    const out = [];
    let prevStart = "";
    for (let di = 0; di < sentences.length; di++) {
      const s = sentences[di];
      const start = s.slice(0, Math.min(5, s.length));
      if (di > 0 && start === prevStart && start.length >= 3) continue;
      out.push(s);
      prevStart = start;
    }
    return out;
  }

  /**
   * 句子壓縮：去冗詞、合併短條列、合併相近主題短句。
   * @param {string[]} sentences
   * @param {{ topicHint?: string }} [opt]
   * @returns {string}
   */
  function compressSentences(sentences, opt) {
    const topicHint = (opt && opt.topicHint) || "";
    let parts = (sentences || [])
      .map((s) => (typeof s === "string" ? normalizeText(s) : ""))
      .filter(Boolean);
    if (!parts.length) return "";

    const merged = [];
    let buf = [];
    function flushBuf() {
      if (!buf.length) return;
      if (buf.length >= 2 && buf.every((b) => b.length <= 22 && !/[。！？]/.test(b))) {
        merged.push(compressBulletLines(buf, topicHint));
      } else {
        for (let fi = 0; fi < buf.length; fi++) merged.push(compressSingleSentence(buf[fi]));
      }
      buf = [];
    }

    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi];
      if (p.length <= 22 && !/[。！？]/.test(p) && !/^請/.test(p)) {
        buf.push(p);
      } else {
        flushBuf();
        merged.push(compressSingleSentence(p));
      }
    }
    flushBuf();

    const deduped = dedupeSimilarStarts(merged.filter(Boolean));
    return normalizeText(
      renderMethodFromJoinedSentences(deduped) || deduped.map(compressSentence).join("，")
    );
  }

  /**
   * 組裝商用輸出：IR 管線（classified → 合併語料 → buildIR → render → validate）。
   */
  function buildCompressedCommercialBody(
    classified,
    docIdx,
    causeIdx,
    evidenceIdx,
    supplementaryIdx
  ) {
    void docIdx;
    void causeIdx;
    void evidenceIdx;
    void supplementaryIdx;
    const src =
      classifiedToIRSource(classified, null) || normalizeText(stripFillersOnly(classified));
    return condenseViaIRPipeline(src);
  }

  function joinOutputBlocks(summary, method, optional) {
    return normalizeText([summary, method, optional].filter(Boolean).join("\n\n"));
  }

  /**
   * 清除步驟指引殘留（商用輸出不得帶操作步驟口語）。
   * @param {string} s
   * @returns {string}
   */
  function removeInstructionFragments(s) {
    let t = String(s || "");
    t = t.replace(/第[一二三四五六七八九十0-9]+\s*步[^。\n]*/g, "");
    t = t.replace(/\bStep\s*\d+[^。\n]*/gi, "");
    t = t.replace(/請(?:先|再|依序|依下列步驟)[^。\n]{0,120}/g, "");
    return normalizeText(
      t
        .replace(/\s{2,}/g, " ")
        .replace(/[，,]{2,}/g, "，")
        .replace(/^[,，、\s]+|[,，、\s]+$/g, "")
    );
  }

  /**
   * 若偵測到步驟用語，對 summary／method／optional 套用 {@link removeInstructionFragments}。
   * @param {string} out
   * @returns {string}
   */
  function stripInstructionLeaksFromCondenseOutput(out) {
    const o = normalizeText(String(out || ""));
    if (!/第[一二三四五六七八九]步|\bStep\b/i.test(o)) return o;
    const b = splitOutputBlocks(o);
    return normalizeText(
      joinOutputBlocks(
        removeInstructionFragments(b.summary),
        removeInstructionFragments(b.method),
        removeInstructionFragments(b.optional || "")
      )
    );
  }

  /**
   * 將字串拆成 [summary, method, optional]；單段時嘗試用分號切成兩段。
   * @returns {{ summary: string, method: string, optional: string }}
   */
  function splitOutputBlocks(text) {
    const t = normalizeText(text);
    if (!t) return { summary: "", method: "", optional: "" };
    const parts = t.split(/\n\n+/).map(normalizeText).filter(Boolean);
    if (parts.length >= 3) {
      return {
        summary: parts[0],
        method: parts[1],
        optional: parts.slice(2).join("\n\n")
      };
    }
    if (parts.length === 2) {
      return { summary: parts[0], method: parts[1], optional: "" };
    }
    const segs = parts[0].split(/[；;]/).map((s) => s.trim()).filter(Boolean);
    if (segs.length >= 2) {
      return {
        summary: segs[0],
        method: segs.slice(1).join("；"),
        optional: ""
      };
    }
    return { summary: parts[0], method: "", optional: "" };
  }

  /**
   * 收斂順序：① 刪 optional ② 縮 method（刪子句／壓縮）③ 最後才動 summary。method 不得變空。
   * @returns {string}
   */
  function safeTrimOutput(blocks, originalLength, maxRatio) {
    const r = maxRatio == null ? DEFAULT_MAX_OUTPUT_RATIO : maxRatio;
    let summary = normalizeText(blocks.summary || "");
    let method = normalizeText(blocks.method || "");
    let optional = normalizeText(blocks.optional || "");

    function compressMethodBody() {
      if (!method) return;
      const mSegs = method.split(/[；;]/).map((x) => x.trim()).filter(Boolean);
      if (mSegs.length > 1) {
        method = compressSentences(mSegs, {
          topicHint: inferListHeadFromLead(summary)
        });
      } else if (method.length > 140) {
        const sub = method.split(/[，,]/).map((x) => x.trim()).filter(Boolean);
        method =
          sub.length > 2
            ? compressSentences(sub.slice(0, 5), {
                topicHint: inferListHeadFromLead(summary)
              })
            : compressSingleSentence(method);
      } else {
        method = compressSingleSentence(method);
      }
    }

    compressMethodBody();
    if (optional) optional = compressSingleSentence(optional);

    if (!summary && method) {
      summary = capSummaryLength(method, MAX_SUMMARY_LENGTH);
      method = compressSingleSentence(
        method.length > summary.length
          ? method.slice(summary.length).replace(/^[，,；;\s]+/, "") || method
          : method
      );
    }
    if (!method && summary) {
      const segs = summary.split(/[；;]/).map((s) => s.trim()).filter(Boolean);
      if (segs.length >= 2) {
        summary = segs[0];
        method = compressSingleSentence(segs.slice(1).join("；"));
      }
    }

    function finalizeSummary() {
      summary = capSummaryLength(compressSingleSentence(summary), MAX_SUMMARY_LENGTH);
    }

    if (!originalLength) {
      finalizeSummary();
      return joinOutputBlocks(summary, method, optional);
    }

    const cap = Math.max(
      96,
      Math.floor(originalLength * r),
      Math.min(originalLength, summary.length + (method ? method.length : 0) + 8)
    );
    let out = joinOutputBlocks(summary, method, optional);
    if (out.length <= cap) {
      finalizeSummary();
      return normalizeText(joinOutputBlocks(summary, method, optional));
    }

    optional = "";
    out = joinOutputBlocks(summary, method, optional);
    if (out.length <= cap) {
      finalizeSummary();
      return normalizeText(joinOutputBlocks(summary, method, optional));
    }

    let guard = 0;
    while (out.length > cap && method && method.length > 28 && guard < 28) {
      guard++;
      const segs = method.split(/[；;]/).map((x) => x.trim()).filter(Boolean);
      if (segs.length > 1) {
        if (segs.length <= 2) {
          break;
        }
        segs.pop();
        method = segs.join("；");
        compressMethodBody();
        if (method && !/[。…；;]$/.test(method)) method += "…";
      } else {
        const cm = compressSingleSentence(method);
        if (cm.length < method.length - 2) {
          method = cm;
        } else if (method.length > 52) {
          const cutAt = Math.max(
            36,
            Math.min(method.length - 1, Math.floor(cap - summary.length - 6))
          );
          method = method.slice(0, Math.min(cutAt, method.length)).trim();
          if (method && !/[。…，,；;]$/.test(method)) method += "…";
        } else {
          break;
        }
      }
      if (!method.trim()) {
        method = blocks.method ? compressSingleSentence(blocks.method) : method;
        break;
      }
      out = joinOutputBlocks(summary, method, optional);
    }

    guard = 0;
    while (out.length > cap && summary.length > 28 && guard < 18) {
      guard++;
      summary = compressSingleSentence(summary);
      summary = capSummaryLength(
        summary,
        Math.min(MAX_SUMMARY_LENGTH, Math.max(40, Math.floor(cap * 0.48)))
      );
      out = joinOutputBlocks(summary, method, optional);
    }

    if (out.length > cap && method && method.length >= 12) {
      finalizeSummary();
      return normalizeText(joinOutputBlocks(summary, method, optional));
    }

    if (out.length > cap && !method) {
      summary = capSummaryLength(summary, Math.max(24, cap - 2));
      if (summary.length > cap) {
        summary = summary.slice(0, Math.max(1, cap - 1)).trim() + "…";
      }
    } else {
      finalizeSummary();
    }
    return normalizeText(joinOutputBlocks(summary, method, optional));
  }

  /**
   * 依比例收斂輸出：先壓縮、再刪 optional、再縮 method 子句；禁止先砍掉整段 method。
   * @param {string} text
   * @param {number} originalLength
   * @param {number} [maxRatio]
   * @returns {string}
   */
  function enforceMaxOutputRatio(text, originalLength, maxRatio) {
    if (!text) return text;
    const b = splitOutputBlocks(text);
    return safeTrimOutput(b, originalLength, maxRatio);
  }

  /** 修辭／情緒句 → 強制 filler，不進候選池 */
  const EMOTIONAL_SUBSTRINGS = [
    "令人振奮",
    "非常專業",
    "乾淨",
    "勝利",
    "精彩",
    "完美",
    "震撼",
    "準備好",
    "迎接",
    "戰役",
    "振奮",
    "令人滿意",
    "太棒了",
    "太厲害"
  ];

  /** 「令人」單獨易誤傷，僅在明顯讚嘆語境啟用 */
  const EMOTIONAL_LIKELY =
    /令人(振奮|驚豔|佩服|讚嘆|印象深刻)|非常(專業|精彩|完美|厲害)|準備好(迎接|面對)|戰役勝利/i;

  /**
   * @param {*} text
   * @returns {string}
   */
  function normalizeText(text) {
    if (text == null) return "";
    const s = typeof text === "string" ? text : String(text);
    return s
      .trim()
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/ *\n */g, "\n")
      .trim();
  }

  /**
   * 資訊密度分數（選句與 method 骨架；與 role 分開計算）。
   * @param {string} sentence
   * @returns {number}
   */
  function scoreInformationDensity(sentence) {
    const s = (sentence || "").trim();
    if (!s) return -99;
    let sc = 0;
    if (/\d/.test(s)) sc += 3;
    if (
      /\bAPI\b|endpoint|endpoints|validation|alpha|timestamp|\bHTTP\b|\bJSON\b|\bREST\b|OAuth|webhook|schema|payload/i.test(
        s
      )
    ) {
      sc += 3;
    }
    if (/\bFAIL\b|\bPASS\b|error|問題|失效|錯誤|失敗|異常/i.test(s)) sc += 2;
    if (/因為|導致|原因|關鍵是|由於|之所以|係因/i.test(s)) sc += 2;
    if (/應該|必須|建議|改為|停用|務必|不宜|需要/i.test(s)) sc += 2;
    if (s.length > 20) sc += 1;
    if (/這是一個|根據您提供|根據您|以下是|我們可以看到|這份報告顯示/.test(s)) sc -= 3;
    if (/\?|？|嗎[？?]*$/.test(s)) sc -= 5;
    if (/^請|要不要|是否要|下一步|我可以為你|我可以幫你/.test(s)) sc -= 5;
    for (let ci = 0; ci < CTA_PATTERNS.length; ci++) {
      if (CTA_PATTERNS[ci].test(s)) {
        sc -= 5;
        break;
      }
    }
    for (let ii = 0; ii < INSTRUCTION_PATTERNS.length; ii++) {
      if (INSTRUCTION_PATTERNS[ii].test(s)) {
        sc -= 5;
        break;
      }
    }
    return sc;
  }

  function passesSummaryDensityForDocSummary(text) {
    const t = (text || "").trim();
    if (!t) return false;
    if (/根據您提供|這份報告顯示|以下是/.test(t)) return false;
    return scoreInformationDensity(t) >= 2;
  }

  /**
   * 粗略分句（中英文常見句尾）。
   * @param {string} text
   * @returns {string[]}
   */
  function splitSentences(text) {
    const t = normalizeText(text);
    if (!t) return [];

    const chunks = t
      .split(
        /(?<=[。！？])\s+|(?<=[。！？])(?=[^\s])|(?<=[!?])\s+|(?<=\.)(?=\s+[A-Z\u4e00-\u9fff]|\s*$)\s+/
      )
      .map((s) => s.trim())
      .filter(Boolean);

    if (chunks.length <= 1 && t.length > 120) {
      const byComma = t.split(/(?<=[，,；;])\s+/).map((s) => s.trim()).filter(Boolean);
      if (byComma.length > 2) return byComma;
    }

    return chunks.length ? chunks : [t];
  }

  const LIST_LINE_RE =
    /^\s*([•·\-*＊]|\d+[\.)．、]|[\u2460-\u2473]|[a-zA-Z][\.)])\s*\S/;

  /**
   * 將全文切成「語意單元」：獨立條列行保留為一行；其餘再分句。
   * 利於條列骨架與散文句分開處理。
   */
  function splitIntoSemanticUnits(text) {
    const normalized = normalizeText(text);
    if (!normalized) return [];

    const units = [];
    const lines = normalized.split(/\n+/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (LIST_LINE_RE.test(trimmed)) {
        units.push(trimmed);
      } else {
        splitSentences(trimmed).forEach((u) => units.push(u));
      }
    }

    if (!units.length) return splitSentences(normalized);
    return units;
  }

  /**
   * 粗略「抽象／名詞性」分數（0～1），用於隱性 summary；非嚴格 NLP。
   */
  function nounAbstractLean(s) {
    const len = s.length;
    if (len < 12) return 0;
    const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    const particles = (s.match(/[的了嗎呢吧啊呀嘛著過在和與是就也都還很會能要會這那其]/g) || []).length;
    const pron = (s.match(/\b(I|we|you|he|she|they)\b|我|你|他|她|它|們|自己/gi) || []).length;
    const narrative = (
      s.match(
        /我來|讓我|以下是|你可以|如果您|舉例|舉個|假設|當你|當您|想像一下|首先我要說|接下來我|我們先|請看以下/i
      ) || []
    ).length;
    const abstractLex = (
      s.match(
        /概念|本質|原則|關鍵|核心|目標|目的|意義|重點|策略|面向|架構|模型|理論|定義|特性|優勢|取捨|權衡|方案|結論要點/i
      ) || []
    ).length;
    const raw =
      cjk / len +
      abstractLex * 0.08 -
      particles * 0.012 -
      pron * 0.035 -
      narrative * 0.1;
    return Math.max(0, Math.min(1, raw * 1.25));
  }

  function pushSignalUnique(signals, sig) {
    if (!signals.includes(sig)) signals.push(sig);
  }

  /**
   * 句子角色分類（規則式）。
   * @param {string} sentence
   * @returns {{ role: string, roleRank: number, signals: string[], isListLine: boolean, text: string, cannotBeDocumentSummary: boolean }}
   */
  function classifySentence(sentence) {
    const s = (sentence || "").trim();
    const signals = [];
    let role = "general";
    let roleRank = ROLE_RANK.general;
    let cannotBeDocumentSummary = false;

    if (!s) {
      return {
        role: "filler",
        roleRank: ROLE_RANK.filler,
        signals: ["empty"],
        isListLine: false,
        text: s,
        cannotBeDocumentSummary: true
      };
    }

    const isListLine = LIST_LINE_RE.test(s);
    const t = s;

    /** 極短客套 / 過場 → filler */
    if (
      /^(好的|當然|沒問題|了解|明白|收到|OK|Ok|ok|是的|沒錯)[，,。.!！]?$/.test(s) ||
      s.length <= 3
    ) {
      return {
        role: "filler",
        roleRank: ROLE_RANK.filler,
        signals: ["filler-short"],
        isListLine,
        text: s,
        cannotBeDocumentSummary: true
      };
    }

    if (EMOTIONAL_LIKELY.test(s)) {
      return {
        role: "filler",
        roleRank: ROLE_RANK.filler,
        signals: ["emotion-rhetoric"],
        isListLine,
        text: s,
        cannotBeDocumentSummary: true
      };
    }
    for (let ei = 0; ei < EMOTIONAL_SUBSTRINGS.length; ei++) {
      if (s.includes(EMOTIONAL_SUBSTRINGS[ei])) {
        return {
          role: "filler",
          roleRank: ROLE_RANK.filler,
          signals: ["emotion-rhetoric"],
          isListLine,
          text: s,
          cannotBeDocumentSummary: true
        };
      }
    }

    for (let hp = 0; hp < HYPE_PATTERNS.length; hp++) {
      if (HYPE_PATTERNS[hp].test(s)) {
        return {
          role: "filler",
          roleRank: ROLE_RANK.filler,
          signals: ["hype-filler"],
          isListLine,
          text: s,
          cannotBeDocumentSummary: true
        };
      }
    }

    /** 1) CTA → 2) 問句 → 3) 指令（強制、不可作文件結論） */
    for (let ci = 0; ci < CTA_PATTERNS.length; ci++) {
      if (CTA_PATTERNS[ci].test(t)) {
        return {
          role: "cta",
          roleRank: ROLE_RANK.cta,
          signals: ["cta-pattern"],
          isListLine,
          text: s,
          cannotBeDocumentSummary: true
        };
      }
    }
    for (let qi = 0; qi < QUESTION_PATTERNS.length; qi++) {
      if (QUESTION_PATTERNS[qi].test(t)) {
        return {
          role: "question",
          roleRank: ROLE_RANK.question,
          signals: ["question-pattern"],
          isListLine,
          text: s,
          cannotBeDocumentSummary: true
        };
      }
    }
    for (let ii = 0; ii < INSTRUCTION_PATTERNS.length; ii++) {
      if (INSTRUCTION_PATTERNS[ii].test(t)) {
        return {
          role: "instruction",
          roleRank: ROLE_RANK.instruction,
          signals: ["instruction-pattern"],
          isListLine,
          text: s,
          cannotBeDocumentSummary: true
        };
      }
    }

    function tryRoleUp(newRole, sig, re) {
      if (!re.test(s)) return;
      const rank = ROLE_RANK[newRole];
      if (rank > roleRank) {
        role = newRole;
        roleRank = rank;
        pushSignalUnique(signals, sig);
      }
    }

    for (let ip = 0; ip < ISSUE_PATTERNS.length; ip++) {
      if (ISSUE_PATTERNS[ip].test(t)) {
        role = "issue";
        roleRank = ROLE_RANK.issue;
        pushSignalUnique(signals, "issue-pattern");
        break;
      }
    }

    for (let dp = 0; dp < DECISION_PATTERNS.length; dp++) {
      tryRoleUp("decision", "decision-pattern", DECISION_PATTERNS[dp]);
    }

    tryRoleUp(
      "summary",
      "summary-keyword",
      /結論是|總結來說|總而言之|簡而言之|綜合以上|核心是|重點在於|最重要的是|關鍵在於|整體而言|簡單講/i
    );

    tryRoleUp(
      "evidence",
      "risk-consequence",
      /會導致|容易导致|容易造成|可能出現|可能會有|很難維護|不穩定|產生衝突|衝突|可能失效|失效|破版|成本增加|成本上升|不一致|易出錯|資料遺失|無法運行|當機|崩潰|隱藏風險|有風險|出問題|踩雷|誤判|誤用|難以擴展|效能問題|安全疑慮/i
    );

    tryRoleUp(
      "summary",
      "summary-tone",
      /代表著|^代表|意味著|因此建議|因此比較|因此若|所以可以選|所以建議|所以較|所以應|建議你|建議可以|建議選|建議採用|不建議|最不適合|最適合|應該要|應該選|應該會|應該優先|不宜|務必|務請/i
    );

    tryRoleUp(
      "step",
      "step-keyword",
      /首先|其次|再來|最後|做法是|建議流程|操作步驟|請依序|依序|流程如下/i
    );

    tryRoleUp(
      "evidence",
      "result-verify",
      /\bPASS\b|\bpass\b|\bcheck\b|\bchecks\b|fallback|透明|pop|shadow|audit|驗證通過|通過驗證|檢查通過|0\s*fallback|\d+\s*checks?|\d+\s*\/\s*\d+\s*(通過|OK|Pass)/i
    );

    tryRoleUp(
      "cause",
      "cause-keyword",
      /因為|原因是|主要原因|這是因為|由於|之所以|(?<!會)導致|造成|起因於/i
    );
    if (/所以|因此|故而/.test(s) && (/.{0,10}(因為|由於|原因|既然)/.test(s) || s.length < 55)) {
      if (!/所以建議|所以應|所以可以選|因此建議|因此若/.test(s)) {
        tryRoleUp("cause", "cause-so", /所以|因此|故而/);
      }
    }

    tryRoleUp(
      "evidence",
      "risk-keyword",
      /但要注意|不過要注意|缺點是|風險在於|限制是|前提是|例外情況|可能失敗|避免|切勿|警告|副作用/i
    );

    tryRoleUp(
      "compare",
      "compare-keyword",
      /差異在於|相比之下|相較之下|比較起來|優點是|缺點是|較適合|不適合|優於|劣於|A\s*比\s*B|與.*相比/i
    );

    const factRe =
      /\d+%|\d+\s*%|\d{4}\s*年|\d{1,2}\/\d{1,2}|NT\$|NTD|\$|€|£|RMB|CNY|價格|版本|型號|v\d+\.\d+|API\s*\d/i;
    if (factRe.test(s) || /\d{3,}/.test(s)) {
      if (ROLE_RANK.evidence > roleRank) {
        role = "evidence";
        roleRank = ROLE_RANK.evidence;
        pushSignalUnique(signals, "fact-entity");
      }
    }

    if (
      /^(以下是|我來幫你|可以這樣理解|讓我為你整理|接下來|首先說明)/i.test(s) &&
      s.length < 45 &&
      !isListLine
    ) {
      return {
        role: "filler",
        roleRank: ROLE_RANK.filler,
        signals: ["filler-opener"],
        isListLine,
        text: s,
        cannotBeDocumentSummary: true
      };
    }

    if (isListLine && role !== "issue" && role !== "summary" && role !== "evidence") {
      if (/^\s*\d+[\.)．、]/.test(s) || /第[一二三四五六七八九十\d]+/.test(s)) {
        if (!["cause", "compare"].includes(role)) {
          role = "step";
          roleRank = ROLE_RANK.step;
          pushSignalUnique(signals, "list-ordered");
        }
      } else if (role === "general") {
        role = "evidence";
        roleRank = ROLE_RANK.evidence;
        pushSignalUnique(signals, "list-bullet");
      }
    }

    const strongSummaryLock =
      role === "summary" &&
      signals.some((sig) =>
        ["summary-keyword", "summary-para-start", "summary-para-end"].includes(sig)
      );
    if (!strongSummaryLock && isExtendedInstructionLike(s, role)) {
      role = "instruction";
      roleRank = ROLE_RANK.instruction;
      pushSignalUnique(signals, "instruction-extended");
      cannotBeDocumentSummary = true;
    }

    if (/^第[一二三四五六七八九十]步/.test(t)) {
      cannotBeDocumentSummary = true;
    }

    return { role, roleRank, signals, isListLine, text: s, cannotBeDocumentSummary };
  }

  /**
   * 嘗試將角色升級為更高權重（roleRank 數字更大）。
   * @returns {boolean}
   */
  function tryPromoteRole(cls, newRole, signal) {
    const rank = ROLE_RANK[newRole];
    if (rank <= cls.roleRank) return false;
    cls.role = newRole;
    cls.roleRank = rank;
    pushSignalUnique(cls.signals, signal);
    return true;
  }

  /**
   * 第二階段：段首／段尾與隱性風險補強（需完整 classified 陣列）。
   */
  function refineImplicitRoles(classified) {
    const n = classified.length;
    for (let i = 0; i < n; i++) {
      const cls = classified[i].cls;
      const s = cls.text;
      if (cls.role === "filler") continue;
      if (cls.cannotBeDocumentSummary || ["cta", "question", "instruction"].includes(cls.role)) {
        continue;
      }
      if (isExtendedInstructionLike(s, cls.role)) continue;

      for (let dr = 0; dr < DECISION_PATTERNS.length; dr++) {
        if (DECISION_PATTERNS[dr].test(s)) {
          tryPromoteRole(cls, "decision", "decision-refine");
          break;
        }
      }

      const atParaStart = i === 0 || (i > 0 && classified[i - 1].cls.isListLine);
      const atParaEnd =
        i === n - 1 || (i < n - 1 && classified[i + 1].cls.isListLine);

      const lean = nounAbstractLean(s);
      const lowNarr = !/我來|讓我|以下是|你可以|如果您|舉例|舉個|假設|請參考|詳見下表|如圖|以下範例/i.test(
        s
      );

      if (cls.role === "general") {
        for (let ip = 0; ip < ISSUE_PATTERNS.length; ip++) {
          if (ISSUE_PATTERNS[ip].test(s)) {
            tryPromoteRole(cls, "issue", "issue-refine");
            break;
          }
        }
      }

      if (
        cls.role === "general" &&
        atParaStart &&
        s.length >= 14 &&
        s.length <= 240 &&
        lean >= 0.36 &&
        lowNarr
      ) {
        tryPromoteRole(cls, "summary", "summary-para-start");
      }

      if (
        (cls.role === "general" || cls.role === "cause") &&
        atParaEnd &&
        s.length >= 14 &&
        s.length <= 340
      ) {
        const closingTone =
          /總之|綜上所述|綜合來說|由此可見|以上說明|整體來看|簡單結論|最後[，,]?(若|建議|提醒)|因此[，,]?$|所以[，,]?$/i.test(
            s
          );
        const tightEnd =
          lean >= 0.38 && lowNarr && /[。！？.!?]$/.test(s) && s.length <= 140;
        if (closingTone || tightEnd) {
          tryPromoteRole(cls, "summary", "summary-para-end");
        }
      }

      if (cls.role === "general") {
        if (
          /潛在問題|隱含風險|副作用|務必留意|務必注意|千萬別|不要忽略|謹慎使用|容易翻車|可能會失敗|有機會失敗|不保證|無法保證/i.test(
            s
          )
        ) {
          tryPromoteRole(cls, "evidence", "risk-implicit");
        }
      }
    }
  }

  /**
   * 依分類計算保留分數（roleRank 愈高愈優先，再比訊號與長度）。
   */
  function scoreSentence(cls) {
    let sc = cls.roleRank * 3;
    sc += cls.signals.length * 5;
    if (cls.isListLine) sc += 12;
    if (cls.signals.some((sig) => /^summary-para-/.test(sig))) sc += 18;
    if (cls.signals.includes("summary-tone")) sc += 10;
    if (cls.signals.includes("result-verify")) sc += 14;
    if (
      cls.signals.includes("risk-consequence") ||
      cls.signals.includes("risk-implicit") ||
      cls.signals.includes("risk-keyword")
    ) {
      sc += 12;
    }
    if (cls.role === "decision") sc += 25;
    if (cls.role === "instruction" || cls.role === "cta" || cls.role === "question") {
      sc -= 85;
    }
    const len = cls.text.length;
    if (len > 120 && len < 400) sc += 6;
    if (len > 400) sc += 3;
    return sc;
  }

  /** 動詞密度懲罰（文件結論偏好「抽象／名詞性」敘述） */
  function verbLeanPenalty(s) {
    const verbs = (
      s.match(
        /是|有|為|可以|能夠|進行|做|完成|達成|解決|通過|實現|變成|需要|必須|會|要|正在|開始|結束|跑|執行/g
      ) || []
    ).length;
    return verbs / Math.max(s.length, 1);
  }

  function pickBestDocSummaryFromPool(items, classifiedSentences) {
    const n = classifiedSentences.length;
    let best = items[0];
    let bestScore = -Infinity;
    for (let p = 0; p < items.length; p++) {
      const item = items[p];
      const s = item.cls.text;
      const posRatio = n <= 1 ? 0.5 : item.index / (n - 1);
      const inEdge = posRatio <= 0.2 || posRatio >= 0.8;
      let sc = 0;
      if (item.cls.role === "decision") sc += 195;
      if (item.cls.role === "issue") sc += 165;
      if (item.cls.role === "summary") sc += 142;
      if (inEdge) sc += 42;
      if (/已經|完全|成功|確定|達成|\bPASS\b|解決|完成|通過了|搞定了|生效|正常運作/i.test(s)) {
        sc += 48;
      }
      sc += nounAbstractLean(s) * 70;
      sc -= verbLeanPenalty(s) * 200;
      sc += scoreSentence(item.cls) * 0.15;
      sc += scoreInformationDensity(s) * 6;
      if (item.cls.role === "step") sc -= 100;
      if (/\b404\b|\b500\b|502|錯誤|失敗|問題是|問題在|API.*回傳|回傳\s*\d{3}/i.test(s)) {
        sc += 55;
      }
      if (/^因為|^由於|^之所以/.test(s.trim())) sc -= 38;
      if (/建議|改為|應該|必須|解法|處理方式/.test(s)) sc -= 22;
      if (sc > bestScore) {
        bestScore = sc;
        best = item;
      }
    }
    return best.index;
  }

  /**
   * 文件級主結論：decision → issue → summary → 其餘。
   * @param {{ index: number, cls: object }[]} classifiedSentences
   * @returns {number|null}
   */
  function pickDocumentSummary(classifiedSentences) {
    const pool = classifiedSentences.filter(
      (x) => x.cls.role !== "filler" && !x.cls.cannotBeDocumentSummary
    );
    if (!pool.length) {
      const any = classifiedSentences.filter((x) => x.cls.role !== "filler");
      if (!any.length) return null;
      const fb = any.find((x) => !["cta", "instruction", "question"].includes(x.cls.role));
      return fb ? fb.index : any[0].index;
    }

    function tierPick(role) {
      const cand = pool.filter((x) => x.cls.role === role);
      if (!cand.length) return null;
      const strict = cand.filter((x) => passesSummaryDensityForDocSummary(x.cls.text));
      if (!strict.length) return null;
      return pickBestDocSummaryFromPool(strict, classifiedSentences);
    }

    let picked = tierPick("decision");
    if (picked != null) return picked;
    picked = tierPick("issue");
    if (picked != null) return picked;
    picked = tierPick("summary");
    if (picked != null) return picked;

    const soft = pool.filter((x) => {
      const tm = x.cls.text.trim();
      if (["cta", "instruction", "question"].includes(x.cls.role)) return false;
      if (x.cls.role === "step") return false;
      if (/^第[一二三四五六七八九十]步/.test(tm)) return false;
      if (/^第[一二三四五六七八九十\d十]+步/.test(tm)) return false;
      return true;
    });
    const softStrict = soft.filter((x) => passesSummaryDensityForDocSummary(x.cls.text));
    if (softStrict.length) return pickBestDocSummaryFromPool(softStrict, classifiedSentences);
    const softDense = soft.filter(
      (x) =>
        scoreInformationDensity(x.cls.text) >= 2 &&
        !/根據您提供|這份報告顯示|以下是/.test(x.cls.text)
    );
    if (softDense.length) return pickBestDocSummaryFromPool(softDense, classifiedSentences);

    const lastResort = pool.filter((x) => !["cta", "instruction", "question"].includes(x.cls.role));
    const lrStrict = lastResort.filter((x) => passesSummaryDensityForDocSummary(x.cls.text));
    if (lrStrict.length) return pickBestDocSummaryFromPool(lrStrict, classifiedSentences);
    const lrDense = lastResort.filter(
      (x) =>
        scoreInformationDensity(x.cls.text) >= 2 &&
        !/根據您提供|這份報告顯示|以下是/.test(x.cls.text)
    );
    if (lrDense.length) return pickBestDocSummaryFromPool(lrDense, classifiedSentences);
    if (lastResort.length) return pickBestDocSummaryFromPool(lastResort, classifiedSentences);

    const byDen = [...pool].sort(
      (a, b) => scoreInformationDensity(b.cls.text) - scoreInformationDensity(a.cls.text)
    );
    return byDen[0].index;
  }

  const CAUSE_HINT_RE =
    /因為|由於|之所以|關鍵在|關鍵是|關鍵在於|核心是|核心在於|關鍵原因|使得|這是因為|主要因為|overridden|強制|更新為|修正為|改為|係因|源於|(?<!會)導致/i;

  /**
   * 最佳「原因／機制」句。
   * @param {{ index: number, cls: object }[]} classifiedSentences
   * @returns {number|null}
   */
  function pickBestCauseSentence(classifiedSentences) {
    const pool = classifiedSentences.filter(
      (x) =>
        x.cls.role !== "filler" &&
        !["cta", "instruction", "question"].includes(x.cls.role) &&
        !isExtendedInstructionLike(x.cls.text, x.cls.role) &&
        CAUSE_HINT_RE.test(x.cls.text)
    );
    if (!pool.length) return null;
    pool.sort((a, b) => {
      const da = a.cls.role === "cause" ? 40 : 0;
      const db = b.cls.role === "cause" ? 40 : 0;
      if (db !== da) return db - da;
      return scoreSentence(b.cls) - scoreSentence(a.cls);
    });
    return pool[0].index;
  }

  /**
   * 驗證型／高密度證據句（用於因果配對後的證據槽）。
   * @param {{ cls: object }} item
   * @returns {boolean}
   */
  function isVerificationEvidence(item) {
    if (!item || item.cls.role === "filler") return false;
    const s = item.cls.text;
    if (item.cls.signals.includes("result-verify")) return true;
    if (item.cls.role === "evidence" && s.length <= 220) return true;
    if (
      /\bPASS\b|\bpass\b|\bcheck\b|fallback|透明|pop|shadow|audit|\d+\s*checks?|0\s*fallback|驗證|通過|檢查點/i.test(
        s
      )
    ) {
      return true;
    }
    if (item.cls.role === "step" && s.length <= 130 && /\d|PASS|check|通過|✓|✔|☑/i.test(s)) {
      return true;
    }
    return false;
  }

  /**
   * 強制 method 段：evidence → cause → general（高 density），至少 2 句；不足則取最高分 2 句。
   * @param {{ index: number, cls: object }[]} classified
   * @param {Set<number>} [excludeSet] 通常排除 docSummary 句 index
   * @returns {string}
   */
  function buildMethodBlock(classified, excludeSet) {
    const ex = excludeSet || new Set();
    function eligible(x) {
      if (!x || x.cls.role === "filler") return false;
      if (["cta", "instruction", "question"].includes(x.cls.role)) return false;
      if (ex.has(x.index)) return false;
      if (isExtendedInstructionLike(x.cls.text, x.cls.role)) return false;
      return true;
    }
    function combScore(item) {
      return (
        scoreInformationDensity(item.cls.text) * 120 +
        scoreSentence(item.cls) +
        (isVerificationEvidence(item) ? 40 : 0)
      );
    }
    function poolByRole(role) {
      return classified
        .filter((x) => eligible(x) && x.cls.role === role)
        .sort((a, b) => combScore(b) - combScore(a));
    }
    const evP = poolByRole("evidence");
    const causeP = poolByRole("cause");
    const genP = poolByRole("general");
    const cmpP = poolByRole("compare");
    const stepP = poolByRole("step");
    const ordered = [];
    const seen = new Set();
    function tryPushDense(item) {
      if (!item || seen.has(item.index)) return;
      if (scoreInformationDensity(item.cls.text) < 2) return;
      seen.add(item.index);
      ordered.push(item);
    }
    const pri = [...evP, ...causeP, ...genP, ...cmpP, ...stepP];
    for (let pi = 0; pi < pri.length && ordered.length < 3; pi++) {
      tryPushDense(pri[pi]);
    }
    if (ordered.length < 2) {
      const fb = classified
        .filter((x) => eligible(x))
        .sort((a, b) => combScore(b) - combScore(a));
      ordered.length = 0;
      seen.clear();
      for (let fi = 0; fi < fb.length && ordered.length < 2; fi++) {
        if (seen.has(fb[fi].index)) continue;
        seen.add(fb[fi].index);
        ordered.push(fb[fi]);
      }
    }
    const hasAction = ordered.some((idx) => {
      const it = classified.find((c) => c.index === idx);
      return it && /建議|改為|應該|必須|停用|務必|不宜/.test(it.cls.text);
    });
    if (!hasAction) {
      const act = classified
        .filter(
          (x) =>
            eligible(x) &&
            /建議|改為|應該|必須|停用|務必/.test(x.cls.text) &&
            !seen.has(x.index)
        )
        .sort((a, b) => combScore(b) - combScore(a))[0];
      if (act) {
        seen.add(act.index);
        ordered.push(act);
      }
    }

    const finalOrdered = ordered.slice(0, 4);
    const texts = finalOrdered.map((it) => it.cls.text).filter(Boolean);
    if (!texts.length) return "";
    return normalizeText(renderMethodFromJoinedSentences(texts));
  }

  function extractDifferentSentence(classified, summaryText) {
    const sumKey = compressSingleSentence(summaryText || "");
    const pool = classified
      .filter(
        (x) =>
          x.cls.role !== "filler" &&
          !["cta", "instruction", "question"].includes(x.cls.role) &&
          !isExtendedInstructionLike(x.cls.text, x.cls.role) &&
          compressSingleSentence(x.cls.text) !== sumKey
      )
      .sort(
        (a, b) =>
          scoreInformationDensity(b.cls.text) - scoreInformationDensity(a.cls.text)
      );
    const top = pool[0];
    return top ? compressSingleSentence(top.cls.text) : "";
  }

  /**
   * @param {string} summary
   * @param {string} method
   * @param {{ index: number, cls: object }[]} classified
   * @returns {{ summary: string, method: string }}
   */
  function extractOutcomeOverlapTokens(text) {
    const re = /修正|解決|提升|改善|完成|已修復|已修正|落地|上線/g;
    const out = [];
    let mm;
    const t = String(text || "");
    re.lastIndex = 0;
    while ((mm = re.exec(t)) !== null) {
      if (!out.includes(mm[0])) out.push(mm[0]);
    }
    return out;
  }

  function hasSummaryMethodOutcomeOverlap(summary, method) {
    const ts = extractOutcomeOverlapTokens(summary);
    const tm = extractOutcomeOverlapTokens(method);
    return ts.length > 0 && tm.length > 0 && ts.some((k) => tm.includes(k));
  }

  function rebuildMethodForOutcomeDedupe(classified, summaryText) {
    const causePool = classified
      .filter(
        (x) =>
          x.cls.role !== "filler" &&
          !["cta", "instruction", "question"].includes(x.cls.role) &&
          !isExtendedInstructionLike(x.cls.text, x.cls.role) &&
          !isHypeSentence(x.cls.text) &&
          /因為|由於|透過|將|改為|調整|檢查|驗證|參數|路徑|設定|endpoint|API/.test(x.cls.text)
      )
      .sort(
        (a, b) =>
          scoreInformationDensity(b.cls.text) - scoreInformationDensity(a.cls.text)
      );
    const texts = [];
    for (let ci = 0; ci < causePool.length && texts.length < 3; ci++) {
      const tx = causePool[ci].cls.text;
      const tok = extractOutcomeOverlapTokens(tx);
      const stok = extractOutcomeOverlapTokens(summaryText);
      if (tok.some((k) => stok.includes(k))) continue;
      texts.push(tx);
    }
    if (!texts.length) return "";
    return normalizeText(renderMethodFromJoinedSentences(texts));
  }

  function dedupeBlocks(summary, method, classified) {
    let s = normalizeText(summary);
    let m = normalizeText(method);
    if (!m) return { summary: s, method: m };
    if (s.length >= 8) {
      const head = s.slice(0, 20);
      if (head.length >= 6 && m.startsWith(head)) {
        if (m.includes(s)) {
          m = m.replace(s, "").trim();
        } else {
          m = m.split(s).join("").trim();
        }
        m = m.replace(/^[，,；;\s\n]+/, "").trim();
      }
    }
    if (!m) {
      const alt0 = extractDifferentSentence(classified, s);
      m = alt0 ? renderMethodFromJoinedSentences([alt0]) : method;
    }
    if (s && m && compressSingleSentence(s) === compressSingleSentence(m)) {
      const alt1 = extractDifferentSentence(classified, s);
      m = alt1 ? renderMethodFromJoinedSentences([alt1]) : m;
    }
    if (s && m && hasSummaryMethodOutcomeOverlap(s, m)) {
      let rebuilt = rebuildMethodForOutcomeDedupe(classified, s);
      if (!rebuilt || hasSummaryMethodOutcomeOverlap(s, rebuilt)) {
        const alt = extractDifferentSentence(classified, s);
        rebuilt = alt ? normalizeText(renderMethodFromJoinedSentences([alt])) : "";
      }
      if (rebuilt && !hasSummaryMethodOutcomeOverlap(s, rebuilt)) {
        m = rebuilt;
      } else if (rebuilt) {
        m = rebuilt;
      }
    }
    return { summary: s, method: normalizeText(m) };
  }

  /** 粗估中文比例，用於分級長度 */
  function cjkRatio(text) {
    if (!text) return 0;
    let c = 0;
    for (let i = 0; i < Math.min(text.length, 800); i++) {
      const code = text.charCodeAt(i);
      if (code >= 0x4e00 && code <= 0x9fff) c++;
    }
    const sample = Math.min(text.length, 800);
    return sample ? c / sample : 0;
  }

  /**
   * 分級目標長度上限（非硬截斷，後續依句選滿骨架為止）。
   */
  function targetCharBudget(originalLength, textSample) {
    if (originalLength <= 220) {
      return Math.max(60, Math.floor(originalLength * DEFAULT_MAX_OUTPUT_RATIO));
    }
    const cjk = cjkRatio(textSample);
    const isZhLean = cjk >= 0.35;
    const r = isZhLean ? 0.28 : 0.25;
    return Math.max(120, Math.floor(originalLength * r));
  }

  /**
   * 條列組：Step1 角色覆蓋（summary、risk）→ Step2 有 cause 時優先驗證型句，其餘依分數補滿（最多 3～4 條）。
   * @param {{ index: number, cls: object }[]} block
   * @param {number} keepCount
   * @param {{ hasCause?: boolean }} [opts]
   * @returns {Set<number>}
   */
  function pickListGroupWithHighValue(block, keepCount, opts) {
    const hasCause = opts && opts.hasCause;
    const chosen = new Set();
    const summaries = block
      .filter(
        (x) =>
          x.cls.role === "summary" || x.cls.role === "issue" || x.cls.role === "decision"
      )
      .sort((a, b) => scoreSentence(b.cls) - scoreSentence(a.cls));
    const risks = block
      .filter(
        (x) =>
          x.cls.role === "evidence" &&
          (x.cls.signals.includes("risk-keyword") ||
            x.cls.signals.includes("risk-consequence") ||
            x.cls.signals.includes("risk-implicit"))
      )
      .sort((a, b) => scoreSentence(b.cls) - scoreSentence(a.cls));
    if (summaries[0]) chosen.add(summaries[0].index);
    if (risks[0]) chosen.add(risks[0].index);

    const restPool = block.filter((x) => !chosen.has(x.index));
    const sorted = [...restPool].sort((a, b) => {
      if (hasCause) {
        const va = isVerificationEvidence(a) ? 80 : 0;
        const vb = isVerificationEvidence(b) ? 80 : 0;
        if (vb !== va) return vb - va;
      }
      return scoreSentence(b.cls) - scoreSentence(a.cls);
    });
    for (let p = 0; p < sorted.length && chosen.size < keepCount; p++) {
      chosen.add(sorted[p].index);
    }
    let guard = 0;
    while (chosen.size < Math.min(keepCount, block.length) && guard < block.length + 2) {
      guard++;
      for (let q = 0; q < sorted.length; q++) {
        const item = sorted[q];
        if (!chosen.has(item.index)) {
          chosen.add(item.index);
          break;
        }
      }
    }
    return chosen;
  }

  /**
   * 連續條列組壓縮為最多 3～4 點（先角色覆蓋再補分，已選 index 略過）。
   * @param {{ hasCause?: boolean }} [listOpts]
   * @returns {number} listGroupCount
   */
  function selectFromListGroups(classified, budget, pickedSet, listOpts) {
    const n = classified.length;
    let i = 0;
    let listGroupCount = 0;
    while (i < n) {
      if (!classified[i].cls.isListLine) {
        i++;
        continue;
      }
      const start = i;
      while (i < n && classified[i].cls.isListLine) i++;
      const block = classified.slice(start, i);
      listGroupCount++;
      const bl = block.length;
      const keepCount =
        bl <= 2 ? bl : Math.min(4, Math.max(3, Math.ceil(bl * 0.35)));
      const chosen = pickListGroupWithHighValue(block, keepCount, listOpts);
      for (let bi = 0; bi < block.length; bi++) {
        const item = block[bi];
        if (!chosen.has(item.index)) continue;
        if (pickedSet.has(item.index)) continue;
        const len = item.cls.text.length + 2;
        if (budget.remaining >= len) {
          pickedSet.add(item.index);
          budget.remaining -= len;
        }
      }
    }
    return listGroupCount;
  }

  /**
   * 提要型輸出：結論 → 原因 → 證據 → 補充（非原文時間序）。
   * @param {{ index: number, cls: object }[]} classified
   * @param {number[]} orderedIndices
   * @returns {string}
   */
  function buildStructuredCondenseSequence(classified, orderedIndices) {
    const byIndex = {};
    for (let ci = 0; ci < classified.length; ci++) {
      byIndex[classified[ci].index] = classified[ci];
    }
    const seen = new Set();
    const items = [];
    for (let oi = 0; oi < orderedIndices.length; oi++) {
      const idx = orderedIndices[oi];
      if (idx == null || seen.has(idx)) continue;
      const cur = byIndex[idx];
      if (!cur || cur.cls.role === "filler") continue;
      seen.add(idx);
      items.push(cur);
    }
    const parts = [];
    let prev = null;
    for (let ii = 0; ii < items.length; ii++) {
      const cur = items[ii];
      if (ii > 0) {
        if (cur.cls.isListLine || (prev && prev.cls.isListLine)) parts.push("\n");
        else parts.push(" ");
      }
      parts.push(cur.cls.text);
      prev = cur;
    }
    return normalizeText(parts.join("").replace(/\n{3,}/g, "\n\n"));
  }

  function pickedCharLength(classified, pickedSet) {
    let sum = 0;
    pickedSet.forEach((i) => {
      const u = classified[i];
      if (u) sum += u.cls.text.length + 2;
    });
    return sum;
  }

  function stripFillersOnly(classified) {
    return classified
      .filter((x) => x.cls.role !== "filler")
      .map((x) => x.cls.text)
      .join(" ");
  }

  /**
   * 保底：最高資訊密度句 → summary，次高 → method（非首末機械截斷）。
   */
  function fallbackCondense(normalized, classified) {
    const eligible = classified.filter(
      (x) =>
        x.cls.role !== "filler" &&
        !["cta", "instruction", "question"].includes(x.cls.role) &&
        !isExtendedInstructionLike(x.cls.text, x.cls.role)
    );
    eligible.sort(
      (a, b) =>
        scoreInformationDensity(b.cls.text) - scoreInformationDensity(a.cls.text) ||
        scoreSentence(b.cls) - scoreSentence(a.cls)
    );
    const first = eligible[0];
    const methodSrc = eligible
      .filter((x) => !first || x.index !== first.index)
      .slice(0, 3)
      .map((x) => x.cls.text)
      .filter(Boolean);

    let lead = first
      ? finalizeSummaryTextWithQuality(classified, first.cls.text, first.index)
      : "";
    let method = methodSrc.length
      ? normalizeText(
          renderMethodFromJoinedSentences(methodSrc) || ensureFullSentence(compressSentence(methodSrc[0]))
        )
      : "";

    const ex = new Set();
    if (first) ex.add(first.index);

    if (!method) {
      method =
        buildMethodBlock(classified, ex) ||
        fallbackMethod(classified, ex) ||
        (normalized.length > 24
          ? ensureFullSentence(compressSentence(normalized.slice(0, 200)))
          : "");
    }
    if (!lead && !method) {
      const t = normalized.slice(0, Math.min(100, normalized.length)).trim();
      return normalized.length > 100 ? t + "…" : t;
    }
    if (!lead) {
      const ref = first || eligible[0];
      lead = ref
        ? finalizeSummaryTextWithQuality(classified, ref.cls.text, ref.index)
        : lead;
    }
    if (
      method &&
      lead &&
      compressSingleSentence(method) === compressSingleSentence(lead)
    ) {
      method =
        normalizeText(
          renderMethodFromJoinedSentences([extractDifferentSentence(classified, lead)].filter(Boolean)) ||
            buildMethodBlock(classified, ex) ||
            method
        );
    }
    if (!method || method.length < 8) {
      method =
        buildMethodBlock(classified, ex) ||
        fallbackMechanism(inferMechanismTypeFromClassified(classified)).method;
    }
    if (!lead || lead.length < 6) {
      lead = fallbackFirstValidSentence(classified) || capSummaryLength(normalized.slice(0, 90), MAX_SUMMARY_LENGTH);
    }

    const deduped = dedupeBlocks(lead, method, classified);
    return normalizeText(
      stripInstructionLeaksFromCondenseOutput(
        joinOutputBlocks(deduped.summary, deduped.method, "")
      )
    );
  }

  function fallbackFirstValidSentence(classified) {
    const pool = classified.filter(
      (x) =>
        x.cls.role !== "filler" &&
        !["cta", "instruction", "question"].includes(x.cls.role) &&
        passesSummaryDensityForDocSummary(x.cls.text)
    );
    pool.sort(
      (a, b) =>
        scoreInformationDensity(b.cls.text) - scoreInformationDensity(a.cls.text)
    );
    let x = pool[0];
    if (!x) {
      x = classified.find(
        (c) =>
          c.cls.role !== "filler" &&
          !["cta", "instruction", "question"].includes(c.cls.role)
      );
    }
    return x ? finalizeSummaryTextWithQuality(classified, x.cls.text, x.index) : "";
  }

  function hardGuardFinalOutput(text, normalized, classified) {
    let out = normalizeText(text || "");
    if (!out.includes("\n\n")) {
      out = fallbackCondense(normalized, classified);
    }
    const blocks = splitOutputBlocks(out);
    let summary = blocks.summary;
    let method = blocks.method;
    const docI = pickDocumentSummary(classified);

    if (!method || method.length < 20) {
      const ex = new Set();
      if (docI != null) ex.add(docI);
      const forced = buildMethodBlock(classified, ex);
      if (forced && forced.length >= 12) {
        method = forced;
      } else if (method && forced) {
        method = normalizeText(method + "；" + forced);
      } else {
        method = forced || method || buildMethodBlock(classified, new Set());
      }
    }

    if (!summary || summary.length < 10) {
      summary = fallbackFirstValidSentence(classified);
    }

    const deduped = dedupeBlocks(summary, method, classified);
    summary = deduped.summary;
    method = deduped.method;

    if (!method || method.length < 20) {
      const f2 = buildMethodBlock(classified, new Set(docI != null ? [docI] : []));
      if (f2) method = normalizeText((method ? method + "；" : "") + f2);
    }

    if (method && /[；;]/.test(method)) {
      const pieces = method.split(/[；;]/).map((x) => x.trim()).filter(Boolean);
      method = normalizeText(renderMethodFromJoinedSentences(pieces) || method);
    }

    out = joinOutputBlocks(summary, method, blocks.optional);
    if (!out.includes("\n\n")) {
      out = fallbackCondense(normalized, classified);
    }
    const finalBlocks = splitOutputBlocks(out);
    let sumF = stripRawDataForPublication(finalBlocks.summary).replace(/原因|問題/g, "狀態");
    let metF = stripRawDataForPublication(finalBlocks.method);
    try {
      validateOutput(sumF, metF);
    } catch (e) {
      const fb = fallbackMechanism(inferMechanismTypeFromClassified(classified));
      sumF = fb.summary;
      metF = fb.method;
    }
    out = joinOutputBlocks(sumF, metF, finalBlocks.optional);
    return normalizeText(stripInstructionLeaksFromCondenseOutput(out));
  }

  function countListGroups(classified) {
    const n = classified.length;
    let i = 0;
    let listGroupCount = 0;
    while (i < n) {
      if (!classified[i].cls.isListLine) {
        i++;
        continue;
      }
      listGroupCount++;
      while (i < n && classified[i].cls.isListLine) i++;
    }
    return listGroupCount;
  }

  function buildDebugBlock(classified, pickedSet, extras) {
    const pickedRoles = [...pickedSet]
      .sort((a, b) => a - b)
      .map((i) => (classified[i] ? classified[i].cls.role : "?"));
    return {
      pickedRoles,
      usedFallback: !!extras.usedFallback,
      hadSummary: classified.some(
        (x) =>
          x.cls.role === "summary" ||
          x.cls.role === "issue" ||
          x.cls.role === "decision"
      ),
      hadRisk: classified.some(
        (x) =>
          x.cls.role === "evidence" &&
          x.cls.signals.some((sig) => /risk/i.test(sig))
      ),
      listGroupCount: extras.listGroupCount,
      candidateCount: extras.candidateCount
    };
  }

  /**
   * Condense Rules 2.0 主流程。
   * @param {string} text
   * @param {{ maxChars?: number, debug?: boolean, maxRatio?: number }} [options]
   * @returns {{ text: string, originalLength: number, condensedLength: number, ratio: number, debug?: object }}
   */
  function condenseText(text, options) {
    const normalized = normalizeText(text);
    const originalLength = normalized.length;
    const wantDebug = options && options.debug;

    if (!originalLength) {
      const empty = { text: "", originalLength: 0, condensedLength: 0, ratio: 1 };
      if (wantDebug) {
        empty.debug = {
          pickedRoles: [],
          usedFallback: false,
          hadSummary: false,
          hadRisk: false,
          listGroupCount: 0,
          candidateCount: 0
        };
      }
      return empty;
    }

    const units = splitIntoSemanticUnits(normalized);
    const classified = units.map((u, index) => ({
      index,
      cls: classifySentence(u)
    }));
    refineImplicitRoles(classified);

    /** 短文：商用壓縮輸出（不帶 instruction／CTA／問句） */
    if (originalLength <= 220) {
      let docI = pickDocumentSummary(classified);
      if (docI == null) {
        const nf = classified.find((x) => x.cls.role !== "filler");
        docI = nf ? nf.index : null;
      }
      const causeI = pickBestCauseSentence(classified);
      function omitCommercial(item) {
        if (!item || !item.cls) return true;
        const it = item.cls;
        if (it.role === "cta" || it.role === "question" || it.role === "instruction") {
          return true;
        }
        if (
          it.role === "step" &&
          /^(第一步|第二步|第三步|第[一二三四五六七八九十\d十]+步)/.test(it.text.trim())
        ) {
          return true;
        }
        return isExtendedInstructionLike(it.text, it.role);
      }
      const evMini = [];
      const supMini = [];
      for (let si = 0; si < classified.length; si++) {
        const x = classified[si];
        if (x.cls.role === "filler") continue;
        if (omitCommercial(x)) continue;
        if (x.index === docI || x.index === causeI) continue;
        if (isVerificationEvidence(x)) evMini.push(x.index);
        else supMini.push(x.index);
      }
      const maxR =
        (options && options.maxRatio) != null ? options.maxRatio : DEFAULT_MAX_OUTPUT_RATIO;
      let out = buildCompressedCommercialBody(
        classified,
        docI,
        causeI,
        evMini.slice(0, 5),
        supMini.slice(0, 5)
      );
      if (!out) out = normalizeText(stripFillersOnly(classified) || normalized);
      if (!out || !/\n\n\s*\S/.test(out)) {
        out = fallbackCondense(normalized, classified);
      }
      out = enforceMaxOutputRatio(out, originalLength, maxR);
      out = hardGuardFinalOutput(out, normalized, classified);
      const condensedLength = out.length;
      const base = {
        text: out,
        originalLength,
        condensedLength,
        ratio: Math.round((condensedLength / originalLength) * 1000) / 1000
      };
      if (wantDebug) {
        const pickedIdx = new Set(
          classified.filter((x) => x.cls.role !== "filler").map((x) => x.index)
        );
        base.debug = buildDebugBlock(classified, pickedIdx, {
          usedFallback: false,
          listGroupCount: countListGroups(classified),
          candidateCount: classified.filter((x) => x.cls.role !== "filler").length
        });
      }
      return base;
    }

    let maxChars =
      (options && options.maxChars) || targetCharBudget(originalLength, normalized);
    const maxRatioLimit =
      (options && options.maxRatio) != null ? options.maxRatio : DEFAULT_MAX_OUTPUT_RATIO;

    let docIdx = pickDocumentSummary(classified);
    if (docIdx == null) {
      const nf = classified.find((x) => x.cls.role !== "filler");
      docIdx = nf ? nf.index : null;
    }
    const causeIdx = pickBestCauseSentence(classified);
    const hasCause = causeIdx != null;

    const picked = new Set();
    if (docIdx != null) picked.add(docIdx);
    if (causeIdx != null && causeIdx !== docIdx) picked.add(causeIdx);

    const budget = { remaining: maxChars };
    budget.remaining = Math.max(0, maxChars - pickedCharLength(classified, picked));

    const evMax = hasCause ? 4 : 5;
    const evMin = 2;

    function countVerificationInPicked(pickedSet) {
      let c = 0;
      pickedSet.forEach((i) => {
        if (classified[i] && isVerificationEvidence(classified[i])) c++;
      });
      return c;
    }

    const evPool = classified
      .filter(
        (x) =>
          x.cls.role !== "filler" &&
          x.index !== docIdx &&
          (causeIdx == null || x.index !== causeIdx) &&
          isVerificationEvidence(x)
      )
      .sort((a, b) => scoreSentence(b.cls) - scoreSentence(a.cls));

    for (let ei = 0; ei < evPool.length; ei++) {
      if (countVerificationInPicked(picked) >= evMax) break;
      const e = evPool[ei];
      if (picked.has(e.index)) continue;
      const len = e.cls.text.length + 2;
      if (budget.remaining >= len) {
        picked.add(e.index);
        budget.remaining -= len;
      }
    }

    for (let ej = 0; ej < evPool.length; ej++) {
      if (countVerificationInPicked(picked) >= evMin) break;
      const e = evPool[ej];
      if (picked.has(e.index)) continue;
      picked.add(e.index);
    }

    budget.remaining = Math.max(0, maxChars - pickedCharLength(classified, picked));

    const listGroupCount = selectFromListGroups(classified, budget, picked, {
      hasCause
    });

    budget.remaining = Math.max(0, maxChars - pickedCharLength(classified, picked));

    const candidates = classified.filter((x) => x.cls.role !== "filler");
    const candidateCount = candidates.length;
    candidates.sort((a, b) => {
      const ra = b.cls.roleRank - a.cls.roleRank;
      if (ra !== 0) return ra;
      return scoreSentence(b.cls) - scoreSentence(a.cls);
    });

    for (let ci = 0; ci < candidates.length; ci++) {
      const c = candidates[ci];
      if (picked.has(c.index)) continue;
      const len = c.cls.text.length + 2;
      if (budget.remaining >= len) {
        picked.add(c.index);
        budget.remaining -= len;
      }
    }

    function rebuildStructuredText() {
      function postTailKind(idx) {
        const it = classified[idx];
        if (!it) return null;
        if (it.cls.role === "cta") return "cta";
        if (it.cls.role === "question") return "question";
        if (it.cls.role === "instruction") return "instruction";
        if (
          it.cls.role === "step" &&
          /^(第一步|第二步|第三步|第[一二三四五六七八九十\d十]+步)/.test(it.cls.text.trim())
        ) {
          return "instruction";
        }
        if (isExtendedInstructionLike(it.cls.text, it.cls.role)) return "instruction";
        return null;
      }

      const allEv = [];
      picked.forEach((i) => {
        if (
          classified[i] &&
          isVerificationEvidence(classified[i]) &&
          i !== docIdx &&
          (causeIdx == null || i !== causeIdx)
        ) {
          allEv.push(i);
        }
      });
      const evCap = hasCause ? 4 : 5;
      const allEvClean = allEv.filter((i) => !postTailKind(i));
      allEvClean.sort(
        (a, b) =>
          scoreSentence(classified[b].cls) - scoreSentence(classified[a].cls)
      );
      const evidenceIdx = allEvClean.slice(0, evCap);
      evidenceIdx.sort((a, b) => a - b);
      const inCore = new Set();
      if (docIdx != null) inCore.add(docIdx);
      if (causeIdx != null) inCore.add(causeIdx);
      for (let ex = 0; ex < evidenceIdx.length; ex++) inCore.add(evidenceIdx[ex]);
      const supplementary = [];
      picked.forEach((i) => {
        if (inCore.has(i)) return;
        if (postTailKind(i)) return;
        supplementary.push(i);
      });
      supplementary.sort((a, b) => a - b);

      let text = buildCompressedCommercialBody(
        classified,
        docIdx,
        causeIdx,
        evidenceIdx,
        supplementary
      );
      if (!text) {
        const ord = [];
        if (docIdx != null) ord.push(docIdx);
        if (causeIdx != null && causeIdx !== docIdx) ord.push(causeIdx);
        evidenceIdx.slice(0, 2).forEach((e) => ord.push(e));
        supplementary.slice(0, 2).forEach((s) => ord.push(s));
        const raw = buildStructuredCondenseSequence(classified, ord);
        text = compressSingleSentence(raw);
      }
      text = enforceMaxOutputRatio(text, originalLength, maxRatioLimit);
      return normalizeText(text);
    }

    let result = rebuildStructuredText();

    const anyVerificationInDoc = classified.some((x) => isVerificationEvidence(x));
    let qualityAdds = 0;
    for (let qi = 0; qi < candidates.length; qi++) {
      const c = candidates[qi];
      const evc = countVerificationInPicked(picked);
      if (!anyVerificationInDoc) {
        if (result.length >= 100) break;
      } else {
        if (result.length >= 100 && evc >= evMin) break;
        if (evc >= evMax && result.length >= 120) break;
      }
      if (picked.has(c.index)) continue;
      picked.add(c.index);
      result = rebuildStructuredText();
      qualityAdds++;
      if (qualityAdds > 28) break;
    }

    let usedFallback = false;
    const hasTwoBlocks = result && /\n\n\s*\S/.test(result);
    if (!result || result.length < 60 || !hasTwoBlocks) {
      usedFallback = true;
      result = fallbackCondense(normalized, classified);
      result = enforceMaxOutputRatio(result, originalLength, maxRatioLimit);
    }

    result = hardGuardFinalOutput(result, normalized, classified);

    const condensedLength = result.length;
    const ratio = originalLength ? condensedLength / originalLength : 1;

    const out = {
      text: result,
      originalLength,
      condensedLength,
      ratio: Math.round(ratio * 1000) / 1000
    };
    if (wantDebug) {
      out.debug = buildDebugBlock(classified, picked, {
        usedFallback,
        listGroupCount,
        candidateCount
      });
    }
    return out;
  }

  // =========================================================================
  // V7.5 — Extraction-based IR Pipeline (MVP: data_transformation)
  // =========================================================================

  /**
   * 句子切分：將原文切為語意完整的句子片段。
   * 優先使用句號/分號/換行分隔；長句再用逗號分隔。
   * @param {string} text
   * @returns {string[]}
   */
  function segmentText(text) {
    const t = normalizeText(text);
    if (!t) return [];
    // 先用 splitIntoSemanticUnits（已處理條列 + 句號分割）
    var units = splitIntoSemanticUnits(t);
    // 對過長的單元再做逗號分割
    var result = [];
    for (var i = 0; i < units.length; i++) {
      var u = units[i].trim();
      if (!u) continue;
      if (u.length > 60) {
        var parts = u.split(/[，,；;]\s*/).filter(Boolean);
        if (parts.length > 1) {
          for (var j = 0; j < parts.length; j++) {
            var p = parts[j].trim();
            if (p.length >= 4) result.push(p);
          }
          continue;
        }
      }
      result.push(u);
    }
    return result.length ? result : [t];
  }

  // --- Action verb whitelist / blacklist ---

  var V75_ACTION_VERBS = [
    "移除", "去除", "剝離", "清除", "截斷", "限制", "裁切",
    "替換", "轉換", "映射", "過濾", "分離", "合併", "注入",
    "攔截", "綁定", "解耦", "重導", "排程", "快取", "重試",
    "丟棄", "標記", "抓取", "驗證", "比對", "壓縮", "拆分"
  ];

  var V75_ACTION_BLACKLIST = [
    "優化", "調整", "升級", "改善", "強化", "提升", "處理", "管理"
  ];

  var V75_RESULT_BLACKLIST = [
    "確保", "提升", "改善", "優化", "強化", "變好", "變乾淨", "更穩定"
  ];

  var V75_ABSTRACT_WORDS = [
    "不穩定", "低效", "不好", "有問題", "效果差"
  ];

  // --- Affected object patterns (for bottleneck validation) ---
  var V75_AFFECTED_OBJECTS_RE = /模型|使用者|排程|模組|API|下游|系統|服務|輸出|輸入|推理|請求|回應|計算|context|pipeline|資料流/;

  // --- Candidate generation rules per type ---

  /**
   * data_transformation 候選萃取規則
   */
  var DT_ACTION_PATTERNS = [
    /(?:移除|去除|剝離|清除)\s*[^，,。；\n]{2,12}/,
    /(?:截斷|限制|裁切|控制)\s*[^，,。；\n]{2,12}/,
    /(?:替換|轉換|映射)\s*[^，,。；\n]{2,12}/,
    /(?:過濾|篩選|丟棄)\s*[^，,。；\n]{2,12}/,
    /(?:壓縮|合併|拆分)\s*[^，,。；\n]{2,12}/,
    /用\s*(?:regex|正則|正規表達式)\s*[^，,。；\n]{2,12}/,
    /(?:strip|remove|filter|truncate|clean)\s+[^，,。；\n]{2,12}/i
  ];

  var DT_CAUSE_PATTERNS = [
    /(?:因為|原因是|由於|因)\s*[^，,。；\n]{4,25}/,
    /(?:原始|來源)\s*[^，,。；\n]{2,15}(?:包含|帶有|混入|含有)[^，,。；\n]{2,15}/,
    /[^，,。；\n]{2,8}(?:包含|帶有|混入|含有)\s*[^，,。；\n]{2,15}/,
    // Implicit cause patterns (no explicit marker)
    /(?:原始|原始的|來源|輸入)\s*[^，,。；\n]{2,8}(?:長度|大小|格式|內容)[^，,。；\n]{0,12}(?:超出|過長|不一致|不規範|經常)/,
    /[^，,。；\n]{2,12}(?:經常|時常|持續|反覆)\s*[^，,。；\n]{2,12}/
  ];

  var DT_BOTTLENECK_PATTERNS = [
    /(?:干擾|破壞|拉低|超出|佔用)\s*[^，,。；\n]{2,18}/,
    /(?:導致|造成)\s*[^，,。；\n]{4,20}/,
    /(?:影響)\s*[^，,。；\n]{2,6}(?:的|之)\s*[^，,。；\n]{2,12}/
  ];

  var DT_RESULT_PATTERNS = [
    /(?:使得|使|讓)\s*[^，,。；\n]{4,20}/,
    /(?:實現|達成|產生)\s*[^，,。；\n]{4,15}/,
    /[^，,。；\n]{2,8}(?:接收|獲得|得到)\s*[^，,。；\n]{2,12}/
  ];

  // data_transformation specific object keywords (for scoring)
  var DT_SPECIFIC_OBJECTS = /HTML|tag|標籤|token|regex|正則|DOM|script|CSS|空白|字元|符號|段落|句子|文本|字數|長度|context\s*window|冗餘|雜訊|噪音|標記/i;

  /**
   * 從句子列表中萃取某欄位的候選
   * @param {string[]} sentences
   * @param {RegExp[]} patterns
   * @returns {{ text: string, sentence: string, score: number }[]}
   */
  function generateCandidates(sentences, patterns) {
    var candidates = [];
    for (var si = 0; si < sentences.length; si++) {
      var sent = sentences[si];
      for (var pi = 0; pi < patterns.length; pi++) {
        var m = sent.match(patterns[pi]);
        if (m) {
          candidates.push({ text: m[0].trim(), sentence: sent, score: 0 });
        }
      }
    }
    return candidates;
  }

  // --- Ranking / Scoring ---

  /**
   * 對候選進行具體性評分
   * @param {{ text: string, sentence: string, score: number }} candidate
   * @param {"action"|"cause"|"bottleneck"|"result"} field
   * @returns {number}
   */
  function scoreCandidateSpecificity(candidate, field) {
    var s = 0;
    var t = candidate.text;

    // +3: contains specific object
    if (DT_SPECIFIC_OBJECTS.test(t)) s += 3;

    // +2: contains whitelist verb (for action field)
    if (field === "action") {
      for (var i = 0; i < V75_ACTION_VERBS.length; i++) {
        if (t.indexOf(V75_ACTION_VERBS[i]) >= 0) { s += 2; break; }
      }
    }

    // +1: good length (10~30 chars)
    if (t.length >= 10 && t.length <= 30) s += 1;
    // +0.5: medium length (6~9)
    else if (t.length >= 6 && t.length <= 9) s += 0.5;

    // -2: contains abstract/blacklist words
    for (var j = 0; j < V75_ACTION_BLACKLIST.length; j++) {
      if (t.indexOf(V75_ACTION_BLACKLIST[j]) >= 0) { s -= 2; break; }
    }

    // +1: contains affected object (for bottleneck)
    if (field === "bottleneck" && V75_AFFECTED_OBJECTS_RE.test(t)) s += 1;

    return s;
  }

  /**
   * 從候選中選出最佳（primary）+ secondary actions
   * @param {{ text: string, sentence: string, score: number }[]} candidates
   * @param {"action"|"cause"|"bottleneck"|"result"} field
   * @returns {{ primary: string|null, secondary: string[] }}
   */
  function rankCandidates(candidates, field) {
    if (!candidates.length) return { primary: null, secondary: [] };

    // Score all candidates
    for (var i = 0; i < candidates.length; i++) {
      candidates[i].score = scoreCandidateSpecificity(candidates[i], field);
    }

    // Sort descending by score
    candidates.sort(function(a, b) { return b.score - a.score; });

    var primary = candidates[0].text;
    var secondary = [];

    if (field === "action") {
      // Collect up to 2 secondary actions (must be different and valid)
      for (var j = 1; j < candidates.length && secondary.length < 2; j++) {
        var ct = candidates[j].text;
        // Skip if same, too similar, substring, or shares 3+ char overlap with primary
        if (ct === primary) continue;
        if (diceCharSimilarity(ct, primary) >= 0.5) continue;
        if (primary.indexOf(ct) >= 0 || ct.indexOf(primary) >= 0) continue;
        // Check 3+ char continuous substring overlap
        var hasOverlap = false;
        for (var oi = 0; oi <= ct.length - 3 && !hasOverlap; oi++) {
          if (primary.indexOf(ct.substring(oi, oi + 3)) >= 0) hasOverlap = true;
        }
        if (hasOverlap) continue;
        // Skip if doesn't pass action validation
        var secValid = validateActionField(ct);
        if (!secValid.valid) continue;
        secondary.push(ct);
      }
    }

    return { primary: primary, secondary: secondary };
  }

  // --- Field-level Validation ---

  /**
   * @param {string} action
   * @returns {{ valid: boolean, reason?: string }}
   */
  function validateActionField(action) {
    if (!action || typeof action !== "string") return { valid: false, reason: "empty" };
    var a = action.trim();

    // Length check: 4~20
    if (a.length < 4) return { valid: false, reason: "too_short" };
    if (a.length > 20) return { valid: false, reason: "too_long" };

    // Must start with whitelist verb
    var hasVerb = false;
    for (var i = 0; i < V75_ACTION_VERBS.length; i++) {
      if (a.indexOf(V75_ACTION_VERBS[i]) === 0) { hasVerb = true; break; }
    }
    // Also allow "用 regex..." pattern
    if (!hasVerb && /^用\s/.test(a)) hasVerb = true;
    if (!hasVerb) return { valid: false, reason: "no_whitelist_verb" };

    // Must not contain blacklist
    for (var j = 0; j < V75_ACTION_BLACKLIST.length; j++) {
      if (a.indexOf(V75_ACTION_BLACKLIST[j]) >= 0) return { valid: false, reason: "blacklisted:" + V75_ACTION_BLACKLIST[j] };
    }

    // Must have object after verb (at least 2 more chars)
    var afterVerb = a;
    for (var k = 0; k < V75_ACTION_VERBS.length; k++) {
      if (a.indexOf(V75_ACTION_VERBS[k]) === 0) {
        afterVerb = a.substring(V75_ACTION_VERBS[k].length).trim();
        break;
      }
    }
    if (afterVerb.length < 2) return { valid: false, reason: "no_object" };

    // Object must not be a state/adjective (these are bottlenecks, not action objects)
    var V75_NON_OBJECTS = /^(?:失真|偏移|不穩|失敗|錯誤|異常|變形|混亂|中斷)$/;
    if (V75_NON_OBJECTS.test(afterVerb)) return { valid: false, reason: "object_is_state" };

    return { valid: true };
  }

  /**
   * @param {string} bottleneck
   * @param {string} cause
   * @returns {{ valid: boolean, reason?: string }}
   */
  function validateBottleneckField(bottleneck, cause) {
    if (!bottleneck || typeof bottleneck !== "string") return { valid: false, reason: "empty" };
    var b = bottleneck.trim();

    if (b.length < 6) return { valid: false, reason: "too_short" };
    if (b.length > 25) return { valid: false, reason: "too_long" };

    // Must contain affected object
    if (!V75_AFFECTED_OBJECTS_RE.test(b)) return { valid: false, reason: "no_affected_object" };

    // Must not equal cause
    if (cause && diceCharSimilarity(b, cause) > 0.8) return { valid: false, reason: "same_as_cause" };

    // Must not be only abstract words
    var onlyAbstract = true;
    for (var i = 0; i < V75_ABSTRACT_WORDS.length; i++) {
      if (b === V75_ABSTRACT_WORDS[i]) { onlyAbstract = true; break; }
      onlyAbstract = false;
    }
    // re-check: if entire string is just an abstract word
    for (var j = 0; j < V75_ABSTRACT_WORDS.length; j++) {
      if (b === V75_ABSTRACT_WORDS[j]) return { valid: false, reason: "only_abstract" };
    }

    return { valid: true };
  }

  /**
   * @param {string} result
   * @param {string} action
   * @returns {{ valid: boolean, reason?: string }}
   */
  function validateResultField(result, action) {
    if (!result || typeof result !== "string") return { valid: false, reason: "empty" };
    var r = result.trim();

    if (r.length < 6) return { valid: false, reason: "too_short" };
    if (r.length > 25) return { valid: false, reason: "too_long" };

    // Must not contain blacklisted result words
    for (var i = 0; i < V75_RESULT_BLACKLIST.length; i++) {
      if (r.indexOf(V75_RESULT_BLACKLIST[i]) >= 0) return { valid: false, reason: "blacklisted:" + V75_RESULT_BLACKLIST[i] };
    }

    // Must not be tautology with action
    if (action && diceCharSimilarity(r, action) > 0.6) return { valid: false, reason: "tautology_with_action" };

    return { valid: true };
  }

  /**
   * @param {string} cause
   * @param {string} bottleneck
   * @returns {{ valid: boolean, reason?: string }}
   */
  function validateCauseField(cause, bottleneck) {
    if (!cause || typeof cause !== "string") return { valid: false, reason: "empty" };
    var c = cause.trim();

    if (c.length < 6) return { valid: false, reason: "too_short" };
    if (c.length > 30) return { valid: false, reason: "too_long" };

    // Must not equal bottleneck
    if (bottleneck && diceCharSimilarity(c, bottleneck) > 0.8) return { valid: false, reason: "same_as_bottleneck" };

    return { valid: true };
  }

  // --- Relation-level Validation ---

  /**
   * @param {{ cause: string, bottleneck: string, action: string, result: string }} ir
   * @returns {{ valid: boolean, reasons: string[] }}
   */
  function validateIRRelations(ir) {
    var reasons = [];

    // Critical pairs to check (not all pairs — cause/action CAN share domain vocab)
    var checkPairs = [
      ["cause", "bottleneck", 0.8],     // cause ≠ bottleneck (tight)
      ["action", "result", 0.5],         // action ≠ result (prevent tautology)
      ["bottleneck", "result", 0.6]      // bottleneck ≠ result
    ];
    // cause/action pair is relaxed: they naturally share domain words
    // cause/result pair is less critical

    for (var i = 0; i < checkPairs.length; i++) {
      var f1 = checkPairs[i][0];
      var f2 = checkPairs[i][1];
      var threshold = checkPairs[i][2];
      if (ir[f1] && ir[f2]) {
        var sim = diceCharSimilarity(ir[f1], ir[f2]);
        if (sim > threshold) {
          reasons.push(f1 + "/" + f2 + " too similar (" + Math.round(sim * 100) + "%)");
        }
      }
    }

    return { valid: reasons.length === 0, reasons: reasons };
  }

  // --- Action Abstraction Layer ---

  var V75_ABSTRACTION_MAP_PRIMARY = [
    { re: /HTML|tag|標籤|regex|正則|標記|DOM|script|sanitize|encode/i, text: "清洗文本" },
    { re: /token|長度|截斷|字數|字元數|context\s*window/i, text: "控制輸入長度" },
    { re: /RSS|API|爬蟲|fetch|crawler/i, text: "資料抓取" },
    { re: /retry|timeout|重試|超時/i, text: "請求重試" },
    { re: /過濾|門檻|threshold/i, text: "品質過濾" },
    { re: /分離|解耦|拆分/i, text: "模組分離" },
    { re: /排程|cron|定時/i, text: "排程執行" },
    { re: /快取|cache/i, text: "快取機制" }
  ];

  var V75_ABSTRACTION_MAP_FALLBACK = [
    { re: /HTML|DOM|tag|sanitize|encode/i, text: "清洗文本" },
    { re: /token|長度|限制|截斷/i, text: "控制輸入長度" },
    { re: /API|fetch|request/i, text: "資料抓取" }
  ];

  /**
   * 將具體 action 映射為高層動作
   * @param {string} action
   * @returns {{ text: string, abstraction_level: "high"|"medium"|"low" }}
   */
  function abstractAction(action) {
    var a = String(action || "");

    // Primary mapping
    for (var i = 0; i < V75_ABSTRACTION_MAP_PRIMARY.length; i++) {
      if (V75_ABSTRACTION_MAP_PRIMARY[i].re.test(a)) {
        return { text: V75_ABSTRACTION_MAP_PRIMARY[i].text, abstraction_level: "high" };
      }
    }

    // Fallback mapping
    for (var j = 0; j < V75_ABSTRACTION_MAP_FALLBACK.length; j++) {
      if (V75_ABSTRACTION_MAP_FALLBACK[j].re.test(a)) {
        return { text: V75_ABSTRACTION_MAP_FALLBACK[j].text, abstraction_level: "medium" };
      }
    }

    // No match — keep original
    return { text: a, abstraction_level: "low" };
  }

  /**
   * 合併多個 action 的高層抽象
   * @param {string} primary
   * @param {string[]} secondaries
   * @returns {string}
   */
  function abstractActions(primary, secondaries) {
    var pAbs = abstractAction(primary);
    var abstractions = [pAbs.text];

    for (var i = 0; i < secondaries.length; i++) {
      var sAbs = abstractAction(secondaries[i]);
      // Only add if different from existing abstractions
      var dup = false;
      for (var j = 0; j < abstractions.length; j++) {
        if (abstractions[j] === sAbs.text) { dup = true; break; }
      }
      if (!dup) abstractions.push(sAbs.text);
    }

    return abstractions.join("與");
  }

  // --- Style Normalization Layer ---

  var V75_COLLOQUIAL_REPLACEMENTS = [
    [/讓/g, "使"],
    [/變得/g, "形成"],
    [/很/g, ""],
    [/比較/g, ""],
    [/可以/g, ""],
    [/就會/g, "導致"]
  ];

  var V75_RESULT_FORBIDDEN_REPLACEMENTS = [
    [/變好/, "達到預期狀態"],
    [/變乾淨/, "不含冗餘標記"],
    [/更穩定/, "不因單次失敗中斷"]
  ];

  /**
   * Style normalization: 口語→工程語氣，不改變語義
   * @param {string} text
   * @returns {string}
   */
  function normalizeStyle(text) {
    var t = String(text || "");
    var before = t;

    // Apply colloquial replacements
    for (var i = 0; i < V75_COLLOQUIAL_REPLACEMENTS.length; i++) {
      t = t.replace(V75_COLLOQUIAL_REPLACEMENTS[i][0], V75_COLLOQUIAL_REPLACEMENTS[i][1]);
    }

    // Apply result forbidden replacements
    for (var j = 0; j < V75_RESULT_FORBIDDEN_REPLACEMENTS.length; j++) {
      t = t.replace(V75_RESULT_FORBIDDEN_REPLACEMENTS[j][0], V75_RESULT_FORBIDDEN_REPLACEMENTS[j][1]);
    }

    // Clean up double spaces
    t = t.replace(/\s{2,}/g, " ").trim();

    // Semantic integrity check: if too different, revert
    if (diceCharSimilarity(before, t) < 0.8) {
      return before;
    }

    return t;
  }

  // --- Confidence Scoring ---

  // --- Strong mechanism verbs: presence implies HIGH even without causal markers ---
  var V75_STRONG_MECHANISM_VERBS = /^(?:截斷|限制|過濾|清洗|清除|重試|解析|移除|去除|剝離|替換|轉換|拆分|攔截|排程|快取)/;

  /**
   * Confidence scoring — mechanism strength > syntax markers.
   * @param {object} opts
   * @param {number} opts.extractedCount  Fields extracted (0-4)
   * @param {string} [opts.action]        Final action (extracted or fallback)
   * @param {boolean} [opts.actionExtracted]  Was action extracted from text?
   * @returns {{ level: string, label: string, icon: string }}
   */
  function computeConfidence(opts) {
    // Backward-compat: if called with a number, use legacy behavior
    if (typeof opts === "number") {
      var n = opts;
      if (n >= 4) return { level: "high", label: "高可信", icon: "\u2705" };
      if (n >= 2) return { level: "medium", label: "部分推測", icon: "\u26A0\uFE0F" };
      return { level: "low", label: "低可信", icon: "\u2757" };
    }

    var extractedCount = opts.extractedCount || 0;
    var action = opts.action || "";
    var actionExtracted = !!opts.actionExtracted;

    // Rule 1: Strong mechanism verb in extracted action → HIGH
    // (mechanism strength > syntax markers like 因為/由於)
    if (actionExtracted && V75_STRONG_MECHANISM_VERBS.test(action)) {
      return { level: "high", label: "高可信", icon: "\u2705" };
    }

    // Rule 2: All 4 fields extracted → HIGH
    if (extractedCount >= 4) {
      return { level: "high", label: "高可信", icon: "\u2705" };
    }

    // Rule 3: MEDIUM — action exists but is vague, or cause missing
    // Action extracted but not strong, or 2-3 fields extracted
    if (actionExtracted && extractedCount >= 2) {
      return { level: "medium", label: "部分推測", icon: "\u26A0\uFE0F" };
    }

    // Rule 4: LOW — no clear action, no abstractable mechanism
    return { level: "low", label: "低可信", icon: "\u2757" };
  }

  // --- V7.5 Render Functions ---

  /**
   * V7.5 Summary: 使用抽象後的高層動作
   * @param {{ action: string, secondaryActions: string[], result: string }} ir75
   * @returns {string}
   */
  function renderSummaryV75(ir75) {
    if (!ir75) return "⚠️ 無明確系統機制（未套用 Condense）";
    var abstractedAction = abstractActions(ir75.action, ir75.secondaryActions || []);
    var result = normalizeStyle(ir75.result);
    return normalizeText("系統透過" + abstractedAction + "，" + result);
  }

  /**
   * V7.5 Method: 使用原始具體 actions
   * @param {{ cause: string, bottleneck: string, action: string, secondaryActions: string[], result: string }} ir75
   * @returns {string}
   */
  function renderMethodV75(ir75) {
    if (!ir75) return "";
    var cause = normalizeStyle(ir75.cause);
    var bottleneck = normalizeStyle(ir75.bottleneck);
    var result = normalizeStyle(ir75.result);

    // Strip any leading causal markers from cause (防止 "因由於" 雙重標記)
    cause = cause.replace(/^(?:因為|由於|因)\s*/, "");
    // Strip leading "導致/造成" from bottleneck
    bottleneck = bottleneck.replace(/^(?:導致|造成)\s*/, "");

    // Build action chain
    var actionChain = ir75.action;
    var secs = ir75.secondaryActions || [];
    if (secs.length > 0) {
      actionChain = ir75.action + "並" + secs.join("與");
    }

    return normalizeText("因" + cause + "導致" + bottleneck + "，透過" + actionChain + "實現" + result);
  }

  // --- Semantic Alignment Validation ---

  /**
   * 驗證原文與 summary 之間的語義對齊程度。
   * 以原文中的英文技術詞（4 字母以上）作為 anchor，
   * 確認 summary 至少含有一個相同詞彙。
   *
   * 若原文無英文詞（全中文內容），視為「無法驗證」→ 回傳 true（不阻擋）。
   *
   * @param {string} text       原文
   * @param {string} summary    已產生的 summary 字串
   * @returns {boolean}         true = 對齊（允許輸出）；false = 不對齊（應拒答）
   */
  function hasKeywordOverlap(text, summary) {
    var keywords = (text.match(/[a-zA-Z]{4,}/g) || []);
    // 純中文內容無從比對英文詞，不做攔截
    if (keywords.length === 0) return true;
    var summaryWords = summary.toLowerCase();
    var match = 0;
    for (var i = 0; i < Math.min(keywords.length, 10); i++) {
      if (summaryWords.includes(keywords[i].toLowerCase())) {
        match++;
      }
    }
    return match >= 1;
  }

  // --- Main extract() function ---

  /**
   * V7.5 主萃取函數（MVP: data_transformation）
   * @param {string} text  原文
   * @param {string} type  機制類型（由 classifyMechanismType 決定）
   * @returns {{ type: string, cause: string, bottleneck: string, action: string, secondaryActions: string[], result: string, confidence: { level: string, label: string, icon: string }, summary: string, method: string, _debug?: object }}
   */
  function extractIR(text, type) {
    // Auto-classify when caller did not supply a type
    if (!type) type = classifyMechanismType(text);

    // UNKNOWN guard: refuse to output rather than produce template garbage
    if (type === "unknown") return null;

    // Currently only data_transformation is fully supported; others use ontology fallback
    if (type !== "data_transformation") {
      return _fallbackExtractResult(type);
    }

    var sentences = segmentText(text);
    var extractedCount = 0;
    var fallbackIR = irFromOntologyType(type);
    var debug = { sentences: sentences, candidates: {} };

    // --- Candidate Generation ---
    var actionCands = generateCandidates(sentences, DT_ACTION_PATTERNS);
    var causeCands = generateCandidates(sentences, DT_CAUSE_PATTERNS);
    var bottleneckCands = generateCandidates(sentences, DT_BOTTLENECK_PATTERNS);
    var resultCands = generateCandidates(sentences, DT_RESULT_PATTERNS);

    debug.candidates = {
      action: actionCands.map(function(c) { return c.text; }),
      cause: causeCands.map(function(c) { return c.text; }),
      bottleneck: bottleneckCands.map(function(c) { return c.text; }),
      result: resultCands.map(function(c) { return c.text; })
    };

    // --- Ranking ---
    var actionRank = rankCandidates(actionCands, "action");
    var causeRank = rankCandidates(causeCands, "cause");
    var bottleneckRank = rankCandidates(bottleneckCands, "bottleneck");
    var resultRank = rankCandidates(resultCands, "result");

    // --- Field extraction with validation + partial fallback ---
    var action = actionRank.primary;
    var secondaryActions = actionRank.secondary;
    var cause = causeRank.primary;
    var bottleneck = bottleneckRank.primary;
    var result = resultRank.primary;

    // --- Clean extracted fields: strip leading causal markers ---
    if (cause) cause = cause.replace(/^(?:因為|由於|因)\s*/, "").trim();
    if (bottleneck) bottleneck = bottleneck.replace(/^(?:導致|造成|影響)\s*/, "").trim();
    if (result) result = result.replace(/^(?:使得|使|讓)\s*/, "").trim();

    // --- Smart truncation: cut at natural boundary ---
    if (action && action.length > 20) {
      var cutAction = action.substring(0, 20);
      var lastBreak = Math.max(cutAction.lastIndexOf("與"), cutAction.lastIndexOf("並"), cutAction.lastIndexOf("和"));
      if (lastBreak > 8) cutAction = cutAction.substring(0, lastBreak);
      action = cutAction.trim();
    }
    if (cause && cause.length > 30) cause = cause.substring(0, 30).trim();
    if (bottleneck && bottleneck.length > 25) bottleneck = bottleneck.substring(0, 25).trim();
    if (result && result.length > 25) result = result.substring(0, 25).trim();

    // Validate each field; fallback individually
    var actionExtracted = false;
    var actionValid = validateActionField(action);
    if (actionValid.valid) {
      extractedCount++;
      actionExtracted = true;
    } else {
      action = fallbackIR.action;
      secondaryActions = [];
      debug.actionFallbackReason = actionValid.reason;
    }

    var causeValid = validateCauseField(cause, bottleneck);
    if (causeValid.valid) {
      extractedCount++;
    } else {
      cause = fallbackIR.cause;
      debug.causeFallbackReason = causeValid.reason;
    }

    var bottleneckValid = validateBottleneckField(bottleneck, cause);
    if (bottleneckValid.valid) {
      extractedCount++;
    } else {
      bottleneck = fallbackIR.bottleneck;
      debug.bottleneckFallbackReason = bottleneckValid.reason;
    }

    var resultValid = validateResultField(result, action);
    if (resultValid.valid) {
      extractedCount++;
    } else {
      result = fallbackIR.result;
      debug.resultFallbackReason = resultValid.reason;
    }

    // --- Relation-level Validation (partial fallback) ---
    var irObj = { cause: cause, bottleneck: bottleneck, action: action, result: result };
    var relValid = validateIRRelations(irObj);
    if (!relValid.valid) {
      debug.relationIssues = relValid.reasons;
      // Partial fallback: replace offending fields with template
      for (var ri = 0; ri < relValid.reasons.length; ri++) {
        var reason = relValid.reasons[ri];
        // Parse which pair is too similar
        var pairMatch = reason.match(/^(\w+)\/(\w+) too similar/);
        if (pairMatch) {
          // Fallback the second field in the pair (less important)
          var field2 = pairMatch[2];
          if (field2 === "action") { action = fallbackIR.action; secondaryActions = []; }
          else if (field2 === "result") { result = fallbackIR.result; }
          else if (field2 === "bottleneck") { bottleneck = fallbackIR.bottleneck; }
          else if (field2 === "cause") { cause = fallbackIR.cause; }
          // Decrease extracted count
          if (extractedCount > 0) extractedCount--;
        }
      }
    }

    // --- Build V7.5 IR ---
    var ir75 = {
      type: type,
      cause: cause,
      bottleneck: bottleneck,
      action: action,
      secondaryActions: secondaryActions,
      result: result
    };

    // --- Render ---
    var summary = ensureFullSentence(renderSummaryV75(ir75));
    var method = ensureFullSentence(renderMethodV75(ir75));

    // --- Style Normalization ---
    summary = normalizeStyle(summary);
    method = normalizeStyle(method);

    // --- Output-level Validation: Dice < 0.45 ---
    var outSim = diceCharSimilarity(summary, method);
    if (outSim >= 0.45) {
      debug.outputSimilarity = outSim;
      // If too similar, try to differentiate by adding bottleneck detail to method
      // but don't fallback entirely
    }

    // --- Strip forbidden data (reuse existing) ---
    summary = stripRawDataForPublication(summary);
    method = stripRawDataForPublication(method);

    // --- Final sentence form enforcement ---
    if (!/^系統透過/.test(summary)) {
      summary = "系統透過" + abstractActions(action, secondaryActions) + "，" + result + "。";
    }
    if (!/^因/.test(method)) {
      var actionChain = action;
      if (secondaryActions.length > 0) actionChain = action + "並" + secondaryActions.join("與");
      method = "因" + cause + "導致" + bottleneck + "，透過" + actionChain + "實現" + result + "。";
    }

    // Ensure period
    summary = ensureFullSentence(summary);
    method = ensureFullSentence(method);

    var confidence = computeConfidence({
      extractedCount: extractedCount,
      action: action,
      actionExtracted: actionExtracted
    });

    return {
      type: type,
      cause: cause,
      bottleneck: bottleneck,
      action: action,
      secondaryActions: secondaryActions,
      result: result,
      confidence: confidence,
      summary: summary,
      method: method,
      _debug: debug
    };
  }

  /**
   * Full fallback: 回退到 ontology 模板
   * @param {string} type
   * @param {object} [debug]
   */
  function _fallbackExtractResult(type, debug) {
    var ir = irFromOntologyType(type || "general");
    var summary = ensureFullSentence(renderSummary(ir));
    var method = ensureFullSentence(renderMethod(ir));
    summary = stripRawDataForPublication(summary);
    method = stripRawDataForPublication(method);
    return {
      type: type || "general",
      cause: ir.cause,
      bottleneck: ir.bottleneck,
      action: ir.action,
      secondaryActions: [],
      result: ir.result,
      confidence: computeConfidence(0),
      summary: summary,
      method: method,
      _debug: debug || { fallback: true }
    };
  }

  // =========================================================================
  // End V7.5
  // =========================================================================

  // =========================================================================
  // V8 — Stable Condense Engine (Quality-First)
  // =========================================================================
  // 僅支援 task_flow / technical_mechanism 兩類。
  // 無法確定 → silent fail（return null），絕不輸出模板垃圾。
  // Pipeline: classifyV8 → extract*IR → buildSummary/buildMethod
  //           → validateOutput → Quality Gate → fallbackSummary → null
  // =========================================================================

  // --- V8 Classification Signals ---

  /**
   * V8 分類器：只輸出 technical_mechanism / task_flow / unknown。
   * 評分制：每類計算信號出現次數，technical_mechanism 優先。
   * @param {string} text
   * @returns {"technical_mechanism"|"task_flow"|"unknown"}
   */
  function classifyV8(text) {
    var t = String(text || "").trim();
    if (!t) return "unknown";

    // Strong mechanism verb + causal marker → unambiguous technical_mechanism
    var strongMech   = /截斷|限制|過濾|清洗|移除|重試|解析|攔截|快取|排程|壓縮/.test(t);
    var causalMarker = /因為|由於|導致|透過|因此/.test(t);
    if (strongMech && causalMarker) return "technical_mechanism";

    // Count signal density for each type
    // techSignals: words that imply a causal/mechanism chain (exclude 系統 — too common)
    var techSignals = t.match(/因為|由於|導致|透過|機制|模組|架構|pipeline|處理器|轉換|驗證|資料庫|爬蟲/gi);
    var flowSignals = t.match(/首先|然後|接著|第一步|第二步|依序|步驟|流程|設置|初始化|安裝|完成後/g);

    var techScore = techSignals ? techSignals.length : 0;
    var flowScore = flowSignals ? flowSignals.length : 0;

    // Require minimum 2 signals to avoid false positives
    if (techScore >= 2) return "technical_mechanism";
    if (flowScore >= 2) return "task_flow";

    // Single strong mechanism verb alone is enough
    if (strongMech) return "technical_mechanism";

    return "unknown";
  }

  // --- V8 Pattern Sets ---

  var V8_TECH_CAUSE_PATTERNS = [
    /(?:因為|由於|因)\s*[^，,。；\n]{4,25}/,
    /[^，,。；\n]{3,15}\s*(?:包含|帶有|混入|含有)\s*[^，,。；\n]{2,12}/,
    /(?:當|若)\s*[^，,。；\n]{4,20}\s*(?:時|，)/,
    /[^，,。；\n]{4,18}\s*(?:出現問題|發生錯誤|頻繁報錯|失敗)/
  ];

  var V8_TECH_MECHANISM_PATTERNS = [
    /透過\s*[^，,。；\n]{3,20}/,
    /(?:截斷|限制|過濾|清洗|移除|重試|解析|攔截|快取|排程|壓縮|轉換|拆分)\s*[^，,。；\n]{0,18}/,
    /系統\s*(?:會|透過)?\s*[^，,。；\n]{3,18}/,
    /(?:以|使用|採用)\s*[^，,。；\n]{3,18}/
  ];

  var V8_TECH_EFFECT_PATTERNS = [
    /(?:使得|使|讓)\s*[^，,。；\n]{4,20}/,
    /(?:達成|實現|確保)\s*[^，,。；\n]{4,18}/,
    /[^，,。；\n]{4,18}\s*(?:正常運作|穩定運行|保持一致|可正常解析)/
  ];

  var V8_FLOW_GOAL_PATTERNS = [
    /(?:目標是|目的是|為了)\s*[^，,。；\n]{4,20}/,
    // Match the subject BEFORE 需要 (lookahead keeps 需要 out of the match)
    /[^，,。；\n]{3,15}(?=\s*需要(?:先|依序|完成)?)/,
    /[^，,。；\n]{3,15}的?(?:設置流程|建立步驟|初始化流程)/
  ];

  var V8_FLOW_STEPS_PATTERNS = [
    /(?:首先|先)\s*[^，,。；\n]{3,18}/,
    /(?:建立|設置|初始化|安裝|啟動|配置)\s*[^，,。；\n]{2,15}/,
    /(?:然後|接著)\s*[^，,。；\n]{3,18}/
  ];

  var V8_FLOW_OUTCOME_PATTERNS = [
    /(?:完成後|之後)\s*[^，,。；\n]{4,18}/,
    /(?:最後|最終|結果是?)\s*[^，,。；\n]{4,18}/,
    /[^，,。；\n]{3,15}\s*(?:就緒|完成|可用|運行)/
  ];

  // --- V8 IR Extractors ---

  /**
   * 萃取 technical_mechanism IR：cause → mechanism → effect。
   * mechanism 為必填；缺失 → return null。
   * @param {string} text
   * @returns {{ cause: string, mechanism: string, effect: string, _extracted: number }|null}
   */
  function extractTechnicalIR(text) {
    var sentences = segmentText(text);

    var causeCands     = generateCandidates(sentences, V8_TECH_CAUSE_PATTERNS);
    var mechCands      = generateCandidates(sentences, V8_TECH_MECHANISM_PATTERNS);
    var effectCands    = generateCandidates(sentences, V8_TECH_EFFECT_PATTERNS);

    var causeRanked    = rankCandidates(causeCands,  "cause");
    var mechRanked     = rankCandidates(mechCands,   "action");
    var effectRanked   = rankCandidates(effectCands, "result");

    var cause     = causeRanked.primary  || "";
    var mechanism = mechRanked.primary   || "";
    var effect    = effectRanked.primary || "";

    // Strip leading grammatical markers
    cause     = cause.replace(/^(?:因為|由於|因)\s*/,            "").trim();
    mechanism = mechanism.replace(/^(?:透過|以|使用|採用|系統)\s*/, "").trim();
    effect    = effect.replace(/^(?:使得|使|讓|達成|實現|確保)\s*/,  "").trim();

    // Truncate to slot width
    if (cause.length     > 25) cause     = cause.substring(0, 25).trim();
    if (mechanism.length > 20) mechanism = mechanism.substring(0, 20).trim();
    if (effect.length    > 20) effect    = effect.substring(0, 20).trim();

    // mechanism is mandatory
    if (!mechanism || mechanism.length < 3) return null;

    var extracted = (cause.length >= 4 ? 1 : 0)
                  + (mechanism.length >= 3 ? 1 : 0)
                  + (effect.length >= 4 ? 1 : 0);

    return { cause: cause, mechanism: mechanism, effect: effect, _extracted: extracted };
  }

  /**
   * 萃取 task_flow IR：goal → steps → outcome。
   * steps 為必填；缺失 → return null。
   * @param {string} text
   * @returns {{ goal: string, steps: string, outcome: string, _extracted: number }|null}
   */
  function extractTaskFlowIR(text) {
    var sentences = segmentText(text);

    var goalCands    = generateCandidates(sentences, V8_FLOW_GOAL_PATTERNS);
    var stepsCands   = generateCandidates(sentences, V8_FLOW_STEPS_PATTERNS);
    var outcomeCands = generateCandidates(sentences, V8_FLOW_OUTCOME_PATTERNS);

    var goalRanked    = rankCandidates(goalCands,    "cause");
    var stepsRanked   = rankCandidates(stepsCands,   "action");
    var outcomeRanked = rankCandidates(outcomeCands, "result");

    var goal    = goalRanked.primary    || "";
    var steps   = stepsRanked.primary   || "";
    var outcome = outcomeRanked.primary || "";

    // Strip leading markers
    goal    = goal.replace(/^(?:目標是|目的是|為了|需要|必須)\s*/,            "").trim();
    steps   = steps.replace(/^(?:首先|先|然後|接著|建立|設置|初始化|安裝|啟動|配置)\s*/, "").trim();
    outcome = outcome.replace(/^(?:完成後|最後|最終|結果是?)\s*/,             "").trim();

    // Truncate to slot width
    if (goal.length    > 20) goal    = goal.substring(0, 20).trim();
    if (steps.length   > 18) steps   = steps.substring(0, 18).trim();
    if (outcome.length > 20) outcome = outcome.substring(0, 20).trim();

    // steps is mandatory
    if (!steps || steps.length < 3) return null;

    var extracted = (goal.length >= 4 ? 1 : 0)
                  + (steps.length >= 3 ? 1 : 0)
                  + (outcome.length >= 4 ? 1 : 0);

    return { goal: goal, steps: steps, outcome: outcome, _extracted: extracted };
  }

  // --- V8 Sentence Builders ---

  /**
   * V8 Summary 建構器。
   * technical_mechanism → 「系統透過[mechanism]，達成[effect]。」
   * task_flow           → 「透過[steps]，完成[outcome]。」
   * @param {object} ir
   * @param {"technical_mechanism"|"task_flow"} type
   * @returns {string}
   */
  function buildSummary(ir, type) {
    if (!ir) return "";

    if (type === "technical_mechanism") {
      var mech   = abstractAction(ir.mechanism).text;
      var effect = ir.effect || "系統穩定運作";
      return normalizeText("系統透過" + mech + "，達成" + effect);
    }

    if (type === "task_flow") {
      var steps = ir.steps;
      var dest  = ir.outcome || ir.goal || "預期目標";
      return normalizeText("透過" + steps + "，完成" + dest);
    }

    return "";
  }

  /**
   * V8 Method 建構器。
   * technical_mechanism → 「因[cause]，系統以[mechanism]達成[effect]。」
   *                        （cause 缺失時省略因字句）
   * task_flow           → 「[goal]需要依序[steps]，達成[outcome]。」
   *                        （goal 缺失時省略主語）
   * @param {object} ir
   * @param {"technical_mechanism"|"task_flow"} type
   * @returns {string}
   */
  function buildMethod(ir, type) {
    if (!ir) return "";

    if (type === "technical_mechanism") {
      var cause  = ir.cause;
      var mech   = ir.mechanism;
      var effect = ir.effect || "";
      if (cause) {
        return normalizeText("因" + cause + "，系統以" + mech + (effect ? "達成" + effect : "運作"));
      }
      return normalizeText("系統以" + mech + (effect ? "達成" + effect : "運作"));
    }

    if (type === "task_flow") {
      var goal    = ir.goal;
      var steps   = ir.steps;
      var outcome = ir.outcome || "";
      // Dedup: if goal is too similar to steps (same content extracted twice), omit goal
      var goalIsRedundant = goal && diceCharSimilarity(goal, steps) > 0.55;
      if (goal && !goalIsRedundant) {
        return normalizeText(goal + "，需要依序" + steps + (outcome ? "，達成" + outcome : ""));
      }
      return normalizeText("依序" + steps + (outcome ? "，達成" + outcome : ""));
    }

    return "";
  }

  // --- V8 Fallback (High-Density Single Sentence) ---

  /**
   * V8 fallback：從原文選最高資訊密度的單句，不生成任何模板語句。
   * @param {string} text
   * @returns {{ summary: string, method: string }|null}
   */
  function fallbackSummary(text) {
    var sentences = segmentText(text);

    // Filter: length, no questions, no CTAs, no instructions
    var candidates = sentences.filter(function(s) {
      if (s.length < 20 || s.length > 80) return false;
      if (/嗎$|\?$/.test(s))             return false;  // question
      if (/^請|^第[一二三]步/.test(s))   return false;  // instruction
      if (/^我可以|^您認為|^你認為/.test(s)) return false;  // CTA
      return true;
    });

    if (!candidates.length) return null;

    var best = null;
    var bestScore = -1;

    for (var i = 0; i < candidates.length; i++) {
      var s = candidates[i];
      var score = 0;

      // Mechanism words → higher density
      var mechHits = s.match(/因|透過|系統|導致|達成|實現|確保|機制|架構|模組/g);
      score += mechHits ? mechHits.length * 2 : 0;

      // Good length window
      if (s.length >= 25 && s.length <= 60) score += 1;

      // Concrete technical objects
      var concreteHits = s.match(/HTML|CSS|API|JSON|token|URL|git|npm|資料|模型|系統/gi);
      score += concreteHits ? concreteHits.length : 0;

      if (score > bestScore) { bestScore = score; best = s; }
    }

    // Require at least one mechanism word to qualify
    if (!best || bestScore < 2) return null;

    return { summary: best, method: "" };
  }

  // --- V8 Quality Gate ---

  /**
   * V8 Quality Gate：驗證輸出是否達到最低品質標準。
   * false → silent fail，絕不展示給使用者。
   *
   * @param {string} summary
   * @param {string} method
   * @param {"technical_mechanism"|"task_flow"|string} [type]
   *   task_flow 允許較高 summary/method 相似度（共享動作詞彙為正常現象）。
   * @returns {boolean}
   */
  function validateOutputV8(summary, method, type) {
    if (!summary || typeof summary !== "string") return false;

    var s = summary.trim();

    // Minimum length
    if (s.length < 15) return false;

    // No numeric metrics
    if (/\d+\s*(?:ms|bytes|KB|MB|GB|px|rem|em)/.test(s)) return false;

    // No instruction fragments
    if (/^(?:第|步驟|Step)\s*\d/.test(s)) return false;

    // No hardcoded template garbage from V7.5 fallback
    var FORBIDDEN = [
      "資料清洗與長度控制",
      "確保輸入內容純淨且可控",
      "原始資料包含雜訊與冗餘",
      "提升穩定性",
      "優化處理",
      "改善效能"
    ];
    for (var i = 0; i < FORBIDDEN.length; i++) {
      if (s.indexOf(FORBIDDEN[i]) >= 0) return false;
    }

    // summary ≠ method (prevent copy-paste duplication)
    // task_flow naturally shares action vocabulary → relax to 0.85
    // technical_mechanism must stay distinct → strict 0.5
    if (method && method.trim().length > 0) {
      var simThreshold = (type === "task_flow") ? 0.85 : 0.5;
      if (diceCharSimilarity(s, method.trim()) >= simThreshold) return false;
    }

    return true;
  }

  // --- V8 Main Entry ---

  /**
   * V8 主入口：完整 pipeline，品質不足 → silent fail（return null）。
   * 取代 V7.5 的 extractIR + renderSummaryV75 + renderMethodV75。
   *
   * @param {string} text  Gemini 訊息原文
   * @returns {{ summary: string, method: string, type: string, confidence: object }|null}
   */
  function runCondense(text) {
    var t = String(text || "").trim();
    if (!t || t.length < 30) return null;

    // 1. Classify
    var type = classifyV8(t);
    if (type === "unknown") return null;

    // 2. Extract IR
    var ir = null;
    if (type === "technical_mechanism") {
      ir = extractTechnicalIR(t);
    } else {
      ir = extractTaskFlowIR(t);
    }

    // 3. Build sentences
    var summary = "";
    var method  = "";

    if (ir) {
      summary = ensureFullSentence(normalizeStyle(buildSummary(ir, type)));
      method  = ensureFullSentence(normalizeStyle(buildMethod(ir, type)));
      summary = stripRawDataForPublication(summary);
      method  = stripRawDataForPublication(method);
    }

    // 4. Quality Gate (pass type so similarity threshold is calibrated per type)
    if (validateOutputV8(summary, method, type)) {
      var confidence = computeConfidence({
        extractedCount: ir ? ir._extracted : 0,
        action:          ir ? (ir.mechanism || ir.steps || "") : "",
        actionExtracted: !!ir
      });
      return { summary: summary, method: method, type: type, confidence: confidence };
    }

    // 5. Fallback: single high-density sentence
    var fb = fallbackSummary(t);
    if (fb && validateOutputV8(fb.summary, "")) {
      return {
        summary:    fb.summary,
        method:     "",
        type:       type,
        confidence: { level: "low", label: "低可信", icon: "\u2757" }
      };
    }

    // 6. Silent fail
    return null;
  }

  /**
   * Condense Engine V1 (Usability-first)
   * - No NLP / embeddings / deep parsing
   * - Returns only { summary, method } (UI renders labels)
   * @param {string} text
   * @returns {{summary: string, method: string}|null}
   */
  function runCondenseV1(text) {
    var raw = String(text || "");
    if (!raw) return null;

    // Step 1: split lines, drop very short noise lines
    var lines = raw.split("\n").map(function (l) { return String(l || "").trim(); });
    lines = lines.filter(function (l) { return l && l.length >= 20; });
    if (!lines.length) return null;

    // Rebuild to keep paragraph breaks for Step 2
    var rebuilt = lines.join("\n");
    var paragraphs = rebuilt
      .split(/\n{2,}/)
      .map(function (p) { return String(p || "").trim(); })
      .filter(Boolean);
    if (!paragraphs.length) return null;

    // Step 2: select first 2–3 paragraphs
    var picked = paragraphs.slice(0, 3);
    var pickedText = picked.join("\n\n").trim();
    if (!pickedText) return null;

    // Step 3: build one-line summary (~120 chars)
    var first = picked[0] || "";
    var firstLine = first.split("\n").map(function (l) { return l.trim(); }).filter(Boolean)[0] || "";
    var summary = firstLine || pickedText.replace(/\s+/g, " ");
    summary = summary.replace(/\s+/g, " ").trim();
    if (summary.length > 120) summary = summary.slice(0, 120).trim();

    // Method: 2–4 lines from the remaining picked text (excluding the chosen summary line when possible)
    var restText = pickedText;
    if (firstLine && restText.indexOf(firstLine) === 0) {
      restText = restText.slice(firstLine.length).trim();
    }
    var methodLines = restText
      .split("\n")
      .map(function (l) { return l.trim(); })
      .filter(Boolean);
    var method = methodLines.slice(0, 4).join("\n").trim();
    if (method.length > 200) method = method.slice(0, 200).trim();

    if (!summary) return null;
    return { summary: summary, method: method };
  }

  // =========================================================================
  // End V8
  // =========================================================================

  window.GRACondenseEngine = {
    normalizeText,
    classifyMechanismType,
    inferMechanismTypeFromClassified,
    irFromOntologyType,
    ensureDataTransformationNoPipelineLeak,
    renderTransformationMethodWithDifferentiation,
    configurationOntologyMechanismRule,
    extractMechanism,
    extractMechanismWithMeta,
    validateOutput,
    validate,
    validateCondenseIR,
    fallbackMechanism,
    stripRawDataForPublication,
    publicationHasForbiddenRawData,
    cleanSentenceForPublication,
    passesSummarySystemBehavior,
    passesSummaryPublicationQuality,
    splitSentences,
    splitIntoSemanticUnits,
    classifySentence,
    scoreSentence,
    pickDocumentSummary,
    pickBestCauseSentence,
    isVerificationEvidence,
    compressSentences,
    compressSingleSentence,
    compressSentence,
    renderMethodFromJoinedSentences,
    buildIR,
    condense,
    condenseViaIRPipeline,
    renderSummary,
    renderMethod,
    finalizeSummaryText,
    finalizeSummaryTextWithQuality,
    rewriteSummaryToDecision,
    passesSummaryHardQuality,
    buildCompressedCommercialBody,
    enforceMaxOutputRatio,
    safeTrimOutput,
    splitOutputBlocks,
    joinOutputBlocks,
    removeInstructionFragments,
    stripInstructionLeaksFromCondenseOutput,
    fallbackMethod,
    fillMethodFromGeneral,
    scoreInformationDensity,
    buildMethodBlock,
    dedupeBlocks,
    hardGuardFinalOutput,
    condenseText,
    // V7.5 exports
    segmentText,
    extractIR,
    abstractAction,
    abstractActions,
    normalizeStyle,
    computeConfidence,
    renderSummaryV75,
    renderMethodV75,
    hasKeywordOverlap,
    validateActionField,
    validateBottleneckField,
    validateResultField,
    validateCauseField,
    validateIRRelations,
    scoreCandidateSpecificity,
    rankCandidates,
    generateCandidates,
    // V8 exports
    classifyV8,
    extractTechnicalIR,
    extractTaskFlowIR,
    buildSummary,
    buildMethod,
    fallbackSummary,
    validateOutputV8,
    runCondense,
    runCondenseV1
  };
})();
