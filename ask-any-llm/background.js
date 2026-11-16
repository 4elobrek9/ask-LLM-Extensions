/*
 * background.js — service worker (MV3).
 * Контекстное меню, роутинг сообщений, очередь запросов к LLM, стриминг в side panel.
 * Ключей нет: Pollinations работает анонимно, Ollama — локально.
 */
importScripts("shared.js");
const L = self.AskLLM;

const MODELS_TTL_MS = 6 * 60 * 60 * 1000; // кэш списка моделей на 6 часов
const CHAT_PREFIX = "chat_";
const CHAT_HISTORY_PREFIX = "chat_history_";
const PENDING_PREFIX = "pending_";
const MAX_TOTAL_WAIT_SEC = 180; // сколько максимум ждём освобождения free-слота

let settingsCache = null;
let menuChain = Promise.resolve();
let queue = Promise.resolve(); // Pollinations: один запрос за раз
let queueDepth = 0;
const activeRequests = new Map(); // requestId -> {ctrl, timedOut}

/* ------------------------------------------------------------------ */
/* Настройки и модели                                                  */
/* ------------------------------------------------------------------ */

async function getSettings() {
  if (settingsCache) return settingsCache;
  const stored = await chrome.storage.sync.get("settings");
  settingsCache = L.mergeSettings(stored.settings);
  return settingsCache;
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = L.mergeSettings(Object.assign({}, current, patch));
  await chrome.storage.sync.set({ settings: next });
  settingsCache = next;
  return next;
}

// Список живых моделей Pollinations (кэш + мягкая деградация при офлайне)
async function getModels(force) {
  const cached = await chrome.storage.local.get("modelsCache");
  const cache = cached.modelsCache;
  const fresh = cache && Date.now() - cache.ts < MODELS_TTL_MS;
  if (!force && fresh && Array.isArray(cache.models)) return cache.models;
  try {
    const models = await L.fetchPollinationsModels({});
    await chrome.storage.local.set({ modelsCache: { ts: Date.now(), models: models, ok: true } });
    return models;
  } catch (e) {
    if (cache && Array.isArray(cache.models)) return cache.models; // лучше устаревший список, чем пустой
    await chrome.storage.local.set({ modelsCache: { ts: Date.now(), models: [], ok: false, error: String(e && e.message || e) } });
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Контекстное меню                                                    */
/* ------------------------------------------------------------------ */

function rebuildMenus() {
  // Сериализуем пересборку, иначе возможны ошибки duplicate id
  menuChain = menuChain.then(buildMenus, buildMenus);
  return menuChain;
}

async function buildMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "ask",
    title: "Спросить",
    contexts: ["selection"]
  });

  chrome.contextMenus.create({
    id: "analyze-page",
    title: "Прочитать страницу",
    contexts: ["page"]
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.sync.get("settings");
  if (!stored.settings) await chrome.storage.sync.set({ settings: L.DEFAULT_SETTINGS });
  settingsCache = null;
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (e) {}
  await rebuildMenus();
  try { await chrome.storage.session.set({ menusBuilt: true }); } catch (e) {}
  if (details.reason === "install") pruneOldChats();
});

chrome.runtime.onStartup.addListener(() => {
  settingsCache = null;
  rebuildMenus();
});

// Worker мог проснуться без onInstalled: меню пересобираем один раз за сессию браузера
(async () => {
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (e) {}
  try {
    const flag = await chrome.storage.session.get("menusBuilt");
    if (!flag.menusBuilt) {
      await rebuildMenus();
      await chrome.storage.session.set({ menusBuilt: true });
    }
  } catch (e) {
    rebuildMenus();
  }
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.settings) {
    settingsCache = L.mergeSettings(changes.settings.newValue);
    broadcast({ type: "SETTINGS_CHANGED", settings: settingsCache });
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // Панель открываем сразу — жест пользователя ещё активен
  if (tab && tab.id != null) {
    try { chrome.sidePanel.open({ tabId: tab.id }).catch(() => {}); } catch (e) {}
  }
  handleMenuClick(info, tab).catch((e) => console.warn("[ask-any-llm] menu error", e));
});

