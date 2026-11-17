/*
 * E2E-тест связки sidepanel.js <-> background.js в jsdom.
 * chrome.* — заглушка, fetch — mock. Проверяет реальный путь: ввод → стрим → пузырь ответа,
 * анализ страницы → чипсы → клик, ошибка Ollama → кнопка переключения, очистка истории.
 * Запуск: npm i jsdom && node tests/e2e.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch (e) { console.log("SKIP: нужен jsdom (npm i jsdom)."); process.exit(0); }

const ROOT = path.join(__dirname, "..", "ask-any-llm");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

/* ---------- общие заглушки ---------- */

function listener() {
  const fns = [];
  return {
    addListener: (fn) => fns.push(fn),
    removeListener: () => {},
    fire: (...a) => fns.forEach((f) => f(...a)),
    fns
  };
}

function storageArea() {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys == null) return Object.assign({}, data);
      if (typeof keys === "string") return keys in data ? { [keys]: data[keys] } : {};
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) { Object.assign(data, JSON.parse(JSON.stringify(obj))); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; }
  };
}

const menu = new Map();
const panelRuntimeMessages = listener();
const secondTab = { id: 2, url: "https://example.com/second", title: "Вторая статья", status: "complete" };

const bgChrome = {
  storage: { sync: storageArea(), local: storageArea(), session: storageArea(), onChanged: listener() },
  contextMenus: {
    create: (o) => { if (menu.has(o.id)) throw new Error("dup id " + o.id); menu.set(o.id, o); },
    removeAll: async () => menu.clear(),
    onClicked: listener()
  },
  runtime: {
    onInstalled: listener(), onStartup: listener(), onMessage: listener(), onConnect: listener(),
    sendMessage: async (m) => { panelRuntimeMessages.fire(m); return undefined; },
    openOptionsPage: () => {}
  },
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  tabs: {
    get: async (id) => id === 2 ? secondTab : ({ id, url: "https://example.com/nerpa", title: "Нерпа Байкала" }),
    query: async (query) => query && query.active
      ? [{ id: 1, url: "https://example.com/nerpa", title: "Нерпа Байкала" }]
      : [{ id: 1, url: "https://example.com/nerpa", title: "Нерпа Байкала" }, secondTab],
    sendMessage: async (tabId, msg) => {
      if (msg.type === "PING") return { ok: true };
      if (msg.type === "GET_SELECTION") return { ok: true, text: "Кто такая байкальская нерпа?" };
      if (msg.type === "EXTRACT_PAGE") {
        if (tabId === 2) {
          return {
            ok: true, url: secondTab.url, title: secondTab.title,
            text: "Вторая статья рассказывает о сохранении природы и биоразнообразии. ".repeat(20),
            length: 1400, method: "readability"
          };
        }
        return {
          ok: true, url: "https://example.com/nerpa", title: "Нерпа Байкала",
          text: "Байкальская нерпа — эндемик озера Байкал. Зимой она строит снежные логова. ".repeat(20),
          length: 1500, method: "readability", siteName: "example.com", lang: "ru"
        };
      }
      return { ok: true };
    },
    onRemoved: listener(), onActivated: listener(), onUpdated: listener()
  },
  scripting: { executeScript: async () => [{ result: true }] },
  permissions: { contains: async () => true, request: async () => true }
};

/* ---------- mock fetch ---------- */

