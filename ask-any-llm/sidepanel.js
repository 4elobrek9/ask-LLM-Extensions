/*
 * sidepanel.js — UI чата.
 * История живёт в chrome.storage.local по ключу chat_<tabId>.
 * Запросы идут в background.js через port (стриминг + очередь + ретраи).
 */
(function () {
  "use strict";

  const L = window.AskLLM;
  const $ = (id) => document.getElementById(id);

  const els = {
    theme: $("theme"),
    analyze: $("btn-analyze"),
    newChat: $("btn-new-chat"),
    historyMenu: $("history-menu"),
    chatHistory: $("chat-history"),
    options: $("btn-options"),
    sourceList: $("source-list"),
    sourceSummary: $("source-summary"),
    messages: $("messages"),
    chips: $("chips"),
    status: $("status"),
    statusText: $("status-text"),
    input: $("input"),
    send: $("btn-send"),
    stop: $("btn-stop"),
    hint: $("provider-hint")
  };

  const state = {
    settings: L.mergeSettings({}),
    tabId: null,
    chat: null,
    chats: new Map(), // tabId -> чат (чтобы дописать ответ, даже если вкладку переключили)
    chatHistory: [],
    chatHistories: new Map(),
    contextLoads: new Map(),
    busy: false,
    active: null,
    port: null,
    pendingQueue: [],
    consuming: false,
    pendingCheck: false,
    bubbleTimer: null,
    bubbleDirty: false
  };

  function fallbackQuestions() {
    return L.getResponseLanguage(state.settings) === "en"
      ? ["What is this page about? Give me a quick summary.", "What are its key facts and figures?", "What can I apply in practice?"]
      : ["О чём эта страница? Дай краткую выжимку.", "Какие здесь ключевые факты и цифры?", "Что из этого можно применить на практике?"];
  }

  /* ---------------- Утилиты ---------------- */

  function uid() { return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function chatKey(tabId) { return "chat_" + tabId; }
  function chatHistoryKey(tabId) { return "chat_history_" + tabId; }
  function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }

  async function bg(type, extra) {
    const res = await chrome.runtime.sendMessage(Object.assign({ type: type }, extra || {}));
    if (res === undefined || res === null) throw new Error(L.translate("error.backgroundResponse", state.settings.language));
    return res;
  }

  function renderTheme() {
    const theme = state.settings.theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    els.theme.setAttribute("aria-label", L.translate(theme === "dark" ? "theme.light" : "theme.dark", state.settings.language));
    els.theme.title = L.translate(theme === "dark" ? "theme.light" : "theme.dark", state.settings.language);
    els.theme.setAttribute("aria-pressed", String(theme === "dark"));
  }

  function newChat(tabId, url, title) {
    return {
      tabId: tabId,
      chatId: uid(),
      url: url || "",
      title: title || "",
      messages: [],
      pageContext: null,
      questions: [],
      provider: state.settings.provider,
      model: state.settings.provider === "ollama" ? state.settings.ollamaModel : state.settings.pollinationsModel,
      updatedAt: Date.now()
    };
  }

  function configuredProvider() {
    const provider = state.settings.provider;
    return {
      provider: provider,
      model: provider === "ollama" ? state.settings.ollamaModel : state.settings.pollinationsModel
    };
  }

  async function loadChat(tabId, url, title) {
    if (state.chats.has(tabId)) {
      const cached = state.chats.get(tabId);
      state.chatHistory = state.chatHistories.get(tabId) || [];
      if (url) cached.url = url;
      if (title) cached.title = title;
      return cached;
    }
    const key = chatKey(tabId);
    const stored = await chrome.storage.local.get([key, chatHistoryKey(tabId)]);
    const chat = stored[key] && Array.isArray(stored[key].messages) ? stored[key] : newChat(tabId, url, title);
    chat.tabId = tabId;
    chat.chatId = chat.chatId || uid();
    chat.messages = chat.messages || [];
    chat.questions = chat.questions || [];
    chat.pageContext = chat.pageContext || null;
    Object.assign(chat, configuredProvider());
    if (url) chat.url = url;
    if (title) chat.title = title;
    state.chatHistory = Array.isArray(stored[chatHistoryKey(tabId)]) ? stored[chatHistoryKey(tabId)] : [];
    state.chatHistory = state.chatHistory.map((item) => Object.assign({}, item, { chatId: item.chatId || uid() }));
    state.chatHistories.set(tabId, state.chatHistory);
    // Незавершённые ответы прошлого сеанса помечаем как прерванные
    for (const m of chat.messages) {
      if (m.streaming) { m.streaming = false; if (!m.content) m.content = "_(ответ не завершился — панель была закрыта)_"; }
    }
    state.chats.set(tabId, chat);
    return chat;
  }

  async function saveChat(chat) {
    if (!chat) return;
    chat.updatedAt = Date.now();
    const slim = Object.assign({}, chat, {
      messages: chat.messages.slice(-80),
      pageContext: chat.pageContext
        ? Object.assign({}, chat.pageContext, { text: L.trimContext(chat.pageContext.text, state.settings.maxContextChars).text })
        : null
    });
    try {
      await chrome.storage.local.set({ [chatKey(chat.tabId)]: slim });
    } catch (e) {
      // Квота: сохраняем без контекста страницы
      try {
        slim.pageContext = null;
        slim.messages = slim.messages.slice(-30);
        await chrome.storage.local.set({ [chatKey(chat.tabId)]: slim });
      } catch (e2) { /* совсем нет места — не критично */ }
    }
  }

  async function saveChatHistory(tabId) {
    try {
      await chrome.storage.local.set({ [chatHistoryKey(tabId)]: state.chatHistory.slice(0, 10) });
      state.chatHistories.set(tabId, state.chatHistory.slice(0, 10));
    } catch (e) {
      state.chatHistory = state.chatHistory.slice(0, 3);
    }
  }

  async function archiveCurrentChat() {
    const chat = state.chat;
    if (!chat || (!chat.messages.length && !chat.pageContext)) return;
    const archived = Object.assign({}, chat, { updatedAt: Date.now() });
    state.chatHistory = state.chatHistory.filter((item) => item.chatId !== archived.chatId);
    state.chatHistory.unshift(archived);
    state.chatHistory = state.chatHistory.slice(0, 10);
    await saveChatHistory(chat.tabId);
  }

  /* ---------------- Рендер ---------------- */

  function renderAll() {
    L.localizeDocument(document, state.settings.language);
    renderTheme();
    renderMessages();
    renderChips();
    renderHint();
    renderChatHistory();
    renderSourceTabs();
  }

  function renderChatHistory() {
    els.chatHistory.textContent = "";
    if (!state.chatHistory.length) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = tr("history.empty");
      els.chatHistory.appendChild(empty);
      return;
    }
    for (const chat of state.chatHistory) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "history-item";
      const firstQuestion = chat.messages.find((m) => m.role === "user");
      item.textContent = chat.title || (firstQuestion && firstQuestion.content.slice(0, 48)) ||
        L.translate("history.previous", state.settings.language);
      item.disabled = state.busy;
      item.addEventListener("click", async () => {
        await selectChatHistory(chat.chatId);
        els.historyMenu.open = false;
      });
      els.chatHistory.appendChild(item);
    }
  }

  async function renderSourceTabs() {
    if (!state.chat) return;
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const pages = (tabs || []).filter((tab) => tab.id != null && /^https?:/i.test(tab.url || ""));
    if (!Array.isArray(state.chat.sourceTabIds) || !state.chat.sourceTabIds.length) {
      state.chat.sourceTabIds = [state.tabId];
    }
    const pageIds = new Set(pages.map((tab) => tab.id));
    state.chat.sourceTabIds = state.chat.sourceTabIds.filter((id) => pageIds.has(id));
    if (!state.chat.sourceTabIds.length && pageIds.has(state.tabId)) state.chat.sourceTabIds = [state.tabId];

    els.sourceList.textContent = "";
    for (const tab of pages) {
      const label = document.createElement("label");
      label.className = "source-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.chat.sourceTabIds.includes(tab.id);
      checkbox.addEventListener("change", () => {
        const selected = new Set(state.chat.sourceTabIds || []);
        if (checkbox.checked) selected.add(tab.id);
        else selected.delete(tab.id);
        if (!selected.size) {
          checkbox.checked = true;
          return;
        }
        state.chat.sourceTabIds = Array.from(selected);
        updateSourceSummary();
        saveChat(state.chat);
      });
      const title = document.createElement("span");
      title.textContent = tab.title || tab.url;
      label.append(checkbox, title);
      els.sourceList.appendChild(label);
    }
    updateSourceSummary();
  }

  function updateSourceSummary() {
    const count = state.chat && state.chat.sourceTabIds ? state.chat.sourceTabIds.length : 1;
    if (count === 1) {
      els.sourceSummary.textContent = L.translate("source.current", state.settings.language);
    } else {
      els.sourceSummary.textContent = state.settings.language === "en" ? count + " tabs" : count + " вкладки";
    }
  }

  function renderMessages() {
    const chat = state.chat;
    els.messages.textContent = "";
    if (!chat || !chat.messages.length) {
      els.messages.appendChild(emptyState());
      return;
    }
    const frag = document.createDocumentFragment();
    for (const m of chat.messages) frag.appendChild(messageNode(m));
    els.messages.appendChild(frag);
    scrollBottom();
  }

  function emptyState() {
    const div = document.createElement("div");
    div.className = "empty";
    div.innerHTML =
      "<h2>" + L.translate("empty.title", state.settings.language) + "</h2>" +
      "<p>" + L.translate("empty.body", state.settings.language) + "</p>" +
      "<p><kbd>Enter</kbd> " + L.translate("empty.enter", state.settings.language).replace(/^Enter\s*/i, "") + "</p>";
    return div;
  }

  function messageNode(m) {
    if (m.role === "notice") {
      const n = document.createElement("div");
      n.className = "notice";
      n.textContent = m.content;
      return n;
    }

    const wrap = document.createElement("div");
    wrap.className = "msg " + (m.error ? "error" : m.role);
    wrap.dataset.id = m.id || "";

    if (m.note) {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = m.note;
      wrap.appendChild(note);
    }

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    if (m.error) {
      const title = document.createElement("div");
      title.className = "error-title";
      title.textContent = m.error.message || L.translate("runtime.errorTitle", state.settings.language);
      bubble.appendChild(title);
      if (m.content) {
        const partial = document.createElement("div");
        partial.className = "markdown";
        partial.innerHTML = L.renderMarkdown(m.content);
        bubble.appendChild(partial);
      }
      if (m.error.hint) {
        const hint = document.createElement("div");
        hint.className = "error-hint";
        hint.textContent = m.error.hint;
        bubble.appendChild(hint);
      }
      bubble.appendChild(errorActions(m));
    } else if (m.role === "user") {
      bubble.textContent = m.content;
    } else {
      bubble.classList.add("markdown");
      bubble.innerHTML = L.renderMarkdown(m.content || "");
      if (m.streaming) bubble.classList.add("cursor");
    }
    if (!m.error && m.webSearch) appendWebResults(wrap, m.webSearch);
    wrap.appendChild(bubble);

    if (!m.error) {
      const meta = document.createElement("div");
      meta.className = "meta";
      const parts = [];
      if (m.role === "assistant") {
        if (m.ms) parts.push((m.ms / 1000).toFixed(1) + " с");
      } else {
        parts.push(new Date(m.ts || Date.now()).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }));
      }
      const span = document.createElement("span");
      span.textContent = parts.join(" · ");
      meta.appendChild(span);

      if (m.content) {
        const copy = document.createElement("button");
        copy.textContent = L.translate("copy", state.settings.language);
        copy.addEventListener("click", () => copyText(m.content, copy));
        meta.appendChild(copy);
      }
      wrap.appendChild(meta);
    }
    return wrap;
  }

  function appendWebResults(container, results) {
    const imageUrls = Array.isArray(results.imageUrls)
      ? results.imageUrls
      : (results.imageUrl ? [results.imageUrl] : []);
    const validImageUrls = imageUrls.filter((url) => /^https:\/\//i.test(url)).slice(0, 3);
    if (!validImageUrls.length) return;

    const card = document.createElement("div");
    card.className = "web-search-card";
    for (const imageUrl of validImageUrls) {
      const imageLink = document.createElement("a");
      imageLink.href = results.imageSearchUrl || imageUrl;
      imageLink.target = "_blank";
      imageLink.rel = "noopener noreferrer";
      const image = document.createElement("img");
      image.src = imageUrl;
      image.alt = tr("web.image");
      image.loading = "lazy";
      image.addEventListener("error", () => {
        imageLink.remove();
        if (!card.querySelector("a")) card.remove();
      });
      imageLink.appendChild(image);
      card.appendChild(imageLink);
    }
    container.appendChild(card);
  }

  function errorActions(m) {
    const box = document.createElement("div");
    box.className = "error-actions";
    const add = (label, handler) => {
      const b = document.createElement("button");
      b.className = "btn small";
      b.textContent = label;
      b.addEventListener("click", handler);
      box.appendChild(b);
    };
    const err = m.error || {};
    if (err.code !== "ABORTED") add(L.translate("action.retry", state.settings.language), () => retryLast());
    if (err.code === "NO_ACCESS" || err.code === "NO_CONTENT") add(L.translate("action.allowSites", state.settings.language), grantAccess);
    add(L.translate("settings.open", state.settings.language), () => chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }));
    return box;
  }

  function renderChips() {
    const questions = (state.chat && state.chat.questions) || [];
    els.chips.textContent = "";
    if (!questions.length) { els.chips.classList.add("hidden"); return; }
    els.chips.classList.remove("hidden");
    for (const q of questions) {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.type = "button";
      chip.textContent = q;
      chip.title = (state.settings.language === "en" ? "Ask: " : "Спросить: ") + q;
      chip.disabled = state.busy;
      chip.addEventListener("click", () => {
        els.input.value = q;
        autoGrow();
        send(q);
      });
      els.chips.appendChild(chip);
    }
  }

  function renderHint() {
    const chat = state.chat;
    if (!chat) { els.hint.textContent = ""; return; }
    if (chat.provider === "ollama") {
      els.hint.textContent = "LOCAL";
    } else {
      els.hint.textContent = "FREE";
    }
  }

  function setStatus(text, visible) {
    const show = visible === undefined ? !!text : !!visible;
    if (text) els.statusText.textContent = text;
    els.status.classList.toggle("hidden", !show);
  }

  function tr(key) { return L.translate(key, state.settings.language); }

  function setBusy(busy) {
    state.busy = busy;
    els.send.classList.toggle("hidden", busy);
    els.stop.classList.toggle("hidden", !busy);
    els.analyze.disabled = busy;
    els.newChat.disabled = busy;
    els.historyMenu.querySelector("summary").setAttribute("aria-disabled", String(busy));
    els.send.disabled = busy;
    for (const chip of els.chips.querySelectorAll(".chip")) chip.disabled = busy;
    if (!busy) setStatus("", false);
  }

  function nearBottom() {
    const el = els.messages;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  }

  function scrollBottom(force) {
    if (force || nearBottom()) els.messages.scrollTop = els.messages.scrollHeight;
  }

  /* ---------------- Порт и запросы ---------------- */

  function connectPort() {
    if (state.port) return state.port;
    const port = chrome.runtime.connect({ name: "llm-stream" });
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      state.port = null;
      if (state.busy) {
        finishError({
          code: "PORT_CLOSED",
          message: "Фоновый процесс Chrome перезапустился, запрос прерван.",
          hint: "Это бывает после простоя. Просто повторите запрос."
        });
      }
    });
    state.port = port;
    return port;
  }

  // Пинг не даёт service worker уснуть посреди длинного ответа
  setInterval(() => {
    if (state.busy && state.port) {
      try { state.port.postMessage({ type: "PING" }); } catch (e) {}
    }
  }, 15000);

  function startRequest(req) {
    const requestId = uid();
    state.active = {
      requestId: requestId,
      kind: req.kind,
      tabId: req.tabId,
      assistantMsg: req.assistantMsg || null,
      model: req.model,
      provider: req.provider,
      text: "",
      reasoning: "",
      note: "",
      startedAt: Date.now()
    };
    setBusy(true);
    setStatus(tr(req.kind === "questions" ? "status.questionsLoading" : "status.answerLoading"), true);
    connectPort().postMessage({
      type: "START",
      requestId: requestId,
      provider: req.provider,
      model: req.model,
      messages: req.messages
    });
  }

  function onPortMessage(msg) {
    const a = state.active;
    if (!msg || !a || msg.requestId !== a.requestId) return;

    switch (msg.type) {
      case "PONG":
        break;
      case "STATUS":
        setStatus(msg.text, true);
        break;
      case "META":
        a.model = msg.model;
        if (a.assistantMsg) a.assistantMsg.model = msg.model;
        break;
      case "delta":
        a.text += msg.text || "";
        if (a.assistantMsg) { a.assistantMsg.content = a.text; scheduleBubbleUpdate(); }
        break;
      case "reasoning":
        break;
      case "DONE":
        finishDone(msg);
        break;
      case "ERROR":
        finishError(msg);
        break;
    }
  }

  // Обновляем пузырь не чаще раза в 60 мс — иначе длинный ответ тормозит UI
  function scheduleBubbleUpdate() {
    state.bubbleDirty = true;
    if (state.bubbleTimer) return;
    state.bubbleTimer = setTimeout(() => {
      state.bubbleTimer = null;
      if (!state.bubbleDirty) return;
      state.bubbleDirty = false;
      const a = state.active;
      if (!a || !a.assistantMsg || a.tabId !== state.tabId) return;
      const node = els.messages.querySelector('[data-id="' + a.assistantMsg.id + '"] .bubble');
      if (!node) return;
      const stick = nearBottom();
      node.innerHTML = L.renderMarkdown(a.assistantMsg.content || "");
      node.classList.add("cursor");
      if (stick) scrollBottom(true);
    }, 60);
  }

  function finishDone(msg) {
    const a = state.active;
    if (!a) return;
    const chat = state.chats.get(a.tabId) || state.chat;
    const elapsed = msg.ms || Date.now() - a.startedAt;

    if (a.kind === "questions") {
      const parsed = L.parseQuestions(msg.text);
      chat.questions = parsed.length ? parsed : fallbackQuestions();
      chat.messages.push({
        id: uid(), role: "notice", ts: Date.now(),
        content: parsed.length
          ? tr("status.questionsReady") + chat.questions.length + tr("status.questionsReadyTail")
          : tr("status.questionFallback")
      });
    } else if (a.assistantMsg) {
      a.assistantMsg.content = (msg.text || a.text || "").trim() || "_(модель вернула пустой ответ)_";
      a.assistantMsg.model = msg.model || a.model;
      a.assistantMsg.provider = msg.provider || a.provider;
      a.assistantMsg.ms = elapsed;
      a.assistantMsg.streaming = false;
      const questionSource = state.settings.questionMode === "answer"
        ? a.assistantMsg.content
        : (chat.pageContext && chat.pageContext.text) || a.assistantMsg.content;
      if (questionSource) {
        chat.questions = L.generateQuestions(
          questionSource,
          chat.pageContext && chat.pageContext.title,
          state.settings.questionMode,
          Date.now() + chat.messages.length,
          L.getResponseLanguage(state.settings)
        );
      }
    }

    state.active = null;
    setBusy(false);
    saveChat(chat);
    if (chat === state.chat) { renderMessages(); renderChips(); scrollBottom(true); }
    drainPending();
  }

  function finishError(err) {
    const a = state.active;
    const chat = a ? (state.chats.get(a.tabId) || state.chat) : state.chat;
    if (!chat) { setBusy(false); state.active = null; return; }

    const error = {
      code: err.code || "ERROR",
      message: err.message || "Неизвестная ошибка",
      hint: err.hint || "",
      canSwitchToPollinations: !!err.canSwitchToPollinations,
      canSwitchToOllama: !!err.canSwitchToOllama,
      canSwitchModel: err.canSwitchModel || ""
    };

    if (error.code === "ABORTED") {
      if (a && a.assistantMsg) {
        if (a.text.trim()) {
          a.assistantMsg.content = a.text.trim();
          a.assistantMsg.streaming = false;
          a.assistantMsg.note = "Остановлено пользователем.";
          a.assistantMsg.ms = Date.now() - a.startedAt;
        } else {
          chat.messages = chat.messages.filter((m) => m !== a.assistantMsg);
          chat.messages.push({ id: uid(), role: "notice", ts: Date.now(), content: tr("notice.stopped") });
        }
      }
    } else {
      if (a && a.assistantMsg) {
        if (a.text.trim()) {
          a.assistantMsg.content = a.text.trim();
          a.assistantMsg.streaming = false;
          a.assistantMsg.ms = Date.now() - a.startedAt;
          chat.messages.push({ id: uid(), role: "assistant", ts: Date.now(), content: "", error: error });
        } else {
          a.assistantMsg.error = error;
          a.assistantMsg.streaming = false;
          a.assistantMsg.content = "";
        }
      } else {
        chat.messages.push({ id: uid(), role: "assistant", ts: Date.now(), content: "", error: error });
      }
    }

    state.active = null;
    setBusy(false);
    saveChat(chat);
    if (chat === state.chat) { renderMessages(); renderChips(); scrollBottom(true); }
    drainPending();
  }

  /* ---------------- Действия пользователя ---------------- */

  function needsWebSearch(text, forced) {
    if (forced) return true;
    return /(?:актуальн|сейчас|сегодня|последн|новост|цена|стоимост|сколько стоит|купить|найди картин|поиск в интернете|в интернете|погода|курс валют|\b(?:latest|current|today|news|price|cost|buy|shopping|search online|web search)\b)/i.test(text) ||
      needsProductImage(text);
  }

  function needsProductImage(text) {
    const value = String(text || "").trim();
    if (/(?:товар|модель|купить|цена|стоимост|картин|изображен|product|model|price|cost|buy|image|photo|phone|headphones?|earbuds?|speaker|laptop|camera|телефон|смартфон|наушник|планшет|ноутбук|камера|кроссов|автомобил)/i.test(value)) return true;
    if (value.length < 4 || value.length > 90 || /[.!?。]/.test(value) ||
        /\b(?:кто|что|как|почему|зачем|объясни|расскажи|what|who|how|why|explain|tell)\b/i.test(value)) return false;
    const words = value.split(/\s+/);
    return /\d/.test(value) || words.slice(1).some((word) => /^[A-Z][A-Za-z0-9-]+$/.test(word));
  }

  function webContext(results) {
    const timestamp = new Date(results.searchedAt).toLocaleString(state.settings.language === "en" ? "en-US" : "ru-RU");
    const entries = results.results.map((item, index) =>
      (index + 1) + ". " + item.title + (item.date ? " — " + item.date : "") + ": " + item.snippet + " (" + item.url + ")"
    );
    if (!entries.length) {
      return "Поиск Bing не дал текстовых источников. Ответь на вопрос из собственных знаний ИИ, " +
        "честно обозначь неуверенность и не выдумывай свежие цены, источники или факты.";
    }
    return "Свежие результаты поиска Bing, получены " + timestamp + ". Используй их только для актуальных фактов, " +
      "не представляй рекламные или обрывочные сниппеты как гарантированную цену; если называешь цену, укажи источник и дату, " +
      "а если цены нет — не угадывай.\n" + entries.join("\n");
  }

  async function send(text, options) {
    text = String(text || "").trim();
    const chat = state.chat;
    const sendOptions = options || {};
    if (!text || !chat) return;
    if (state.busy) { setStatus(tr("status.waitCurrent"), true); return; }
    const sourceIds = chat.sourceTabIds && chat.sourceTabIds.length ? chat.sourceTabIds : [chat.tabId];
    const hasPageContext = chat.pageContext && (
      sourceIds.every((id) => (chat.pageContext.sources || []).some((source) => source.tabId === id)) ||
      (sourceIds.length === 1 && chat.pageContext.url === chat.url)
    );
    if (!hasPageContext) {
      setBusy(true);
      setStatus(tr("status.contextLoading"), true);
      try {
        const sources = await extractTabSources(sourceIds);
        applyPageSources(chat, sources);
      } catch (e) {
        chat.pageContext = null;
        chat.questions = [];
      }
      setBusy(false);
      setStatus("", false);
      if (state.chat !== chat) return;
    }

    Object.assign(chat, configuredProvider());

    let webResults = null;
    let webError = "";
    if (state.settings.webSearch && needsWebSearch(text, sendOptions.webSearch)) {
      setBusy(true);
      els.stop.classList.add("hidden");
      els.send.classList.remove("hidden");
      setStatus(tr("status.webSearch"), true);
      try {
        const result = await bg("SEARCH_WEB", {
          query: text,
          includeImage: needsProductImage(text),
          language: state.settings.language
        });
        if (result && result.ok) webResults = result;
        else {
          const message = String(result && (result.error || result.message) || "");
          webError = /(?:неизвестный тип сообщения|unknown message type):?\s*SEARCH_WEB/i.test(message)
            ? tr("error.searchExtensionReload")
            : message || tr("error.webSearch");
        }
      } catch (e) {
        webError = e.message || tr("error.webSearch");
      } finally {
        setBusy(false);
        setStatus("", false);
      }
      if (state.chat !== chat) return;
    }

    const history = chat.messages.slice();
    chat.messages.push({ id: uid(), role: "user", content: text, ts: Date.now() });
    const assistantMsg = {
      id: uid(), role: "assistant", content: "", ts: Date.now(), streaming: true,
      model: chat.model, provider: chat.provider
    };
    if (webResults) {
      assistantMsg.webSearch = webResults;
    }
    else if (webError) assistantMsg.note = tr("notice.webSearchUnavailable") + webError;
    chat.messages.push(assistantMsg);

    els.input.value = "";
    autoGrow();
    renderMessages();
    scrollBottom(true);
    saveChat(chat);

    const messages = L.buildMessages({
      settings: state.settings,
      history: history,
      userText: text,
      pageContext: chat.pageContext,
      webContext: webResults ? webContext(webResults) : ""
    });

    startRequest({
      kind: "chat",
      messages: messages,
      provider: chat.provider,
      model: chat.model,
      assistantMsg: assistantMsg,
      tabId: chat.tabId
    });
  }

  async function analyzePage() {
    const chat = state.chat;
    if (!chat || state.tabId == null) return;
    if (state.busy) { setStatus(tr("status.waitCurrent"), true); return; }

    const tabIds = Array.isArray(chat.sourceTabIds) && chat.sourceTabIds.length ? chat.sourceTabIds.slice() : [state.tabId];
    setBusy(true);
    setStatus(tabIds.length > 1
      ? (state.settings.language === "en" ? "Reading " + tabIds.length + " tabs…" : "Читаю " + tabIds.length + " вкладки…")
      : tr("status.readingPage"), true);

    let sources;
    try {
      sources = await extractTabSources(tabIds);
    } catch (e) {
      setBusy(false);
      setStatus("", false);
      chat.messages.push({
        id: uid(), role: "assistant", ts: Date.now(), content: "",
        error: { code: "NO_CONTENT", message: String(e && e.message || e), hint: tr("notice.readErrorHint") }
      });
      renderMessages();
      saveChat(chat);
      scrollBottom(true);
      return;
    }

    applyPageSources(chat, sources);
    chat.questions = L.generateQuestions(chat.pageContext.text, chat.pageContext.title, "page", Date.now(), L.getResponseLanguage(state.settings));
    chat.messages.push({
      id: uid(), role: "notice", ts: Date.now(),
      content: sources.length === 1
        ? tr("notice.readPage") + (sources[0].title || sources[0].url) + "»" +
          (sources[0].method === "youtube-captions" ? (state.settings.language === "en" ? " · video captions" : " · субтитры видео") : "")
        : tr("notice.readTabs") + sources.length
    });
    renderMessages();
    renderChips();
    saveChat(chat);
    scrollBottom(true);
    setBusy(false);
    setStatus("", false);
  }

  async function extractTabSources(tabIds) {
    return Promise.all(tabIds.map(async (tabId) => {
      const [res, tab] = await Promise.all([
        bg("EXTRACT_PAGE", { tabId: tabId }),
        chrome.tabs.get(tabId).catch(() => null)
      ]);
      if (!res || !res.ok) {
        throw new Error((tab && tab.title ? tab.title + ": " : "") + ((res && res.message) || tr("error.noTabResponse")));
      }
      return Object.assign({}, res, { tabId: tabId });
    }));
  }

  function applyPageSources(chat, sources) {
    const combinedText = sources.map((source, index) => {
      const heading = sources.length > 1 ? "\n\n--- Источник " + (index + 1) + ": " + (source.title || source.url) + " ---\n" : "";
      return heading + source.text;
    }).join("\n\n");
    const first = sources[0];
    chat.pageContext = {
      url: first.url,
      title: sources.length === 1 ? first.title : sources.length + " выбранные вкладки",
      text: combinedText,
      length: combinedText.length,
      method: sources.length === 1 ? first.method : "multiple-tabs",
      sources: sources.map((source) => ({ tabId: source.tabId, url: source.url, title: source.title, method: source.method })),
      ts: Date.now()
    };
  }

  // Повтор: убираем последний вопрос вместе с ошибкой и отправляем заново
  function retryLast() {
    const chat = state.chat;
    if (!chat || state.busy) return;
    let idx = -1;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === "user") { idx = i; break; }
    }
    if (idx < 0) { analyzePage(); return; }
    const text = chat.messages[idx].content;
    chat.messages = chat.messages.slice(0, idx);
    renderMessages();
    saveChat(chat);
    send(text);
  }

  async function grantAccess() {
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] });
    } catch (e) { granted = false; }
    const chat = state.chat;
    if (!chat) return;
    chat.messages = chat.messages.filter((m) => !(m.error && (m.error.code === "NO_ACCESS" || m.error.code === "NO_CONTENT")));
    chat.messages.push({
      id: uid(), role: "notice", ts: Date.now(),
      content: granted ? tr("notice.accessGranted") : tr("notice.accessDenied")
    });
    renderMessages();
    saveChat(chat);
    if (granted) analyzePage();
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e2) {}
      ta.remove();
    }
    if (button) {
      const old = button.textContent;
      button.textContent = tr("notice.copied");
      setTimeout(() => { button.textContent = old; }, 1200);
    }
  }

  async function startNewChat() {
    const chat = state.chat;
    if (!chat || state.busy) return;
    await archiveCurrentChat();
    const tab = await chrome.tabs.get(state.tabId).catch(() => null);
    state.chat = newChat(state.tabId, tab && tab.url, tab && tab.title);
    state.chat.sourceTabIds = [state.tabId];
    state.chats.set(state.tabId, state.chat);
    await saveChat(state.chat);
    renderAll();
    if (state.chatHistory.length) renderChatHistory();
    loadTabContext(state.tabId);
  }

  async function selectChatHistory(id) {
    if (!id || state.busy) return;
    const selected = state.chatHistory.find((chat) => chat.chatId === id);
    if (!selected) return;
    await archiveCurrentChat();
    state.chatHistory = state.chatHistory.filter((chat) => chat.chatId !== id);
    state.chat = Object.assign({}, selected, { tabId: state.tabId });
    Object.assign(state.chat, configuredProvider());
    state.chats.set(state.tabId, state.chat);
    await saveChatHistory(state.tabId);
    await saveChat(state.chat);
    renderAll();
  }

  function autoGrow() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(140, Math.max(36, els.input.scrollHeight)) + "px";
  }

  /* ---------------- Задания из контекстного меню ---------------- */

  async function consumePending() {
    if (state.tabId == null) return;
    if (state.consuming) {
      state.pendingCheck = true;
      return;
    }
    state.consuming = true;
    let res;
    try { res = await bg("CONSUME_PENDING", { tabId: state.tabId }); }
    catch (e) {
      state.consuming = false;
      if (state.pendingCheck) {
        state.pendingCheck = false;
        consumePending();
      }
      return;
    }
    state.consuming = false;
    const task = res && res.task;
    if (task && Date.now() - (task.ts || 0) <= 5 * 60 * 1000) {
      if (state.busy) state.pendingQueue.push(task);
      else await runTask(task);
    }
    if (state.pendingCheck) {
      state.pendingCheck = false;
      consumePending();
    }
  }

  async function runTask(task) {
    if (task.type === "ask") {
      await send(task.text, {
        webSearch: !!task.webSearch && (needsWebSearch(task.text) || needsProductImage(task.text))
      });
    } else if (task.type === "analyze") {
      await analyzePage();
    } else if (task.type === "notice") {
      const chat = state.chat;
      if (!chat) return;
      chat.messages.push({ id: uid(), role: "notice", ts: Date.now(), content: task.message });
      renderMessages();
      saveChat(chat);
    }
  }

  function drainPending() {
    if (state.busy || !state.pendingQueue.length) return;
    const task = state.pendingQueue.shift();
    setTimeout(() => runTask(task), 50);
  }

  /* ---------------- Вкладки ---------------- */

  async function switchToTab(tabId) {
    if (tabId == null) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    state.tabId = tabId;
    state.chat = await loadChat(tabId, tab && tab.url, tab && tab.title);
    renderAll();
    await consumePending();
    loadTabContext(tabId);
  }

  async function loadTabContext(tabId) {
    if (state.contextLoads.has(tabId)) return state.contextLoads.get(tabId);
    const task = (async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || !/^https?:/i.test(tab.url || "") || (tab.status && tab.status !== "complete")) return;
      const chat = state.chats.get(tabId);
      if (!chat) return;
      const hasContext = chat.pageContext && (
        chat.pageContext.url === tab.url ||
        (chat.pageContext.sources || []).some((source) => source.tabId === tabId && source.url === tab.url)
      );
      if (!hasContext) {
        const res = await bg("EXTRACT_PAGE", { tabId: tabId }).catch(() => null);
        if (state.chats.get(tabId) !== chat) return;
        if (!res || !res.ok) {
          if (!chat.questions.length) {
            chat.questions = L.generateQuestions(tab.title || tab.url, tab.title, "page", Date.now(), L.getResponseLanguage(state.settings));
          }
          await saveChat(chat);
          if (state.tabId === tabId && state.chat === chat) renderChips();
          return;
        }
        chat.url = tab.url;
        chat.title = tab.title || res.title;
        chat.pageContext = {
          url: res.url, title: res.title, text: res.text, length: res.length,
          method: res.method, sources: [{ tabId: tabId, url: res.url, title: res.title, method: res.method }], ts: Date.now()
        };
        if (!chat.questions.length) {
          chat.questions = L.generateQuestions(res.text, res.title, "page", Date.now(), L.getResponseLanguage(state.settings));
        }
        await saveChat(chat);
      } else if (!chat.questions.length) {
        chat.questions = L.generateQuestions(chat.pageContext.text, chat.pageContext.title, "page", Date.now(), L.getResponseLanguage(state.settings));
        await saveChat(chat);
      }
      if (state.tabId === tabId && state.chat === chat) {
        renderChips();
      }
    })();
    state.contextLoads.set(tabId, task);
    try { await task; }
    finally { state.contextLoads.delete(tabId); }
  }

  async function init() {
    try {
      const s = await bg("GET_SETTINGS");
      state.settings = L.mergeSettings(s.settings);
    } catch (e) { /* останутся дефолты */ }
    renderTheme();

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0]) await switchToTab(tabs[0].id);
    else renderAll();

    connectPort();
    els.input.focus();
  }

  /* ---------------- События ---------------- */

  els.send.addEventListener("click", () => send(els.input.value));
  els.stop.addEventListener("click", () => {
    if (state.port && state.active) state.port.postMessage({ type: "ABORT", requestId: state.active.requestId });
  });
  els.analyze.addEventListener("click", analyzePage);
  els.newChat.addEventListener("click", startNewChat);
  els.options.addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }));
  els.theme.addEventListener("click", async () => {
    const previous = state.settings.theme;
    const theme = previous === "dark" ? "light" : "dark";
    state.settings = L.mergeSettings(Object.assign({}, state.settings, { theme: theme }));
    renderTheme();
    els.theme.disabled = true;
    try {
      const res = await bg("SAVE_SETTINGS", { patch: { theme: theme } });
      state.settings = L.mergeSettings(res.settings);
      renderTheme();
    } catch (e) {
      state.settings = L.mergeSettings(Object.assign({}, state.settings, { theme: previous }));
      renderTheme();
      setStatus("Не удалось сохранить тему: " + (e.message || e), true);
    } finally {
      els.theme.disabled = false;
    }
  });
  els.input.addEventListener("input", () => {
    autoGrow();
    els.input.closest(".composer").classList.toggle("has-draft", !!els.input.value.trim());
  });
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(els.input.value);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.busy && state.port && state.active) {
      state.port.postMessage({ type: "ABORT", requestId: state.active.requestId });
    }
  });

  chrome.tabs.onActivated.addListener((info) => { switchToTab(info.tabId); });
  chrome.tabs.onRemoved.addListener((tabId) => {
    state.chats.delete(tabId);
    state.chatHistories.delete(tabId);
    if (state.chat && Array.isArray(state.chat.sourceTabIds)) {
      state.chat.sourceTabIds = state.chat.sourceTabIds.filter((id) => id !== tabId);
      if (!state.chat.sourceTabIds.length && state.tabId !== tabId) state.chat.sourceTabIds = [state.tabId];
      saveChat(state.chat);
      renderSourceTabs();
    }
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== state.tabId || !state.chat) return;
    if (changeInfo.title) state.chat.title = changeInfo.title;
    if (changeInfo.url && changeInfo.url !== state.chat.url) {
      state.chat.url = changeInfo.url;
      // Другая страница — старый контекст и вопросы больше не актуальны
      state.chat.pageContext = null;
      state.chat.questions = [];
      renderChips();
      saveChat(state.chat);
    }
    if (changeInfo.status === "complete") loadTabContext(tabId);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "SETTINGS_CHANGED") {
      const previousResponseLanguage = L.getResponseLanguage(state.settings);
      state.settings = L.mergeSettings(msg.settings);
      const responseLanguage = L.getResponseLanguage(state.settings);
      const configured = configuredProvider();
      for (const chat of state.chats.values()) {
        Object.assign(chat, configured);
        if (previousResponseLanguage !== responseLanguage && chat.questions.length) {
          const lastAnswer = chat.messages.slice().reverse().find((message) => message.role === "assistant" && message.content);
          const source = state.settings.questionMode === "answer" && lastAnswer
            ? lastAnswer.content
            : chat.pageContext && chat.pageContext.text;
          chat.questions = source
            ? L.generateQuestions(source, chat.pageContext && chat.pageContext.title, state.settings.questionMode, Date.now(), responseLanguage)
            : fallbackQuestions();
        }
        saveChat(chat);
      }
      renderAll();
    } else if (msg.type === "PENDING_TASK") {
      if (msg.tabId === state.tabId) consumePending();
    }
  });

  init();
})();