async function handleMenuClick(info, tab) {
  const id = String(info.menuItemId || "");
  if (!tab || tab.id == null) return;

  if (id === "analyze-page") {
    await setPending(tab.id, { type: "analyze" });
    return;
  }

  if (id === "ask") {
    const settings = await getSettings();
    const provider = settings.provider;
    const model = provider === "ollama" ? settings.ollamaModel : settings.pollinationsModel;
    // Полный текст выделения берём из страницы: info.selectionText теряет переносы строк
    let text = info.selectionText || "";
    const sel = await sendToTab(tab.id, { type: "GET_SELECTION" }).catch(() => null);
    if (sel && sel.ok && sel.text && sel.text.trim().length >= text.trim().length) text = sel.text;
    text = String(text || "").trim();
    if (!text) {
      await setPending(tab.id, { type: "notice", message: "Не удалось получить выделенный текст. Выделите текст заново." });
      return;
    }
    await setPending(tab.id, { type: "ask", text: text, provider: provider, model: model, webSearch: true });
  }
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

function parseBingRss(xml) {
  return Array.from(String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/gi)).slice(0, 6).map((match) => {
    const field = (name) => {
      const found = match[1].match(new RegExp("<" + name + ">([\\s\\S]*?)<\\/" + name + ">", "i"));
      return found ? decodeXml(found[1].trim()) : "";
    };
    return { title: field("title"), url: field("link"), snippet: field("description"), date: field("pubDate") };
  }).filter((item) => item.title && /^https?:\/\//i.test(item.url));
}

function parseBingImageUrls(html) {
  const imageUrls = [];
  for (const match of String(html || "").matchAll(/mediaurl=([^&"']+)/gi)) {
    try {
      const candidate = decodeURIComponent(match[1].replace(/&amp;/g, "&"));
      if (/^https:\/\//i.test(candidate) && !imageUrls.includes(candidate)) imageUrls.push(candidate);
      if (imageUrls.length === 3) break;
    } catch (e) {
      // Ignore malformed image URLs and keep looking for usable results.
    }
  }
  return imageUrls;
}

async function searchWeb(query, includeImage, language) {
  const cleanQuery = String(query || "").trim().slice(0, 300);
  if (!cleanQuery) return { ok: false, error: "Пустой поисковый запрос." };
  const markets = language === "en" ? ["en-US", "ru-RU"] : ["ru-RU", "en-US"];
  const queryParam = encodeURIComponent(cleanQuery);
  let results = [];
  let searchError = "";
  for (const market of markets) {
    try {
      const url = "https://www.bing.com/search?format=rss&setmkt=" + market + "&q=" + queryParam;
      const response = await fetch(url, { headers: { Accept: "application/rss+xml, application/xml, text/xml" } });
      if (!response.ok) throw new Error("Поиск Bing вернул HTTP " + response.status);
      results = parseBingRss(await response.text());
      if (results.length) break;
    } catch (e) {
      searchError = e.message || String(e);
    }
  }

  const imageSearchUrl = includeImage
    ? "https://www.bing.com/images/search?setmkt=" + markets[0] + "&q=" + queryParam
    : "";
  let imageUrls = [];
  if (imageSearchUrl) {
    for (const market of markets) {
      try {
        const imageResponse = await fetch(
          "https://www.bing.com/images/async?q=" + queryParam + "&async=content&first=1&count=30&setmkt=" + market,
          { headers: { Accept: "text/html" } }
        );
        if (imageResponse.ok) {
          imageUrls = parseBingImageUrls(await imageResponse.text());
          if (imageUrls.length) break;
        }
      } catch (e) {
        // Text results remain useful when Bing Images is unavailable.
      }
    }
  }
  if (!results.length && !imageUrls.length) {
    return { ok: false, error: searchError || "Поиск не вернул доступных результатов." };
  }
  return {
    ok: true,
    results: results,
    imageUrls: imageUrls,
    imageSearchUrl: imageSearchUrl,
    searchError: searchError,
    searchedAt: Date.now()
  };
}

// Задание для панели: она забирает его при открытии или по сигналу
async function setPending(tabId, task) {
  const payload = Object.assign({ id: "t" + Date.now() + Math.random().toString(36).slice(2, 7), ts: Date.now() }, task);
  await chrome.storage.local.set({ [PENDING_PREFIX + tabId]: payload });
  broadcast({ type: "PENDING_TASK", tabId: tabId });
}

function broadcast(message) {
  try { chrome.runtime.sendMessage(message).catch(() => {}); } catch (e) {}
}

/* ------------------------------------------------------------------ */
/* Доступ к странице                                                   */
/* ------------------------------------------------------------------ */

function isInjectable(url) {
  return /^https?:/i.test(String(url || ""));
}

async function ensureContentScript(tabId) {
  try {
    const pong = await sendToTab(tabId, { type: "PING" });
    if (pong && pong.ok) return { ok: true };
  } catch (e) { /* контент-скрипта нет — пробуем внедрить */ }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["readability/Readability.js", "content.js"]
    });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      code: "NO_ACCESS",
      message: "Нет доступа к этой вкладке.",
      hint: "Если страница была открыта до установки расширения — обновите её (F5). Либо разрешите доступ к сайтам кнопкой ниже."
    };
  }
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function extractPage(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, code: "NO_TAB", message: "Вкладка не найдена." };
  if (!isInjectable(tab.url)) {
    return {
      ok: false,
      code: "UNSUPPORTED_PAGE",
      message: "Эту страницу прочитать нельзя: " + String(tab.url || "").split(":")[0] + "://",
      hint: "Откройте обычную веб-страницу (http/https). Системные страницы Chrome и PDF-просмотрщик закрыты для расширений."
    };
  }
  if (/(\.|^)youtube\.com$|(\.|^)youtu\.be$/i.test(new URL(tab.url).hostname)) {
    const video = await extractYouTubeCaptions(tabId);
    if (video && video.ok) {
      return {
        ok: true,
        url: tab.url,
        title: video.title || tab.title || "YouTube",
        siteName: "YouTube",
        text: video.text,
        length: video.text.length,
        method: "youtube-captions",
        lang: video.lang || ""
      };
    }
  }
  const ready = await ensureContentScript(tabId);
  if (!ready.ok) return ready;

  let res;
  try {
    res = await withTimeout(sendToTab(tabId, { type: "EXTRACT_PAGE" }), 25000, "Страница не ответила за 25 секунд.");
  } catch (e) {
    return { ok: false, code: "NO_CONTENT", message: "Не удалось прочитать страницу: " + (e && e.message || e), hint: "Обновите вкладку (F5) и попробуйте снова." };
  }
  if (!res || !res.ok) {
    return { ok: false, code: "NO_CONTENT", message: (res && res.message) || "На странице нет текста.", hint: "Попробуйте другую страницу." };
  }
  return res;
}

async function extractYouTubeCaptions(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: "MAIN",
      func: async () => {
        const player = window.ytInitialPlayerResponse ||
          (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args &&
            JSON.parse(window.ytplayer.config.args.player_response || "null"));
        const tracks = player && player.captions &&
          player.captions.playerCaptionsTracklistRenderer &&
          player.captions.playerCaptionsTracklistRenderer.captionTracks;
        const visibleTranscript = () => {
          const segments = Array.from(document.querySelectorAll(
            "ytd-transcript-segment-renderer .segment-text, .ytd-transcript-segment-renderer .segment-text, [class*='transcript-segment']"
          ));
          const lines = segments.map((node) => node.textContent.trim()).filter(Boolean);
          return lines.length ? lines.join("\n") : "";
        };
        if (!Array.isArray(tracks) || !tracks.length) {
          const text = visibleTranscript();
          return text ? { ok: true, title: document.title, lang: "", text: text } : null;
        }

        const language = String(navigator.language || "en").split("-")[0].toLowerCase();
        const track = tracks.find((item) => String(item.languageCode || "").toLowerCase().startsWith(language)) ||
          tracks.find((item) => !item.kind) || tracks[0];
        const url = new URL(track.baseUrl);
        url.searchParams.set("fmt", "json3");
        let payload;
        try {
          const response = await fetch(url.href, { credentials: "include" });
          if (response.ok) payload = await response.json();
        } catch (error) {
          const text = visibleTranscript();
          if (text) return { ok: true, title: document.title, lang: track.languageCode || "", text: text };
        }
        const events = payload && Array.isArray(payload.events) ? payload.events : [];
        const lines = [];
        let length = 0;
        for (const event of events) {
          const text = (event.segs || []).map((segment) => segment.utf8 || "").join("")
            .replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
          if (!text || text === "\n") continue;
          const seconds = Math.floor((event.tStartMs || 0) / 1000);
          const stamp = String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
          lines.push("[" + stamp + "] " + text);
          length += text.length;
          if (length > 70000) break;
        }
        if (!lines.length) {
          const text = visibleTranscript();
          return text ? { ok: true, title: document.title, lang: track.languageCode || "", text: text } : null;
        }
        const details = player.videoDetails || {};
        return {
          ok: true,
          title: details.title || document.title,
          lang: track.languageCode || "",
          text: "Субтитры видео: " + (details.title || document.title) + "\nЯзык: " +
            (track.languageCode || "не указан") + "\n\n" + lines.join("\n")
        };
      }
    });
    const result = results && results[0] && results[0].result;
    return result && result.ok && result.text ? result : null;
  } catch (e) {
    console.warn("[ask-any-llm] Не удалось получить субтитры YouTube:", e);
    return null;
  }
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/* ------------------------------------------------------------------ */
/* Роутинг сообщений из UI                                             */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse, (e) => {
    sendResponse({ ok: false, message: String(e && e.message || e) });
  });
  return true; // ответ будет асинхронным
});

