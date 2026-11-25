(() => {
  "use strict";

  // =========================================================================
  // 1. 状態管理（すべてRAM上の変数のみ。Web Storage / Cookie は一切不使用）
  // =========================================================================
  const appState = {
    tokenizer: null,
    dictReady: false,
    autoSegments: [],      // [{ text: string, masked: boolean, source: "plain"|"auto" }]
    renderedSegments: [],  // 自動＋手動ルール適用後の最終セグメント配列
    usedPersonLetters: new Set(),
    manualRules: [],       // [{ id, target, replacement, isPerson, assignedLetter }]
    selectedText: "",
    countdownTimerId: null,
    countdownSeconds: 30,
    ruleSeq: 1
  };

  // =========================================================================
  // 2. DOM要素の参照
  // =========================================================================
  const els = {
    networkStatusBar: document.getElementById("networkStatusBar"),
    networkStatusText: document.getElementById("networkStatusText"),
    offlineReadyNote: document.getElementById("offlineReadyNote"),
    dictStatus: document.getElementById("dictStatus"),
    wipeBanner: document.getElementById("wipeBanner"),

    inputText: document.getElementById("inputText"),
    sampleBtn: document.getElementById("sampleBtn"),
    clearInputBtn: document.getElementById("clearInputBtn"),
    excludeWords: document.getElementById("excludeWords"),
    convertBtn: document.getElementById("convertBtn"),
    wipeBtn: document.getElementById("wipeBtn"),

    manualRulesSection: document.getElementById("manualRulesSection"),
    manualRulesList: document.getElementById("manualRulesList"),
    outputDisplay: document.getElementById("outputDisplay"),
    copyBtn: document.getElementById("copyBtn"),
    copyFeedback: document.getElementById("copyFeedback"),

    countdownBanner: document.getElementById("countdownBanner"),
    countdownText: document.getElementById("countdownText"),
    extendTimerBtn: document.getElementById("extendTimerBtn"),
    cancelTimerBtn: document.getElementById("cancelTimerBtn"),
    wipeNowFromTimerBtn: document.getElementById("wipeNowFromTimerBtn"),

    floatingMenu: document.getElementById("floatingMenu"),
    floatingTargetPreview: document.getElementById("floatingTargetPreview"),
    closeFloatingBtn: document.getElementById("closeFloatingBtn"),
    btnReplacePerson: document.getElementById("btnReplacePerson"),
    btnToggleCustom: document.getElementById("btnToggleCustom"),
    floatingCustomRow: document.getElementById("floatingCustomRow"),
    floatingCustomInput: document.getElementById("floatingCustomInput"),
    btnApplyCustom: document.getElementById("btnApplyCustom")
  };

  // 敬称の直前に来ても人名として誤爆しやすい一般語
  const HONORIFIC_STOPWORDS = new Set([
    "お母", "お父", "お兄", "お姉", "おじい", "おばあ", "奥", "旦那", "ご主",
    "みな", "皆", "お客", "利用", "当事", "相談", "担当", "職員", "先生",
    "医師", "お医者", "看護", "ヘルパー", "ケアマネ", "代表", "会長", "役員",
    "業者", "警察", "役所", "市役所", "区役所", "隣", "近所", "大家", "管理人",
    "本人", "家族", "親族", "友人", "知人", "相手", "先方", "運転手", "ドライバー"
  ]);

  const HONORIFIC_SET = new Set(["さん", "様", "氏", "くん", "ちゃん", "君", "殿"]);

  // =========================================================================
  // 3. Service Worker 登録 ＆ リアルタイム通信状態監視（機内モード検知）
  // =========================================================================
  function updateNetworkStatus() {
    const isOnline = navigator.onLine;
    if (isOnline) {
      els.networkStatusBar.classList.remove("is-offline");
      els.networkStatusBar.classList.add("is-online");
      els.networkStatusText.textContent =
        "🛡️ ブラウザ内完結モード（外部サーバーへのデータ送信機能なし）";
    } else {
      els.networkStatusBar.classList.remove("is-online");
      els.networkStatusBar.classList.add("is-offline");
      els.networkStatusText.textContent =
        "✈️ 完全オフライン検知：現在ネット遮断中（物理的に外部送信不可能です）";
    }
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      els.offlineReadyNote.textContent = "このブラウザはService Worker非対応です（ページ表示中のオフライン動作は可能です）";
      return;
    }

    navigator.serviceWorker
      .register("./sw.js")
      .then((registration) => {
        if (registration.active && navigator.serviceWorker.controller) {
          els.offlineReadyNote.textContent =
            "オフライン起動準備完了：機内モードで再読み込みしても動作します";
        } else {
          els.offlineReadyNote.textContent =
            "オフライン用ファイルを端末キャッシュへ準備中（次回から機内モード起動が可能になります）";
        }

        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "activated") {
              els.offlineReadyNote.textContent =
                "オフライン起動準備完了：機内モードで再読み込みしても動作します";
            }
          });
        });
      })
      .catch(() => {
        els.offlineReadyNote.textContent =
          "※HTTPS（GitHub Pages等）で開くとオフライン再読み込みキャッシュが有効になります";
      });
  }

  // =========================================================================
  // 4. kuromoji.js 辞書読み込み
  // =========================================================================
  function initKuromoji() {
    if (typeof window.kuromoji === "undefined") {
      els.dictStatus.textContent = "⚠️ dict/kuromoji.js が見つかりません（正規表現のみで動作可能）";
      els.dictStatus.classList.add("is-error");
      els.convertBtn.disabled = false;
      return;
    }

    window.kuromoji.builder({ dicPath: "./dict/" }).build((err, tokenizer) => {
      if (err) {
        els.dictStatus.textContent = "⚠️ 日本語辞書の読み込みに失敗しました（dict/ 内のファイルを確認してください）";
        els.dictStatus.classList.add("is-error");
        els.convertBtn.disabled = false;
        return;
      }

      appState.tokenizer = tokenizer;
      appState.dictReady = true;
      els.dictStatus.textContent = "✅ 日本語人名辞書 読み込み完了（完全ローカル処理）";
      els.dictStatus.classList.add("is-ready");
      els.convertBtn.disabled = false;
    });
  }

  // =========================================================================
  // 5. アルファベット採番ユーティリティ（A, B, ..., Z, AA, AB...）
  // =========================================================================
  function indexToAlpha(index) {
    let result = "";
    let n = index;
    while (n >= 0) {
      result = String.fromCharCode((n % 26) + 65) + result;
      n = Math.floor(n / 26) - 1;
    }
    return result;
  }

  function getNextAvailableLetter() {
    const used = new Set(appState.usedPersonLetters);
    for (const rule of appState.manualRules) {
      if (rule.isPerson && rule.assignedLetter) {
        used.add(rule.assignedLetter);
      }
    }
    let idx = 0;
    while (used.has(indexToAlpha(idx))) {
      idx += 1;
    }
    return indexToAlpha(idx);
  }

  function parseExcludeWords() {
    const raw = els.excludeWords.value || "";
    const list = raw
      .split(/[\s、,，・/／]+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 0);
    return new Set(list);
  }

  // =========================================================================
  // 6. 個人情報自動置換エンジン（電話番号 → 住所 → 人名）
  // =========================================================================

  // 電話番号パターン（半角・全角、ハイフン有無、括弧付き市外局番対応）
  const PHONE_REGEX =
    /(?:(?<![0-9０-９])(?:0|０)(?:[5789５７８９][0０]|120|１２０|800|８００|570|５７０)[-ー−‐‑–—]?[0-9０-９]{3,4}[-ー−‐‑–—]?[0-9０-９]{3,4}(?![0-9０-９]))|(?:(?<![0-9０-９])(?:0|０)[0-9０-９]{1,4}[-ー−‐‑–—(（][0-9０-９]{1,4}[-ー−‐‑–—)）][0-9０-９]{3,4}(?![0-9０-９]))|(?:(?<![0-9０-９])(?:0|０)[0-9０-９]{9,10}(?![0-9０-９]))/g;

  // 住所パターン（都道府県あり / 都道府県省略の市区町村＋番地）
  const PREFECTURES =
    "(?:北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)";

  const ADDRESS_BODY =
    "[一-龥々ぁ-んァ-ヶー]{1,12}(?:市|区|郡|町|村)(?:[一-龥々ぁ-んァ-ヶー]{1,10}(?:区|町|村))?[一-龥々ぁ-んァ-ヶー]{0,14}(?:[0-9０-９一二三四五六七八九十]+(?:丁目|番地?|号|[-ー−‐][0-9０-９]+)+)(?:[  ]*[一-龥々ぁ-んァ-ヶA-Za-z0-9０-９ー]{1,16}(?:ハイツ|マンション|アパート|コーポ|メゾン|ビル|荘|団地|レジデンス|パレス|テラス|ハウス|棟)[0-9０-９A-Za-z-ー]*号?室?)?";

  const ADDRESS_PREF_SHORT =
    PREFECTURES +
    "[一-龥々ぁ-んァ-ヶー]{1,12}(?:市|区|郡|町|村)(?:[一-龥々ぁ-んァ-ヶー]{1,10}(?:区|町|村))?[一-龥々ぁ-んァ-ヶー]{0,14}(?:[0-9０-９一二三四五六七八九十]+(?:丁目|番地?|号|[-ー−‐][0-9０-９]+)*)?";

  const ADDRESS_REGEX = new RegExp(
    `(?:〒[0-9０-９]{3}[-ー−‐]?[0-9０-９]{4}[  ]*)?(?:${PREFECTURES}${ADDRESS_BODY}|${ADDRESS_BODY}|${ADDRESS_PREF_SHORT})`,
    "g"
  );

  // プレーンセグメントに対して正規表現置換を行い、新しいセグメント配列を返す
  function applyRegexToSegments(segments, regex, replacement, excludeSet) {
    const next = [];
    for (const seg of segments) {
      if (seg.masked) {
        next.push(seg);
        continue;
      }

      const text = seg.text;
      regex.lastIndex = 0;
      let lastIdx = 0;
      let match;

      while ((match = regex.exec(text)) !== null) {
        const matchedStr = match[0];
        if (!matchedStr) {
          regex.lastIndex += 1;
          continue;
        }

        // 除外ワードに完全一致する場合はスキップ
        if (excludeSet.has(matchedStr.trim())) {
          continue;
        }

        if (match.index > lastIdx) {
          next.push({
            text: text.slice(lastIdx, match.index),
            masked: false,
            source: "plain"
          });
        }

        next.push({
          text: replacement,
          masked: true,
          source: "auto"
        });

        lastIdx = match.index + matchedStr.length;
      }

      if (lastIdx < text.length) {
        next.push({
          text: text.slice(lastIdx),
          masked: false,
          source: "plain"
        });
      }
    }
    return next;
  }

  // kuromoji.js を用いた人名検出・同一人物のアルファベット統一
  function applyPersonMasking(segments, excludeSet) {
    if (!appState.tokenizer) {
      return { segments, usedLetters: new Set() };
    }

    const personMap = new Map();   // 完全一致（例: "佐藤太郎" -> "A"）
    const surnameMap = new Map();  // 姓との紐付け（例: "佐藤" -> "A"）
    const usedLetters = new Set();
    let nextAlphaIdx = 0;

    function allocateLetter() {
      const letter = indexToAlpha(nextAlphaIdx);
      nextAlphaIdx += 1;
      usedLetters.add(letter);
      return letter;
    }

    function resolvePersonLabel(fullName, surnamePart) {
      if (personMap.has(fullName)) {
        return personMap.get(fullName);
      }

      // 「佐藤さん」が先に出て「佐藤太郎さん」が後に出た場合や、逆順を統一
      if (surnamePart && surnameMap.has(surnamePart)) {
        const existing = surnameMap.get(surnamePart);
        // 既に別のフルネーム（同じ苗字の別人）が登録されている場合は新規採番
        let conflict = false;
        for (const [registeredName, letter] of personMap.entries()) {
          if (
            letter === existing &&
            registeredName !== surnamePart &&
            registeredName !== fullName &&
            registeredName.startsWith(surnamePart)
          ) {
            conflict = true;
            break;
          }
        }
        if (!conflict) {
          personMap.set(fullName, existing);
          return existing;
        }
      }

      const newLetter = allocateLetter();
      personMap.set(fullName, newLetter);
      if (surnamePart && !surnameMap.has(surnamePart)) {
        surnameMap.set(surnamePart, newLetter);
      }
      return newLetter;
    }

    function isPersonToken(token) {
      return (
        token.pos === "名詞" &&
        token.pos_detail_1 === "固有名詞" &&
        token.pos_detail_2 === "人名"
      );
    }

    function isExcluded(surface) {
      if (excludeSet.has(surface)) return true;
      for (const ex of excludeSet) {
        if (ex.length >= 2 && surface.includes(ex)) return true;
      }
      return false;
    }

    const resultSegments = [];

    for (const seg of segments) {
      if (seg.masked) {
        resultSegments.push(seg);
        continue;
      }

      const tokens = appState.tokenizer.tokenize(seg.text);
      let plainBuffer = "";

      const flushPlain = () => {
        if (plainBuffer.length > 0) {
          resultSegments.push({ text: plainBuffer, masked: false, source: "plain" });
          plainBuffer = "";
        }
      };

      let i = 0;
      while (i < tokens.length) {
        const token = tokens[i];

        // パターンA: kuromoji が「名詞 - 固有名詞 - 人名」と判定した連続トークン
        if (isPersonToken(token) && !isExcluded(token.surface_form)) {
          let combined = token.surface_form;
          let surnamePart = token.pos_detail_3 === "姓" ? token.surface_form : null;
          let j = i + 1;

          // 連続する人名（例：姓＋名）、または間の半角/全角スペース1文字を挟んだ姓名を結合
          while (j < tokens.length) {
            const nextTok = tokens[j];
            if (isPersonToken(nextTok) && !isExcluded(nextTok.surface_form)) {
              combined += nextTok.surface_form;
              j += 1;
            } else if (
              (nextTok.surface_form === " " || nextTok.surface_form === " ") &&
              j + 1 < tokens.length &&
              isPersonToken(tokens[j + 1]) &&
              !isExcluded(tokens[j + 1].surface_form)
            ) {
              combined += tokens[j + 1].surface_form;
              j += 2;
            } else {
              break;
            }
          }

          if (!isExcluded(combined)) {
            flushPlain();
            const label = resolvePersonLabel(combined, surnamePart || combined);
            resultSegments.push({ text: label, masked: true, source: "auto" });
            i = j;
            continue;
          }
        }

        // パターンB: 敬称（さん・様など）の直前にある固有名詞（一般）や未登録の短いカタカナ・漢字名
        const nextTok = tokens[i + 1];
        if (
          nextTok &&
          HONORIFIC_SET.has(nextTok.surface_form) &&
          token.pos === "名詞" &&
          (token.pos_detail_1 === "固有名詞" ||
            (token.word_type === "UNKNOWN" && /^[一-龥々ァ-ヶー]{2,6}$/.test(token.surface_form))) &&
          token.pos_detail_2 !== "地域" &&
          !HONORIFIC_STOPWORDS.has(token.surface_form) &&
          !isExcluded(token.surface_form)
        ) {
          flushPlain();
          const label = resolvePersonLabel(token.surface_form, token.surface_form);
          resultSegments.push({ text: label, masked: true, source: "auto" });
          i += 1;
          continue;
        }

        plainBuffer += token.surface_form;
        i += 1;
      }

      flushPlain();
    }

    return { segments: resultSegments, usedLetters };
  }

  function runAutoConversion() {
    hideWipeBanner();
    hideFloatingMenu();
    cancelCountdown();

    const rawText = els.inputText.value;
    if (!rawText.trim()) {
      appState.autoSegments = [];
      appState.renderedSegments = [];
      appState.usedPersonLetters = new Set();
      appState.manualRules = [];
      renderOutput();
      return;
    }

    const excludeSet = parseExcludeWords();
    let segments = [{ text: rawText, masked: false, source: "plain" }];

    // 1. 電話番号置換
    segments = applyRegexToSegments(segments, PHONE_REGEX, "【電話番号】", excludeSet);
    // 2. 住所置換
    segments = applyRegexToSegments(segments, ADDRESS_REGEX, "【住所】", excludeSet);
    // 3. 人名置換（kuromoji.js）
    const personResult = applyPersonMasking(segments, excludeSet);

    appState.autoSegments = personResult.segments;
    appState.usedPersonLetters = personResult.usedLetters;
    appState.manualRules = [];

    renderOutput();
  }

  // =========================================================================
  // 7. 手動追加ルール適用 ＆ 安全なDOM描画（XSS防止）
  // =========================================================================
  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildRenderedSegments() {
    let segments = appState.autoSegments.map((s) => ({ ...s }));

    // 文字数が長いルールから優先適用（部分一致の競合防止）
    const sortedRules = [...appState.manualRules].sort(
      (a, b) => b.target.length - a.target.length
    );

    for (const rule of sortedRules) {
      const regex = new RegExp(escapeRegExp(rule.target), "g");
      const next = [];

      for (const seg of segments) {
        if (seg.masked) {
          next.push(seg);
          continue;
        }

        const text = seg.text;
        regex.lastIndex = 0;
        let lastIdx = 0;
        let match;

        while ((match = regex.exec(text)) !== null) {
          if (match.index > lastIdx) {
            next.push({
              text: text.slice(lastIdx, match.index),
              masked: false,
              source: "plain"
            });
          }

          next.push({
            text: rule.replacement,
            masked: true,
            source: "manual",
            ruleId: rule.id
          });

          lastIdx = match.index + match[0].length;
        }

        if (lastIdx < text.length) {
          next.push({
            text: text.slice(lastIdx),
            masked: false,
            source: "plain"
          });
        }
      }

      segments = next;
    }

    return segments;
  }

  function renderManualRulesBadges() {
    els.manualRulesList.textContent = "";

    if (appState.manualRules.length === 0) {
      els.manualRulesSection.classList.add("hidden");
      return;
    }

    els.manualRulesSection.classList.remove("hidden");

    for (const rule of appState.manualRules) {
      const badge = document.createElement("span");
      badge.className = "rule-badge";

      const labelText = document.createElement("span");
      labelText.textContent = `${rule.target} → ${rule.replacement}`;

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "rule-remove-btn";
      removeBtn.setAttribute("aria-label", `「${rule.target}」の置換を取り消す`);
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => {
        appState.manualRules = appState.manualRules.filter((r) => r.id !== rule.id);
        renderOutput();
      });

      badge.appendChild(labelText);
      badge.appendChild(removeBtn);
      els.manualRulesList.appendChild(badge);
    }
  }

  function renderOutput() {
    appState.renderedSegments = buildRenderedSegments();
    els.outputDisplay.textContent = "";

    if (appState.renderedSegments.length === 0) {
      const placeholder = document.createElement("span");
      placeholder.className = "output-placeholder";
      placeholder.textContent = "「個人情報を除去する」を押すと、ここに結果が表示されます。";
      els.outputDisplay.appendChild(placeholder);
      els.copyBtn.disabled = true;
      renderManualRulesBadges();
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const seg of appState.renderedSegments) {
      if (seg.masked) {
        const mark = document.createElement("mark");
        mark.className = seg.source === "manual" ? "masked-manual" : "masked-auto";
        mark.dataset.masked = "true";
        mark.textContent = seg.text;
        fragment.appendChild(mark);
      } else {
        fragment.appendChild(document.createTextNode(seg.text));
      }
    }

    els.outputDisplay.appendChild(fragment);
    els.copyBtn.disabled = false;
    renderManualRulesBadges();
  }

  function getPlainOutputText() {
    return appState.renderedSegments.map((s) => s.text).join("");
  }

  // =========================================================================
  // 8. 選択テキスト用フローティングメニュー（PC・スマホ両対応）
  // =========================================================================
  function hideFloatingMenu() {
    els.floatingMenu.classList.remove("is-open");
    els.floatingCustomRow.classList.remove("is-open");
    els.floatingCustomInput.value = "";
    appState.selectedText = "";
  }

  function isInsideMaskedElement(node) {
    let cur = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (cur && cur !== els.outputDisplay) {
      if (cur.dataset && cur.dataset.masked === "true") {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function showFloatingMenuForSelection() {
    if (appState.renderedSegments.length === 0) {
      hideFloatingMenu();
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }

    const range = selection.getRangeAt(0);
    if (!els.outputDisplay.contains(range.commonAncestorContainer)) {
      return;
    }

    // すでにマスク済みのタグ内だけを選択した場合はメニューを出さない
    if (
      isInsideMaskedElement(range.startContainer) &&
      isInsideMaskedElement(range.endContainer) &&
      range.startContainer === range.endContainer
    ) {
      hideFloatingMenu();
      return;
    }

    const selected = selection.toString().trim();
    if (!selected || selected.includes("\n")) {
      hideFloatingMenu();
      return;
    }

    appState.selectedText = selected;
    els.floatingTargetPreview.textContent = `「${selected}」`;

    const nextLetter = getNextAvailableLetter();
    els.btnReplacePerson.textContent = `次の人名 (${nextLetter})`;

    // いったん表示してサイズを計測してから画面内に収まる位置へ配置
    els.floatingMenu.classList.add("is-open");
    els.floatingCustomRow.classList.remove("is-open");

    const rect = range.getBoundingClientRect();
    const menuRect = els.floatingMenu.getBoundingClientRect();
    const margin = 12;

    // タッチ端末ではOS標準コピーメニューと重なりにくいよう下側に優先表示
    const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
    let top;
    if (isCoarsePointer) {
      top = rect.bottom + 14;
      if (top + menuRect.height > window.innerHeight - margin) {
        top = rect.top - menuRect.height - 14;
      }
    } else {
      top = rect.top - menuRect.height - 10;
      if (top < margin) {
        top = rect.bottom + 10;
      }
    }

    top = Math.max(margin, Math.min(top, window.innerHeight - menuRect.height - margin));

    let left = rect.left + rect.width / 2 - menuRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - menuRect.width - margin));

    els.floatingMenu.style.top = `${Math.round(top)}px`;
    els.floatingMenu.style.left = `${Math.round(left)}px`;
  }

  function addManualRule(replacement, isPerson) {
    let target = appState.selectedText;
    if (!target) return;

    // 人名ボタンの場合は末尾の敬称を自動トリミングして本文中の同人物も統一置換
    if (isPerson) {
      const stripped = target.replace(/(?:さん|様|氏|くん|ちゃん|君|殿)$/, "").trim();
      if (stripped.length > 0) {
        target = stripped;
      }
    }

    const assignedLetter = isPerson ? getNextAvailableLetter() : null;
    const finalReplacement = isPerson ? assignedLetter : replacement;

    // 同一ターゲットが既に登録済みなら上書き
    appState.manualRules = appState.manualRules.filter((r) => r.target !== target);
    appState.manualRules.push({
      id: `rule_${appState.ruleSeq++}`,
      target,
      replacement: finalReplacement,
      isPerson,
      assignedLetter
    });

    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
    }

    hideFloatingMenu();
    renderOutput();
  }

  // =========================================================================
  // 9. コピー処理 ＆ 30秒自動消去タイマー ＆ 完全消去演出
  // =========================================================================
  async function copyPlainResult() {
    const plain = getPlainOutputText();
    if (!plain) return;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(plain);
      } else {
        const temp = document.createElement("textarea");
        temp.value = plain;
        temp.setAttribute("readonly", "");
        temp.style.position = "fixed";
        temp.style.opacity = "0";
        document.body.appendChild(temp);
        temp.select();
        document.execCommand("copy");
        document.body.removeChild(temp);
      }

      els.copyFeedback.textContent = "✅ コピーしました（タグなしプレーンテキスト）";
      startAutoWipeCountdown(30);
    } catch {
      els.copyFeedback.textContent = "⚠️ 自動コピーに失敗しました。枠内を手動でコピーしてください。";
    }
  }

  function updateCountdownDisplay() {
    els.countdownText.textContent =
      `セキュリティのため30秒後に自動消去します（残り ${appState.countdownSeconds}秒）`;
  }

  function startAutoWipeCountdown(seconds) {
    cancelCountdown();
    appState.countdownSeconds = seconds;
    els.countdownBanner.classList.add("is-visible");
    updateCountdownDisplay();

    appState.countdownTimerId = window.setInterval(() => {
      appState.countdownSeconds -= 1;
      if (appState.countdownSeconds <= 0) {
        cancelCountdown();
        executeCompleteWipe();
      } else {
        updateCountdownDisplay();
      }
    }, 1000);
  }

  function cancelCountdown() {
    if (appState.countdownTimerId !== null) {
      window.clearInterval(appState.countdownTimerId);
      appState.countdownTimerId = null;
    }
    els.countdownBanner.classList.remove("is-visible");
  }

  function hideWipeBanner() {
    els.wipeBanner.classList.remove("is-visible");
  }

  function executeCompleteWipe() {
    cancelCountdown();
    hideFloatingMenu();

    // シュレッダー風アニメーションを付与してからメモリ・DOMを完全破棄
    els.inputText.classList.add("shredding");
    els.outputDisplay.classList.add("shredding");

    window.setTimeout(() => {
      els.inputText.value = "";
      els.excludeWords.value = "";
      els.copyFeedback.textContent = "";

      appState.autoSegments = [];
      appState.renderedSegments = [];
      appState.usedPersonLetters = new Set();
      appState.manualRules = [];
      appState.selectedText = "";

      renderOutput();

      els.inputText.classList.remove("shredding");
      els.outputDisplay.classList.remove("shredding");

      els.wipeBanner.classList.add("is-visible");
      els.wipeBanner.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 450);
  }

  // =========================================================================
  // 10. イベントリスナー登録
  // =========================================================================
  window.addEventListener("online", updateNetworkStatus);
  window.addEventListener("offline", updateNetworkStatus);

  els.convertBtn.addEventListener("click", runAutoConversion);
  els.copyBtn.addEventListener("click", copyPlainResult);
  els.wipeBtn.addEventListener("click", executeCompleteWipe);
  els.wipeNowFromTimerBtn.addEventListener("click", executeCompleteWipe);

  els.extendTimerBtn.addEventListener("click", () => {
    appState.countdownSeconds += 30;
    updateCountdownDisplay();
  });

  els.cancelTimerBtn.addEventListener("click", () => {
    cancelCountdown();
    els.copyFeedback.textContent = "自動消去タイマーを停止しました（終了時は「今すぐ完全消去」を押してください）";
  });

  els.clearInputBtn.addEventListener("click", () => {
    els.inputText.value = "";
    els.inputText.focus();
  });

  els.sampleBtn.addEventListener("click", () => {
    hideWipeBanner();
    els.inputText.value =
      "相模原市南区相模大野3-1-1の佐藤太郎さん（090-1234-5678）より相談あり。\n" +
      "佐藤さんは先日、さくら総合病院を受診し、担当の鈴木花子さんと今後の通院支援について話し合ったとのこと。\n" +
      "なお、緊急連絡先は042-700-1234（鈴木さん携帯：080-9876-5432）となっている。";
    els.inputText.focus();
  });

  // 選択検知（PC: mouseup / スマホ: selectionchange デバウンス）
  els.outputDisplay.addEventListener("mouseup", () => {
    window.setTimeout(showFloatingMenuForSelection, 20);
  });

  let selectionDebounceId = null;
  document.addEventListener("selectionchange", () => {
    if (selectionDebounceId !== null) {
      window.clearTimeout(selectionDebounceId);
    }
    selectionDebounceId = window.setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        if (!els.floatingCustomRow.classList.contains("is-open")) {
          hideFloatingMenu();
        }
        return;
      }
      if (sel.rangeCount > 0 && els.outputDisplay.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        showFloatingMenuForSelection();
      }
    }, 180);
  });

  // フローティングメニューのボタン操作
  els.btnReplacePerson.addEventListener("click", () => {
    addManualRule("", true);
  });

  els.floatingMenu.querySelectorAll("[data-label]").forEach((btn) => {
    btn.addEventListener("click", () => {
      addManualRule(btn.dataset.label, false);
    });
  });

  els.btnToggleCustom.addEventListener("click", () => {
    els.floatingCustomRow.classList.toggle("is-open");
    if (els.floatingCustomRow.classList.contains("is-open")) {
      els.floatingCustomInput.focus();
    }
  });

  els.btnApplyCustom.addEventListener("click", () => {
    const customLabel = els.floatingCustomInput.value.trim();
    if (!customLabel) {
      els.floatingCustomInput.focus();
      return;
    }
    addManualRule(customLabel, false);
  });

  els.floatingCustomInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      els.btnApplyCustom.click();
    }
  });

  els.closeFloatingBtn.addEventListener("click", hideFloatingMenu);

  // メニュー外クリック・Escapeキーで閉じる
  document.addEventListener("mousedown", (e) => {
    if (
      els.floatingMenu.classList.contains("is-open") &&
      !els.floatingMenu.contains(e.target) &&
      !els.outputDisplay.contains(e.target)
    ) {
      hideFloatingMenu();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.floatingMenu.classList.contains("is-open")) {
      hideFloatingMenu();
    }
  });

  // 初期化実行
  updateNetworkStatus();
  registerServiceWorker();
  initKuromoji();
})();