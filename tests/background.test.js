/*
 * Интеграционный тест background.js с заглушкой chrome.* и mock fetch.
 * Проверяет меню, задания для панели, очередь, стриминг, фолбэк модели, ретрай 402, ошибки Ollama.
 * Запуск: node tests/background.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..", "ask-any-llm");

/* ---------------- заглушка chrome.* ---------------- */

function listener() {
  const fns = [];
  return {
    addListener: (fn) => fns.push(fn),
    removeListener: (fn) => { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
    fire: (...args) => fns.map((f) => f(...args)),
    count: () => fns.length,
    fns
  };
}

function makeStorageArea() {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys == null) return Object.assign({}, data);
      if (typeof keys === "string") return keys in data ? { [keys]: data[keys] } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in data) out[k] = data[k];
        return out;
      }
      const out = {};
      for (const k of Object.keys(keys)) out[k] = k in data ? data[k] : keys[k];
      return out;
    },
    async set(obj) { Object.assign(data, JSON.parse(JSON.stringify(obj))); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
    async clear() { for (const k of Object.keys(data)) delete data[k]; }
  };
}

const menuItems = new Map();
const calls = { sidePanelOpen: [], optionsOpened: 0, executedScripts: [] };

const chromeStub = {
  storage: {
    sync: makeStorageArea(),
    local: makeStorageArea(),
    session: makeStorageArea(),
    onChanged: listener()
  },
  contextMenus: {
    create: (opts) => {
      if (menuItems.has(opts.id)) throw new Error("duplicate menu id: " + opts.id);
      menuItems.set(opts.id, opts);
      return opts.id;
    },
    removeAll: async () => { menuItems.clear(); },
    onClicked: listener()
  },
  runtime: {
    onInstalled: listener(),
    onStartup: listener(),
    onMessage: listener(),
    onConnect: listener(),
    sendMessage: async () => undefined,
    openOptionsPage: () => { calls.optionsOpened++; }
  },
  sidePanel: {
    setPanelBehavior: async () => {},
    open: async (opts) => { calls.sidePanelOpen.push(opts); }
  },
  tabs: {
    get: async (id) => ({ id, url: "https://example.com/article", title: "Статья" }),
    query: async () => [{ id: 1, url: "https://example.com/article" }],
    sendMessage: async () => ({ ok: true, text: "Полный текст выделения\nс переносом строки" }),
    onRemoved: listener(),
    onActivated: listener(),
    onUpdated: listener()
  },
  scripting: {
    executeScript: async (opts) => { calls.executedScripts.push(opts); return [{ result: true }]; }
  },
  permissions: {
    contains: async () => true,
    request: async () => true
  }
};

/* ---------------- mock fetch ---------------- */

const liveModelsPayload = [{
  name: "openai-fast",
  description: "GPT-OSS 20B Reasoning LLM (OVH)",
  tier: "anonymous",
  aliases: ["openai", "gpt-oss", "gpt-oss-20b"],
  reasoning: true
}];

function sse(chunks) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); }
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