async function handleMessage(msg) {
  const type = msg && msg.type;
  switch (type) {
    case "PING":
      return { ok: true, ts: Date.now() };

    case "GET_SETTINGS":
      return { ok: true, settings: await getSettings() };

    case "SAVE_SETTINGS": {
      const settings = await saveSettings(msg.patch || {});
      return { ok: true, settings: settings };
    }

    case "GET_MODELS": {
      const models = await getModels(!!msg.force);
      return { ok: true, models: models };
    }

    case "EXTRACT_PAGE":
      return await extractPage(msg.tabId);

    case "SEARCH_WEB":
      return await searchWeb(msg.query, !!msg.includeImage, msg.language);

    case "GET_SELECTION": {
      const ready = await ensureContentScript(msg.tabId);
      if (!ready.ok) return ready;
      const res = await sendToTab(msg.tabId, { type: "GET_SELECTION" }).catch(() => null);
      return res && res.ok ? res : { ok: false, code: "NO_CONTENT", message: "Выделение не найдено." };
    }

    case "CHECK_OLLAMA": {
      const settings = await getSettings();
      return await L.checkOllama(msg.url || settings.ollamaUrl);
    }

    case "OPEN_OPTIONS":
      chrome.runtime.openOptionsPage();
      return { ok: true };

    case "OPEN_SIDE_PANEL":
      try { await chrome.sidePanel.open({ tabId: msg.tabId }); return { ok: true }; }
      catch (e) { return { ok: false, message: String(e && e.message || e) }; }

    case "CONSUME_PENDING": {
      const key = PENDING_PREFIX + msg.tabId;
      const stored = await chrome.storage.local.get(key);
      const task = stored[key] || null;
      if (task) await chrome.storage.local.remove(key);
      return { ok: true, task: task };
    }

    default:
      return { ok: false, message: "Неизвестный тип сообщения: " + type };
  }
}