const modelsPayload = [{ name: "openai-fast", description: "GPT-OSS 20B", tier: "anonymous", aliases: ["openai"] }];
let plan = [];
let webSearchFailure = false;
let webSearchUnknown = false;
let lastRequestBody = null;
function sse(chunks) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { chunks.forEach((s) => c.enqueue(enc.encode(s))); c.close(); } }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
function answer(text) {
  return () => sse(['data: {"choices":[{"delta":{"content":' + JSON.stringify(text) + '}}],"model":"gpt-oss-20b"}\n\n', "data: [DONE]\n\n"]);
}
global.fetch = async (url, opts) => {
  if (String(url).endsWith("/models")) return new Response(JSON.stringify(modelsPayload), { status: 200, headers: { "Content-Type": "application/json" } });
  if (String(url).startsWith("https://www.bing.com/search?format=rss")) {
    if (webSearchFailure) return new Response("Search unavailable", { status: 503 });
    return new Response(
      "<rss><item><title>Статья о нерпе</title><link>https://example.com/nerpa</link><description>Сведения о байкальской нерпе.</description></item></rss>",
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
  const step = plan.shift();
  if (!step) throw new Error("mock fetch: нет ответа для " + url);
  lastRequestBody = opts && opts.body ? JSON.parse(opts.body) : null;
  return step(url);
};

/* ---------- загружаем background ---------- */
global.self = global;
global.chrome = bgChrome;
global.importScripts = (f) => vm.runInThisContext(read(f), { filename: f });
vm.runInThisContext(read("background.js"), { filename: "background.js" });

/* ---------- загружаем панель в jsdom ---------- */
const html = read("sidepanel.html").replace(/<script src="[^"]+"><\/script>/g, "");
const dom = new JSDOM(html, { url: "chrome-extension://test/sidepanel.html", runScripts: "dangerously", pretendToBeVisual: true });
const win = dom.window;

win.chrome = {
  runtime: {
    sendMessage: (msg) => new Promise((res) => {
      if (webSearchUnknown && msg.type === "SEARCH_WEB") {
        res({ ok: false, message: "Неизвестный тип сообщения: SEARCH_WEB" });
        return;
      }
      bgChrome.runtime.onMessage.fns[0](msg, {}, res);
    }),
    onMessage: panelRuntimeMessages,
    connect: ({ name }) => {
      const panelPort = { postMessage: (m) => setTimeout(() => bgPort.onMessage.fire(m), 0), onMessage: listener(), onDisconnect: listener() };
      const bgPort = { name, postMessage: (m) => setTimeout(() => panelPort.onMessage.fire(m), 0), onMessage: listener(), onDisconnect: listener() };
      bgChrome.runtime.onConnect.fns[0](bgPort);
      return panelPort;
    }
  },
  storage: bgChrome.storage,
  tabs: bgChrome.tabs,
  permissions: bgChrome.permissions
};
async function setSettings(patch) {
  const result = await win.chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", patch: patch });
  panelRuntimeMessages.fire({ type: "SETTINGS_CHANGED", settings: result.settings });
}

win.eval(read("shared.js"));
win.eval(read("sidepanel.js"));

const doc = win.document;
const $ = (id) => doc.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, limit) {
  const start = Date.now();
  while (Date.now() - start < (limit || 8000)) {
    if (await fn()) return true;
    await wait(25);
  }
  return false;
}
const bubbles = () => [...doc.querySelectorAll(".msg")];
const lastAssistant = () => {
  const list = [...doc.querySelectorAll(".msg.assistant .bubble")];
  return list[list.length - 1];
};

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) { console.error("  FAIL " + name + "\n       " + (e && e.stack || e)); process.exitCode = 1; }
}