let fetchPlan = [];
let emptyBingResults = false;
const fetchLog = [];
global.fetch = async (url, opts) => {
  fetchLog.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
  if (String(url).endsWith("/models")) {
    return new Response(JSON.stringify(liveModelsPayload), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (String(url).startsWith("https://www.bing.com/search?format=rss")) {
    if (emptyBingResults || String(url).includes("setmkt=ru-RU")) {
      return new Response("<rss><channel></channel></rss>", { status: 200, headers: { "Content-Type": "application/rss+xml" } });
    }
    return new Response(
      "<rss><item><title>Товар &amp; цена</title><link>https://shop.example/item</link><description>Цена 12 000 ₽</description><pubDate>Mon, 16 Nov 2026 14:23:00 GMT</pubDate></item></rss>",
      { status: 200, headers: { "Content-Type": "application/rss+xml" } }
    );
  }
  if (String(url).startsWith("https://www.bing.com/images/async")) {
    return new Response(
      '<a href="/images/search?mediaurl=https%3A%2F%2Fimages.example%2Fitem1.jpg&amp;cdnurl=x">' +
      '<a href="/images/search?mediaurl=https%3A%2F%2Fimages.example%2Fitem2.jpg&amp;cdnurl=x">' +
      '<a href="/images/search?mediaurl=https%3A%2F%2Fimages.example%2Fitem3.jpg&amp;cdnurl=x">',
      { status: 200, headers: { "Content-Type": "text/html" } }
    );
  }
  const step = fetchPlan.shift();
  if (!step) throw new Error("mock fetch: нет запланированного ответа для " + url);
  return step(url, opts);
};

/* ---------------- загрузка background.js ---------------- */

global.self = global;
global.chrome = chromeStub;
global.importScripts = (file) => {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), "utf8"), { filename: file });
};
vm.runInThisContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), { filename: "background.js" });

const L = global.AskLLM;

function send(msg) {
  return new Promise((resolve) => {
    chromeStub.runtime.onMessage.fns[0](msg, {}, resolve);
  });
}

function openPort() {
  const events = [];
  const port = {
    name: "llm-stream",
    postMessage: (m) => events.push(m),
    onMessage: listener(),
    onDisconnect: listener()
  };
  chromeStub.runtime.onConnect.fns[0](port);
  return { port, events };
}

function waitFor(events, type, timeoutMs) {
  const limit = timeoutMs || 15000;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = events.find((e) => e.type === type);
      if (found) return resolve(found);
      if (Date.now() - started > limit) return reject(new Error("не дождались " + type + "; события: " + JSON.stringify(events).slice(0, 500)));
      setTimeout(tick, 20);
    };
    tick();
  });
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) { console.error("  FAIL " + name + "\n       " + (e && e.stack || e)); process.exitCode = 1; }
}