/* ------------------------------------------------------------------ */
/* Стриминг в side panel через port                                    */
/* ------------------------------------------------------------------ */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "llm-stream") return;
  const owned = new Set();

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "PING") { // держит service worker живым во время долгого запроса
      safePost(port, { type: "PONG", ts: Date.now() });
      return;
    }
    if (msg.type === "ABORT") {
      const entry = activeRequests.get(msg.requestId);
      if (entry) { entry.aborted = true; entry.ctrl.abort(); }
      return;
    }
    if (msg.type === "START") {
      owned.add(msg.requestId);
      if (queueDepth > 0) safePost(port, { type: "STATUS", requestId: msg.requestId, text: "В очереди: другой запрос ещё идёт…", waiting: true });
      queueDepth++;
      enqueue(() => runRequest(port, msg))
        .catch(() => {})
        .finally(() => { queueDepth = Math.max(0, queueDepth - 1); });
    }
  });

  port.onDisconnect.addListener(() => {
    for (const id of owned) {
      const entry = activeRequests.get(id);
      if (entry) { entry.aborted = true; entry.ctrl.abort(); }
    }
  });
});

function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

function safePost(port, payload) {
  try { port.postMessage(payload); } catch (e) { /* панель закрыта */ }
}

async function runRequest(port, req) {
  const settings = await getSettings();
  const provider = req.provider || settings.provider;
  let model = req.model || (provider === "ollama" ? settings.ollamaModel : settings.pollinationsModel);
  const requestId = req.requestId;
  const ctrl = new AbortController();
  const entry = { ctrl: ctrl, aborted: false, timedOut: false };
  activeRequests.set(requestId, entry);

  const timer = setTimeout(() => { entry.timedOut = true; ctrl.abort(); }, settings.requestTimeoutSec * 1000);
  const startedAt = Date.now();
  let note = "";
  let substituted = false;

  const post = (payload) => safePost(port, Object.assign({ requestId: requestId }, payload));

  try {
    if (provider === "ollama") {
      post({ type: "STATUS", text: "Ollama: " + model + "…" });
      const allowed = await hasOriginPermission(settings.ollamaUrl);
      if (!allowed) {
        throw new L.ApiError("Нет разрешения на адрес " + settings.ollamaUrl, {
          provider: "ollama",
          code: "NO_HOST_PERMISSION",
          hint: "Откройте настройки расширения и нажмите «Сохранить» — Chrome спросит доступ к этому адресу."
        });
      }
      const out = await L.ollamaChat({
        url: settings.ollamaUrl,
        model: model,
        messages: req.messages,
        stream: settings.stream,
        signal: ctrl.signal,
        onEvent: (ev) => post(ev)
      });
      post({ type: "DONE", text: out.text, reasoning: out.reasoning, model: out.model, provider: "ollama", note: note, ms: Date.now() - startedAt });
      return;
    }

    // --- Pollinations ---
    let attempts = 0;
    let waited = 0;
    while (true) {
      attempts++;
      const models = await getModels();
      const resolved = L.resolveModel(model, models, settings.autoFallback);
      if (resolved.reason === "unavailable") {
        throw new L.ApiError("Модель «" + model + "» недоступна в анонимном доступе Pollinations.", {
          provider: "pollinations",
          code: "MODEL_UNAVAILABLE",
          hint: "Выберите модель openai (GPT-OSS 20B) или включите автозамену в настройках."
        });
      }
      if (resolved.substituted && !substituted) {
        substituted = true;
        note = resolved.reason;
        post({ type: "META", model: resolved.model, note: note });
      }
      if (resolved.model) model = resolved.model; // алиас → каноническое имя модели

      post({ type: "STATUS", text: attempts > 1 ? "Повтор " + attempts + " · " + model + "…" : "Думаю · " + model + "…" });

      try {
        const out = await L.pollinationsChat({
          messages: req.messages,
          model: model,
          stream: settings.stream,
          signal: ctrl.signal,
          onEvent: (ev) => post(ev)
        });
        post({
          type: "DONE", text: out.text, reasoning: out.reasoning, model: out.model || model,
          provider: "pollinations", note: note, ms: Date.now() - startedAt
        });
        return;
      } catch (e) {
        if (entry.aborted || entry.timedOut || (e && e.name === "AbortError")) throw e;

        // 402/429: бесплатный слот занят — ждём Retry-After и повторяем
        if (L.isRateLimited(e.status) && attempts <= 6 && waited < MAX_TOTAL_WAIT_SEC) {
          const wait = Math.max(3, Math.min(90, L.retryAfterSeconds(e, 45)));
          for (let left = wait; left > 0; left--) {
            post({ type: "STATUS", text: "Бесплатный лимит Pollinations. Ждём свободный слот: " + left + " с", waiting: true });
            await L.sleep(1000, ctrl.signal);
          }
          waited += wait;
          continue;
        }

        // 404: модели нет в free-тире — берём доступную
        if (L.isModelNotFound(e.status, e.message, e.code) && settings.autoFallback && !substituted) {
          const fresh = await getModels(true);
          const sub = L.firstAnonymousModel(fresh);
          if (sub && sub.id !== model) {
            substituted = true;
            note = "Модель «" + model + "» недоступна без API-ключа. Ответ дала «" + sub.id + "».";
            model = sub.id;
            post({ type: "META", model: model, note: note });
            continue;
          }
        }
        throw e;
      }
    }
  } catch (e) {
    const info = describeError(e, provider, settings, entry);
    post(Object.assign({ type: "ERROR", ms: Date.now() - startedAt, model: model, provider: provider, note: note }, info));
  } finally {
    clearTimeout(timer);
    activeRequests.delete(requestId);
  }
}