(async function run() {
  console.log("\n== E2E: панель + background (jsdom) ==");
  await bgChrome.runtime.onInstalled.fns[0]({ reason: "install" });
  await until(() => doc.querySelectorAll(".chip").length === 3);

  await test("инициализация: модель выбирается в настройках, панель компактная", async () => {
    assert.strictEqual($("model"), null);
    assert.strictEqual($("provider-hint").textContent, "FREE");
    assert.strictEqual(doc.querySelectorAll(".chip").length, 3, "вопросы должны появиться без отдельного анализа");
    assert.ok(doc.querySelector(".brand").textContent.includes("ASK AI by 4elobrek9"));
    assert.strictEqual($("theme").tagName, "BUTTON");
    assert.strictEqual(doc.documentElement.dataset.theme, "light");
    assert.strictEqual($("input").placeholder, "Спросите что-нибудь...");
  });

  await test("анимированная кнопка сохраняет тему в настройках", async () => {
    $("theme").click();
    assert.ok(await until(async () => {
      const current = await bgChrome.storage.sync.get("settings");
      return doc.documentElement.dataset.theme === "dark" && current.settings.theme === "dark";
    }));
    assert.strictEqual($("theme").getAttribute("aria-pressed"), "true");
    $("theme").click();
    assert.ok(await until(async () => {
      const current = await bgChrome.storage.sync.get("settings");
      return doc.documentElement.dataset.theme === "light" && current.settings.theme === "light";
    }));
  });

  await test("смена языка в настройках переводит интерфейс панели", async () => {
    const english = await win.chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", patch: { language: "en" } });
    panelRuntimeMessages.fire({ type: "SETTINGS_CHANGED", settings: english.settings });
    assert.ok(await until(() => $("input").placeholder === "Ask something..."));
    assert.strictEqual(doc.documentElement.lang, "en");
    assert.strictEqual($("btn-new-chat").textContent.trim(), "＋ New chat");
    const russian = await win.chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", patch: { language: "ru" } });
    panelRuntimeMessages.fire({ type: "SETTINGS_CHANGED", settings: russian.settings });
    assert.ok(await until(() => $("input").placeholder === "Спросите что-нибудь..."));
  });

  await test("селектор языка в настройках переводит страницу и сохраняет выбор", async () => {
    const optionsDom = new JSDOM(read("options.html"), {
      url: "chrome-extension://test/options.html",
      runScripts: "dangerously",
      pretendToBeVisual: true
    });
    const optionsWin = optionsDom.window;
    optionsWin.chrome = {
      runtime: {
        sendMessage: (msg) => new Promise((resolve) => bgChrome.runtime.onMessage.fns[0](msg, {}, resolve)),
        openOptionsPage: () => {}
      },
      storage: bgChrome.storage,
      permissions: bgChrome.permissions
    };
    optionsWin.eval(read("shared.js"));
    optionsWin.eval(read("options.js"));
    const options$ = (id) => optionsWin.document.getElementById(id);
    assert.ok(await until(() => options$("save") && !options$("save").disabled));
    options$("language").value = "en";
    options$("language").dispatchEvent(new optionsWin.Event("change"));
    options$("response-language").value = "en";
    assert.strictEqual(optionsWin.document.documentElement.lang, "en");
    assert.strictEqual(options$("save").textContent, "Save");
    options$("save").click();
    assert.ok(await until(async () => {
      const current = await bgChrome.storage.sync.get("settings");
      return current.settings.language === "en" && current.settings.responseLanguage === "en";
    }));
    options$("language").value = "ru";
    options$("language").dispatchEvent(new optionsWin.Event("change"));
    options$("response-language").value = "interface";
    options$("save").click();
    assert.ok(await until(async () => {
      const current = await bgChrome.storage.sync.get("settings");
      return current.settings.language === "ru";
    }));
    optionsWin.close();
  });

  await test("отправка сообщения: пузырь пользователя + стрим ответа", async () => {
    plan = [() => sse([
      'data: {"choices":[{"delta":{"content":"Нерпа — "}}],"model":"gpt-oss-20b"}\n\n',
      'data: {"choices":[{"delta":{"content":"**тюлень** Байкала."}}]}\n\n',
      "data: [DONE]\n\n"
    ])];
    $("input").value = "Кто такая нерпа?";
    $("btn-send").click();
    assert.ok(await until(() => doc.querySelectorAll(".msg.user").length === 1), "нет пузыря пользователя");
    assert.ok(await until(() => lastAssistant() && /тюлень/.test(lastAssistant().textContent)), "ответ не пришёл");
    await until(() => !$("btn-stop").classList.contains("hidden") === false);
    assert.ok(lastAssistant().innerHTML.includes("<strong>тюлень</strong>"), "markdown не отрендерен");
    assert.ok($("btn-send").classList.contains("hidden") === false, "кнопка отправки не вернулась");
    assert.strictEqual(doc.querySelectorAll(".chip").length, 3, "вопросы после ответа не обновились");
    const stored = await bgChrome.storage.local.get("chat_1");
    assert.strictEqual(stored["chat_1"].messages.length, 2);
    assert.ok(stored["chat_1"].messages[1].content.includes("тюлень"));
  });

  await test("анализ страницы: контекст + 3 кликабельных чипса", async () => {
    $("btn-analyze").click();
    assert.ok(await until(() => !$("btn-analyze").disabled), "чтение вкладки не завершилось");
    assert.ok(doc.body.textContent.includes("Прочитана страница"), "нет краткой системной заметки");
    const stored = await bgChrome.storage.local.get("chat_1");
    assert.ok(stored["chat_1"].pageContext.text.includes("эндемик"), "контекст не сохранён");
  });

  await test("меню источников собирает несколько вкладок", async () => {
    assert.ok(await until(() => doc.querySelectorAll(".source-option").length === 2), "список вкладок не загрузился");
    const options = [...doc.querySelectorAll(".source-option")];
    assert.strictEqual(options.length, 2);
    const second = options.find((label) => label.textContent.includes("Вторая статья"));
    const checkbox = second.querySelector("input");
    checkbox.checked = true;
    checkbox.dispatchEvent(new win.Event("change"));
    $("btn-analyze").click();
    assert.ok(await until(() => !$("btn-analyze").disabled), "страницы не прочитались");
    assert.ok(await until(() => $("source-summary").textContent.includes("2 вкладки")));
    const stored = await bgChrome.storage.local.get("chat_1");
    assert.strictEqual(stored["chat_1"].pageContext.sources.length, 2);
    assert.ok(stored["chat_1"].pageContext.text.includes("Вторая статья"));
  });

  await test("клик по чипсу отправляет вопрос", async () => {
    plan = [answer("Нерпа ест голомянку и бычков.")];
    const before = doc.querySelectorAll(".msg.user").length;
    const question = doc.querySelector(".chip").textContent;
    doc.querySelector(".chip").click();
    assert.ok(await until(() => doc.querySelectorAll(".msg.user").length === before + 1), "вопрос не ушёл");
    const users = [...doc.querySelectorAll(".msg.user .bubble")];
    assert.strictEqual(users[users.length - 1].textContent, question);
    assert.ok(await until(() => /голомянку/.test(lastAssistant().textContent)), "ответ по чипсу не пришёл");
  });

  await test("модель задаётся в настройках, ошибка Ollama предлагает повторить", async () => {
    await setSettings({ provider: "ollama" });
    assert.strictEqual($("model"), null, "в панели не должно быть выбора модели");
    plan = [() => { throw new TypeError("fetch failed"); }];
    $("input").value = "Проверка Ollama";
    $("btn-send").click();
    assert.ok(await until(() => doc.querySelector(".msg.error")), "нет пузыря ошибки");
    const errText = doc.querySelector(".msg.error").textContent;
    assert.ok(/Ollama/.test(errText) && /localhost:11434/.test(errText), errText.slice(0, 200));
    const buttons = [...doc.querySelectorAll(".msg.error .btn")].map((b) => b.textContent);
    assert.ok(buttons.includes("Настройки"), buttons.join("|"));
    assert.strictEqual(buttons.some((label) => /Переключиться/.test(label)), false);

    // Провайдер меняется в настройках, затем повторяется последний вопрос.
    plan = [answer("Ответ от Pollinations после переключения.")];
    await setSettings({ provider: "pollinations" });
    [...doc.querySelectorAll(".msg.error .btn")].find((b) => b.textContent === "Повторить").click();
    assert.ok(await until(() => /после переключения/.test(lastAssistant().textContent)), "повтор не сработал");
  });

  await test("задание из контекстного меню приходит в панель", async () => {
    assert.ok(await until(() => $("btn-stop").classList.contains("hidden")), "предыдущий ответ ещё не завершён");
    const before = doc.querySelectorAll(".msg.user").length;
    plan = [answer("Байкальская нерпа — пресноводный тюлень.")];
    bgChrome.contextMenus.onClicked.fire({ menuItemId: "ask", selectionText: "Кто такая байкальская нерпа?" }, { id: 1 });
    assert.ok(await until(() => {
      const users = [...doc.querySelectorAll(".msg.user .bubble")];
      return users.length > before && users[users.length - 1].textContent === "Кто такая байкальская нерпа?";
    }, 8000), "в чат отправлен не исходный текст выделения");
    assert.ok(await until(() => /пресноводный тюлень/.test(lastAssistant().textContent)), "ответ на выделение не пришёл");
  });

  await test("поиск цены показывает галерею из трёх изображений над ответом", async () => {
    assert.strictEqual((await bgChrome.storage.sync.get("settings")).settings.webSearch, true);
    plan = [answer("В сниппете магазина указана цена.")];
    $("input").value = "Сколько сейчас стоит этот товар?";
    $("btn-send").click();
    assert.ok(await until(() => /В сниппете магазина/.test(lastAssistant().textContent)), "ответ с веб-контекстом не пришёл");
    const reply = lastAssistant().closest(".msg");
    const gallery = reply.querySelector(".web-search-card");
    assert.ok(gallery, "галерея интернет-поиска не показана: " + reply.innerHTML);
    assert.deepStrictEqual([...gallery.querySelectorAll("img")].map((image) => image.src), [
      "https://images.example/item1.jpg",
      "https://images.example/item2.jpg",
      "https://images.example/item3.jpg"
    ]);
    assert.strictEqual(gallery.textContent.trim(), "", "в галерее не должно быть ссылок или текста об источниках");
    assert.strictEqual(reply.firstElementChild, gallery, "изображения должны стоять над ответом");
    assert.ok(read("sidepanel.css").includes("object-fit: contain"), "изображения не должны обрезаться");
  });

  await test("если Bing недоступен, модель всё равно отвечает из общих знаний", async () => {
    webSearchFailure = true;
    plan = [answer("Nothing Headphone (1) — беспроводные наушники Nothing с шумоподавлением.")];
    $("input").value = "Сколько сейчас стоит Nothing Headphone (1)?";
    $("btn-send").click();
    assert.ok(await until(() => /беспроводные наушники Nothing/.test(lastAssistant().textContent)), "модель не ответила");
    const reply = lastAssistant().closest(".msg");
    assert.strictEqual(reply.querySelector(".note"), null, "пользователю не нужно показывать отсутствие текстовых источников");
    assert.ok(reply.querySelector(".web-search-card"), "изображения должны показываться при пустой текстовой выдаче");
    assert.ok(lastRequestBody.messages[0].content.includes("общих знаний"), "системная инструкция всё ещё запрещает отвечать без контекста");
    webSearchFailure = false;
  });

  await test("устаревший worker подсказывает перезагрузить расширение и не блокирует ответ", async () => {
    webSearchUnknown = true;
    plan = [answer("Из общих знаний: Nothing Headphone (1) — модель беспроводных наушников.")];
    const userCount = doc.querySelectorAll(".msg.user").length;
    $("input").value = "Сколько сейчас стоит Nothing Headphone (1)?";
    $("btn-send").click();
    assert.ok(await until(() =>
      doc.querySelectorAll(".msg.user").length === userCount + 1 &&
      /модель беспроводных наушников/.test(lastAssistant().textContent)
    ), "модель не ответила");
    const note = lastAssistant().closest(".msg").querySelector(".note");
    webSearchUnknown = false;
    assert.ok(note && /перезагрузите ASK AI/i.test(note.textContent), "не объяснено, что нужно обновить worker: " + (note && note.textContent));
  });

  await test("новый чат сохраняет предыдущую переписку", async () => {
    $("btn-new-chat").click();
    assert.ok(await until(() => doc.querySelector(".empty")), "новый чат не пуст");
    assert.ok($("chat-history").querySelectorAll(".history-item").length >= 1, "старый чат не сохранился в истории");
    assert.strictEqual(doc.querySelectorAll(".chip").length, 3, "вопросы для открытой страницы вернулись автоматически");
  });

  await test("история переживает пересоздание панели", async () => {
    plan = [answer("Сохранённый ответ.")];
    $("input").value = "Сохрани меня";
    $("btn-send").click();
    assert.ok(await until(() => /Сохранённый ответ/.test(lastAssistant().textContent)));
    const stored = await bgChrome.storage.local.get("chat_1");
    assert.strictEqual(stored["chat_1"].messages.length, 2);
    assert.strictEqual(stored["chat_1"].messages[1].streaming, false);
  });

  await test("бургер открывает историю и восстанавливает выбранный чат", async () => {
    const item = $("chat-history").querySelector(".history-item");
    assert.ok(item, "в меню истории нет сохранённого чата");
    $("history-menu").open = true;
    item.click();
    assert.ok(await until(() => !$("history-menu").open), "меню не закрылось после выбора чата");
    assert.ok(doc.querySelectorAll(".msg.user").length > 0, "выбранный чат не восстановился");
  });

  await test("возврат на вкладку восстанавливает её вопросы", async () => {
    const originalQuestions = [...doc.querySelectorAll(".chip")].map((chip) => chip.textContent);
    secondTab.status = "loading";
    bgChrome.tabs.onActivated.fire({ tabId: 2 });
    await wait(100);
    assert.strictEqual(doc.querySelectorAll(".chip").length, 0, "не следует анализировать загружающуюся вкладку");
    secondTab.status = "complete";
    bgChrome.tabs.onUpdated.fire(2, { status: "complete" });
    assert.ok(await until(() => doc.querySelectorAll(".chip").length === 3), "вопросы второй вкладки не появились");
    bgChrome.tabs.onActivated.fire({ tabId: 1 });
    assert.ok(await until(() =>
      JSON.stringify([...doc.querySelectorAll(".chip")].map((chip) => chip.textContent)) === JSON.stringify(originalQuestions)
    ), "вопросы первой вкладки не восстановились");
    assert.deepStrictEqual([...doc.querySelectorAll(".chip")].map((chip) => chip.textContent), originalQuestions);
  });

  console.log("\nПройдено тестов: " + passed + "\n");
  win.close();
  process.exit(process.exitCode || 0);
})();