(async function run() {
  console.log("\n== background.js (chrome stub + mock fetch) ==");

  await test("onInstalled: дефолтные настройки и контекстное меню", async () => {
    await chromeStub.runtime.onInstalled.fns[0]({ reason: "install" });
    await new Promise((r) => setTimeout(r, 150));
    const stored = await chromeStub.storage.sync.get("settings");
    assert.strictEqual(stored.settings.provider, "pollinations");
    assert.strictEqual(stored.settings.pollinationsModel, "openai-fast");
    const ids = [...menuItems.keys()];
    for (const id of ["ask", "analyze-page"]) {
      assert.ok(ids.includes(id), "нет пункта меню " + id);
    }
    assert.strictEqual(ids.length, 2, "контекстное меню должно содержать только два простых действия");
    assert.deepStrictEqual(menuItems.get("ask").contexts, ["selection"]);
    assert.strictEqual(menuItems.get("ask").title, "Спросить");
    assert.deepStrictEqual(menuItems.get("analyze-page").contexts, ["page"]);
  });

  await test("GET_SETTINGS / GET_MODELS", async () => {
    const s = await send({ type: "GET_SETTINGS" });
    assert.ok(s.ok && s.settings.stream === true);
    const m = await send({ type: "GET_MODELS" });
    assert.strictEqual(m.models[0].id, "openai-fast");
  });

  await test("SEARCH_WEB retries another market and returns three product images", async () => {
    const fetchStart = fetchLog.length;
    const result = await send({ type: "SEARCH_WEB", query: "товар цена", includeImage: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.results[0].title, "Товар & цена");
    assert.strictEqual(result.results[0].url, "https://shop.example/item");
    assert.strictEqual(result.results[0].date, "Mon, 16 Nov 2026 14:23:00 GMT");
    assert.deepStrictEqual(result.imageUrls, [
      "https://images.example/item1.jpg",
      "https://images.example/item2.jpg",
      "https://images.example/item3.jpg"
    ]);
    const searchUrls = fetchLog.slice(fetchStart).map((entry) => entry.url).filter((url) => url.startsWith("https://www.bing.com/search?format=rss"));
    assert.ok(searchUrls[0].includes("setmkt=ru-RU"));
    assert.ok(searchUrls[1].includes("setmkt=en-US"));
    assert.ok(fetchLog.slice(fetchStart).some((entry) => entry.url.startsWith("https://www.bing.com/images/async")));
    assert.ok(result.searchedAt > 0);
  });

  await test("SEARCH_WEB preserves an image when text search has no results", async () => {
    emptyBingResults = true;
    const result = await send({ type: "SEARCH_WEB", query: "Technics EAH-A800", includeImage: true });
    emptyBingResults = false;
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.results, []);
    assert.strictEqual(result.imageUrls.length, 3);
  });

  await test("клик «Спросить»: панель открыта, задание использует настройки и полное выделение", async () => {
    chromeStub.contextMenus.onClicked.fire(
      { menuItemId: "ask", selectionText: "короткое выделение" },
      { id: 7, url: "https://example.com/article" }
    );
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(calls.sidePanelOpen.some((c) => c.tabId === 7), "side panel не открыт");
    const stored = await chromeStub.storage.local.get("pending_7");
    assert.strictEqual(stored["pending_7"].type, "ask");
    assert.strictEqual(stored["pending_7"].provider, "pollinations");
    assert.strictEqual(stored["pending_7"].model, "openai-fast");
    assert.strictEqual(stored["pending_7"].webSearch, true);
    assert.ok(stored["pending_7"].text.includes("переносом строки"));
    const consumed = await send({ type: "CONSUME_PENDING", tabId: 7 });
    assert.strictEqual(consumed.task.type, "ask");
    const again = await send({ type: "CONSUME_PENDING", tabId: 7 });
    assert.strictEqual(again.task, null, "задание должно выдаваться один раз");
  });

  await test("клик «Анализировать страницу» создаёт задание analyze", async () => {
    chromeStub.contextMenus.onClicked.fire({ menuItemId: "analyze-page" }, { id: 8 });
    await new Promise((r) => setTimeout(r, 120));
    const stored = await chromeStub.storage.local.get("pending_8");
    assert.strictEqual(stored["pending_8"].type, "analyze");
    await send({ type: "CONSUME_PENDING", tabId: 8 });
  });

  await test("стриминг: delta → DONE, модель openai", async () => {
    fetchPlan = [() => sse([
      'data: {"choices":[{"delta":{"reasoning":"думаю"}}],"model":"gpt-oss-20b"}\n\n',
      'data: {"choices":[{"delta":{"content":"При"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"вет!"}}]}\n\n',
      "data: [DONE]\n\n"
    ])];
    const { port, events } = openPort();
    port.onMessage.fire({ type: "START", requestId: "r1", provider: "pollinations", model: "openai", messages: [{ role: "user", content: "привет" }] });
    const done = await waitFor(events, "DONE");
    assert.strictEqual(done.text, "Привет!");
    assert.strictEqual(done.reasoning, "думаю");
    assert.strictEqual(events.filter((e) => e.type === "delta").length, 2);
    assert.strictEqual(fetchLog[fetchLog.length - 1].body.model, "openai-fast"); // алиас разрешён в реальное имя
    assert.strictEqual(fetchLog[fetchLog.length - 1].body.stream, true);
  });

  await test("404 недоступной модели → автозамена на openai-fast + META", async () => {
    fetchPlan = [
      () => new Response(JSON.stringify({ status: 404, error: { code: "NOT_FOUND", message: 'Model "mistral" isn\'t on the Classic API.' } }), { status: 404, headers: { "Content-Type": "application/json" } }),
      () => sse(['data: {"choices":[{"delta":{"content":"Ответ после замены"}}]}\n\n', "data: [DONE]\n\n"])
    ];
    // ломаем кэш моделей, чтобы первый запрос ушёл именно с mistral
    await chromeStub.storage.local.set({ modelsCache: { ts: Date.now(), models: [], ok: false } });
    const { port, events } = openPort();
    port.onMessage.fire({ type: "START", requestId: "r2", provider: "pollinations", model: "mistral", messages: [] });
    const done = await waitFor(events, "DONE", 20000);
    assert.strictEqual(done.text, "Ответ после замены");
    const meta = events.find((e) => e.type === "META");
    assert.ok(meta && meta.model === "openai-fast", "не было META о замене");
    assert.ok(/mistral/.test(meta.note));
  });

  await test("402 + Retry-After → ожидание со статусом и повтор", async () => {
    fetchPlan = [
      () => new Response("Free limit reached", { status: 402, headers: { "Retry-After": "3" } }),
      () => sse(['data: {"choices":[{"delta":{"content":"После паузы"}}]}\n\n', "data: [DONE]\n\n"])
    ];
    const { port, events } = openPort();
    port.onMessage.fire({ type: "START", requestId: "r3", provider: "pollinations", model: "openai", messages: [] });
    const done = await waitFor(events, "DONE", 20000);
    assert.strictEqual(done.text, "После паузы");
    const waiting = events.filter((e) => e.type === "STATUS" && e.waiting);
    assert.ok(waiting.length >= 3, "не было обратного отсчёта");
    assert.ok(/Ждём свободный слот/.test(waiting[0].text));
  });

  await test("Ollama не запущена → OLLAMA_DOWN + предложение Pollinations", async () => {
    fetchPlan = [() => { throw new TypeError("fetch failed"); }];
    const { port, events } = openPort();
    port.onMessage.fire({ type: "START", requestId: "r4", provider: "ollama", model: "qwen2.5", messages: [] });
    const err = await waitFor(events, "ERROR");
    assert.strictEqual(err.code, "OLLAMA_DOWN");
    assert.strictEqual(err.canSwitchToPollinations, true);
    assert.ok(/ollama serve/.test(err.hint));
    assert.ok(/localhost:11434/.test(err.message));
  });

  await test("Ollama отвечает: NDJSON стрим", async () => {
    fetchPlan = [(url, opts) => {
      assert.ok(url.endsWith("/api/chat"));
      assert.strictEqual(JSON.parse(opts.body).model, "qwen2.5");
      const enc = new TextEncoder();
      return new Response(new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('{"message":{"content":"Локально"},"done":false}\n'));
          c.enqueue(enc.encode('{"message":{"content":" и приватно"},"done":true}\n'));
          c.close();
        }
      }), { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    }];
    const { port, events } = openPort();
    port.onMessage.fire({ type: "START", requestId: "r5", provider: "ollama", model: "qwen2.5", messages: [] });
    const done = await waitFor(events, "DONE");
    assert.strictEqual(done.text, "Локально и приватно");
    assert.strictEqual(done.provider, "ollama");
  });

  await test("ABORT прерывает запрос", async () => {
    fetchPlan = [() => new Promise((resolve, reject) => {
      // «вечный» стрим: реагируем на abort
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(c) { c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Начало"}}]}\n\n')); }
      });
      const res = new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      resolve(res);
    })];
    const { port, events } = openPort();
    port.onMessage.fire({ type: "START", requestId: "r6", provider: "pollinations", model: "openai", messages: [] });
    await new Promise((r) => setTimeout(r, 200));
    port.onMessage.fire({ type: "ABORT", requestId: "r6" });
    const err = await waitFor(events, "ERROR", 8000);
    assert.strictEqual(err.code, "ABORTED");
  });

  await test("EXTRACT_PAGE: системную страницу читать нельзя", async () => {
    const originalGet = chromeStub.tabs.get;
    chromeStub.tabs.get = async (id) => ({ id, url: "chrome://extensions" });
    const res = await send({ type: "EXTRACT_PAGE", tabId: 3 });
    chromeStub.tabs.get = originalGet;
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, "UNSUPPORTED_PAGE");
  });

  await test("EXTRACT_PAGE: контент-скрипт внедряется, текст возвращается", async () => {
    const originalSend = chromeStub.tabs.sendMessage;
    let first = true;
    chromeStub.tabs.sendMessage = async (tabId, msg) => {
      if (msg.type === "PING" && first) { first = false; throw new Error("no receiver"); }
      if (msg.type === "PING") return { ok: true };
      if (msg.type === "EXTRACT_PAGE") return { ok: true, url: "https://example.com/a", title: "Заголовок", text: "Текст статьи", length: 12, method: "readability" };
      return { ok: true };
    };
    const res = await send({ type: "EXTRACT_PAGE", tabId: 4 });
    chromeStub.tabs.sendMessage = originalSend;
    assert.ok(res.ok, JSON.stringify(res));
    assert.strictEqual(res.title, "Заголовок");
    assert.ok(calls.executedScripts.some((s) => s.target.tabId === 4 && s.files.includes("readability/Readability.js")));
  });

  await test("EXTRACT_PAGE: YouTube возвращает субтитры с таймкодами", async () => {
    const originalGet = chromeStub.tabs.get;
    const originalExecute = chromeStub.scripting.executeScript;
    chromeStub.tabs.get = async (id) => ({ id, url: "https://www.youtube.com/watch?v=abc", title: "Видео" });
    chromeStub.scripting.executeScript = async (opts) => {
      assert.strictEqual(opts.world, "MAIN");
      return [{ result: { ok: true, title: "Байкал", lang: "ru", text: "[00:04] Текст субтитров видео" } }];
    };
    const res = await send({ type: "EXTRACT_PAGE", tabId: 9 });
    chromeStub.tabs.get = originalGet;
    chromeStub.scripting.executeScript = originalExecute;
    assert.strictEqual(res.method, "youtube-captions");
    assert.strictEqual(res.title, "Байкал");
    assert.ok(res.text.includes("[00:04] Текст субтитров"));
  });

  await test("смена провайдера сохраняет одно простое действие контекстного меню", async () => {
    const res = await send({ type: "SAVE_SETTINGS", patch: { provider: "ollama", ollamaModel: "llama3.1" } });
    assert.strictEqual(res.settings.provider, "ollama");
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(menuItems.has("ask"));
    assert.strictEqual([...menuItems.keys()].some((id) => id.startsWith("ask|")), false);
    await send({ type: "SAVE_SETTINGS", patch: { provider: "pollinations", ollamaModel: "qwen2.5" } });
  });

  await test("закрытие вкладки удаляет её историю", async () => {
    await chromeStub.storage.local.set({
      chat_42: { messages: [] },
      chat_history_42: [{ chatId: "old-chat", updatedAt: Date.now() }],
      pending_42: { type: "ask" }
    });
    chromeStub.tabs.onRemoved.fire(42);
    await new Promise((r) => setTimeout(r, 80));
    const left = await chromeStub.storage.local.get(["chat_42", "chat_history_42", "pending_42"]);
    assert.deepStrictEqual(left, {});
  });

  await test("очистка сохраняет историю чатов открытых вкладок", async () => {
    await chromeStub.storage.local.set({
      chat_history_1: [{ chatId: "recent", updatedAt: Date.now(), messages: [] }],
      chat_history_2: [{ chatId: "closed-tab", updatedAt: Date.now(), messages: [] }]
    });
    await chromeStub.runtime.onInstalled.fns[0]({ reason: "install" });
    await new Promise((r) => setTimeout(r, 80));
    const histories = await chromeStub.storage.local.get(["chat_history_1", "chat_history_2"]);
    assert.strictEqual(histories.chat_history_1[0].chatId, "recent");
    assert.strictEqual(histories.chat_history_2, undefined);
  });

  console.log("\nПройдено тестов: " + passed + "\n");
})();