async function hasOriginPermission(url) {
  try {
    const origin = new URL(url).origin + "/*";
    return await chrome.permissions.contains({ origins: [origin] });
  } catch (e) {
    return false;
  }
}

// Превращаем ошибку в понятный текст + подсказку + возможное действие
function describeError(e, provider, settings, entry) {
  const raw = String((e && e.message) || e || "Неизвестная ошибка");
  if (entry && entry.aborted) return { code: "ABORTED", message: "Остановлено пользователем.", hint: "" };
  if (entry && entry.timedOut) {
    return {
      code: "TIMEOUT",
      message: "Модель не ответила за " + settings.requestTimeoutSec + " секунд.",
      hint: provider === "ollama" ? "Локальная модель может грузиться в память — попробуйте ещё раз." : "Pollinations иногда тормозит под нагрузкой. Повторите запрос или выберите другую модель."
    };
  }
  if (e && e.name === "AbortError") return { code: "ABORTED", message: "Запрос прерван.", hint: "" };

  const status = e && e.status;
  if (provider === "ollama") {
    if (e && e.code === "NO_HOST_PERMISSION") return { code: e.code, message: raw, hint: e.hint || "" };
    if (L.isModelNotFound(status, raw, e && e.code)) {
      return {
        code: "OLLAMA_NO_MODEL",
        message: "В Ollama нет модели «" + settings.ollamaModel + "».",
        hint: "Выполните в терминале: ollama pull " + settings.ollamaModel,
        canSwitchToPollinations: true
      };
    }
    if (!status) {
      return {
        code: "OLLAMA_DOWN",
        message: L.networkErrorMessage(e, "ollama", settings.ollamaUrl),
        hint: "Запустите сервер: ollama serve. Проверьте адрес в настройках (по умолчанию http://localhost:11434).",
        canSwitchToPollinations: true
      };
    }
    return { code: "OLLAMA_HTTP_" + status, message: "Ollama: " + raw, hint: "Проверьте модель и адрес в настройках.", canSwitchToPollinations: true };
  }

  if (L.isRateLimited(status)) {
    return {
      code: "RATE_LIMIT",
      message: "Бесплатный лимит Pollinations исчерпан (HTTP " + status + ").",
      hint: "Анонимные запросы идут по одному с паузой ~45 секунд. Расширение уже ждало слот — повторите через минуту или переключитесь на локальную Ollama.",
      canSwitchToOllama: true
    };
  }
  if (L.isModelNotFound(status, raw, e && e.code)) {
    return { code: "MODEL_UNAVAILABLE", message: "Модель недоступна без API-ключа: " + raw, hint: "Выберите openai (GPT-OSS 20B) — она работает анонимно.", canSwitchModel: "openai" };
  }
  if (status === 401 || status === 403) {
    return { code: "FORBIDDEN", message: "Pollinations отклонил запрос (HTTP " + status + ").", hint: "Сервис может требовать ключ для этой модели. Выберите openai." };
  }
  if (status >= 500) {
    return { code: "SERVER", message: "Pollinations временно недоступен (HTTP " + status + ").", hint: "Это best-effort сервис без гарантий аптайма. Повторите через минуту.", canSwitchToOllama: true };
  }
  if (!status) {
    return { code: "NETWORK", message: L.networkErrorMessage(e, "pollinations"), hint: "Проверьте соединение, отключите блокировщики для text.pollinations.ai или переключитесь на Ollama.", canSwitchToOllama: true };
  }
  return { code: "HTTP_" + status, message: raw, hint: "Повторите запрос или выберите другую модель." };
}

/* ------------------------------------------------------------------ */
/* Уборка истории                                                      */
/* ------------------------------------------------------------------ */

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove([CHAT_PREFIX + tabId, CHAT_HISTORY_PREFIX + tabId, PENDING_PREFIX + tabId]).catch(() => {});
});

// Чистим истории вкладок, которых уже нет, и всё старше 7 дней
async function pruneOldChats() {
  try {
    const all = await chrome.storage.local.get(null);
    const tabs = await chrome.tabs.query({});
    const alive = new Set(tabs.map((t) => String(t.id)));
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const remove = [];
    const updates = {};
    for (const key of Object.keys(all)) {
      if (key.startsWith(CHAT_HISTORY_PREFIX)) {
        const id = key.slice(CHAT_HISTORY_PREFIX.length);
        const history = Array.isArray(all[key]) ? all[key] : [];
        const fresh = history.filter((chat) => chat && chat.updatedAt >= cutoff);
        if (!alive.has(id) || !fresh.length) remove.push(key);
        else if (fresh.length !== history.length) updates[key] = fresh;
        continue;
      }
      if (!key.startsWith(CHAT_PREFIX)) continue;
      const id = key.slice(CHAT_PREFIX.length);
      const value = all[key];
      const stale = !value || !value.updatedAt || value.updatedAt < cutoff;
      if (!alive.has(id) || stale) remove.push(key);
    }
    if (remove.length) await chrome.storage.local.remove(remove);
    if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  } catch (e) { /* не критично */ }
}
