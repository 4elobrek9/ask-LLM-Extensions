/*
 * Юнит-тесты общих утилит (без сети).
 * Запуск: node tests/unit.test.js
 */
const assert = require("assert");
const L = require("../ask-any-llm/shared.js");

let passed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(() => { passed++; console.log("  ok  " + name); },
        (e) => { console.error("  FAIL " + name + "\n       " + (e && e.stack || e)); process.exitCode = 1; });
    }
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    console.error("  FAIL " + name + "\n       " + (e && e.stack || e));
    process.exitCode = 1;
  }
}

// Ответ SSE как ReadableStream (эмуляция fetch)
function streamResponse(chunks, headers) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: headers || { "Content-Type": "text/event-stream" } });
}

(async function run() {
  console.log("\n== shared.js: утилиты ==");

  test("buildPrompt подставляет {text}", () => {
    assert.strictEqual(L.buildPrompt("Ответь на русском: {text}", "что такое MV3?"), "Ответь на русском: что такое MV3?");
    assert.ok(L.buildPrompt("Без плейсхолдера", "текст").includes("текст"));
  });

  test("trimContext режет по слову и помечает обрезку", () => {
    const src = "слово ".repeat(500);
    const r = L.trimContext(src, 100);
    assert.ok(r.truncated);
    assert.ok(r.text.length <= 130);
    assert.ok(r.text.endsWith("[текст сокращён]"));
    assert.ok(!/сло$/.test(r.text.split("\n")[0]));
  });

  test("parseQuestions: чистый JSON", () => {
    const q = L.parseQuestions('["Первый вопрос?", "Второй вопрос?", "Третий вопрос?"]');
    assert.strictEqual(q.length, 3);
    assert.strictEqual(q[0], "Первый вопрос?");
  });

  test("parseQuestions: ```json fences (реальный ответ Pollinations)", () => {
    const raw = '```json\n[\n  "Как нерпы влияют на экосистему Байкала?",\n  "Какие угрозы популяции?",\n  "Как их защищают?"\n]\n```';
    const q = L.parseQuestions(raw);
    assert.strictEqual(q.length, 3);
    assert.ok(q[0].startsWith("Как нерпы"));
  });

  test("parseQuestions: объекты и объект-обёртка", () => {
    assert.strictEqual(L.parseQuestions('[{"question":"Что дальше?"},{"question":"Почему?"}]').length, 2);
    assert.strictEqual(L.parseQuestions('{"questions":["Вопрос один?","Вопрос два?"]}').length, 2);
  });

  test("parseQuestions: нумерованный список и мусор", () => {
    const q = L.parseQuestions("Вот вопросы:\n1. Первый содержательный вопрос?\n2. Второй содержательный вопрос?\n3. Третий содержательный вопрос?");
    assert.strictEqual(q.length, 3);
    assert.deepStrictEqual(L.parseQuestions("извините, не могу"), []);
    assert.deepStrictEqual(L.parseQuestions(""), []);
  });

  test("parseQuestions: дедуп и максимум 3", () => {
    const q = L.parseQuestions('["Один и тот же вопрос?","Один и тот же вопрос?","Другой вопрос?","Третий вопрос?","Четвёртый вопрос?"]');
    assert.strictEqual(q.length, 3);
    assert.strictEqual(new Set(q).size, 3);
  });

  test("renderMarkdown: базовая разметка", () => {
    const html = L.renderMarkdown("# Заголовок\n\nТекст **жирный** и `код`.\n\n- раз\n- два\n\n```js\nconst a = 1;\n```");
    assert.ok(html.includes("<h3>Заголовок</h3>"));
    assert.ok(html.includes("<strong>жирный</strong>"));
    assert.ok(html.includes("<code>код</code>"));
    assert.ok(html.includes("<ul>"));
    assert.ok(html.includes("<li>раз</li>"));
    assert.ok(html.includes('<pre class="code"><code>const a = 1;</code></pre>'));
  });

  test("renderMarkdown: экранирует XSS", () => {
    const html = L.renderMarkdown('<script>alert(1)</script> <img src=x onerror="alert(2)"> [клик](javascript:alert(3))');
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("<img"));
    assert.ok(!/href\s*=\s*"javascript:/i.test(html)); // ссылка не должна стать кликабельной
    assert.ok(!html.includes("<a "));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(html.includes("&quot;") || html.includes("&#39;") || html.includes("onerror"));
  });

  test("renderMarkdown: безопасные ссылки и незакрытый код при стриминге", () => {
    const html = L.renderMarkdown("[док](https://example.com/a?b=1&c=2)");
    assert.ok(html.includes('href="https://example.com/a?b=1&amp;c=2"'));
    assert.ok(html.includes('rel="noreferrer noopener"'));
    const partial = L.renderMarkdown("Вот код:\n```python\nprint(1)");
    assert.ok(partial.includes("<pre"));
  });

  test("renderMarkdown: таблица показывается как таблица, не как текст с пайпами", () => {
    const html = L.renderMarkdown("| Факт | Причина |\n|---|---|\n| Первый | Вторая |");
    assert.ok(html.includes("<table>"));
    assert.ok(html.includes("<th>Факт</th>"));
    assert.ok(html.includes("<td>Первый</td>"));
    assert.ok(!html.includes("| Факт |"));
  });

  test("generateQuestions: локально создаёт разные вопросы по странице и ответу", () => {
    const text = "Автор рассказывает о Байкале и его уникальной природе. Нерпа питается голомянкой и бычками. " +
      "Сокращение ледового покрова угрожает местам, где появляются детёныши.";
    const pageA = L.generateQuestions(text, "Байкальская нерпа", "page", 1);
    const pageB = L.generateQuestions(text, "Байкальская нерпа", "page", 2);
    const followups = L.generateQuestions("Это сложная тема. Важно учитывать разные причины и последствия.", "", "answer", 1);
    assert.strictEqual(pageA.length, 3);
    assert.strictEqual(new Set(pageA).size, 3);
    assert.notDeepStrictEqual(pageA, pageB);
    assert.ok(followups.some((question) => /подробнее|объяснить|пример|основан/i.test(question)));
    assert.strictEqual(L.mergeSettings({ pollinationsModel: "openai" }).pollinationsModel, "openai-fast");
  });

  test("generateQuestions: использует короткие строки субтитров с таймкодами", () => {
    const transcript = "[00:04] Нерпа живёт только в озере Байкал.\n" +
      "[00:12] Зимой она строит снежные логова для детёнышей.";
    const questions = L.generateQuestions(transcript, "Нерпа Байкала", "page", 3);
    assert.strictEqual(questions.length, 3);
    assert.ok(questions.some((question) => question.includes("Нерпа живёт")));
    assert.ok(questions.some((question) => question.includes("снежные логова")));
  });

  test("theme setting defaults to dark and rejects unknown values", () => {
    assert.strictEqual(L.mergeSettings({}).theme, "dark");
    assert.strictEqual(L.mergeSettings({ theme: "dark" }).theme, "dark");
    assert.strictEqual(L.mergeSettings({ theme: "system" }).theme, "dark");
  });

  test("language setting defaults to Russian and translates interface labels", () => {
    assert.strictEqual(L.mergeSettings({}).language, "ru");
    assert.strictEqual(L.mergeSettings({ language: "en" }).language, "en");
    assert.strictEqual(L.mergeSettings({ language: "fr" }).language, "ru");
    assert.strictEqual(L.getResponseLanguage({ language: "en" }), "en");
    assert.strictEqual(L.getResponseLanguage({ language: "en", responseLanguage: "ru" }), "ru");
    assert.strictEqual(L.getResponseLanguage({ language: "ru", responseLanguage: "en" }), "en");
    assert.strictEqual(L.mergeSettings({ responseLanguage: "interface" }).responseLanguage, "auto");
    assert.strictEqual(L.getResponseLanguage({ language: "en", responseLanguage: "auto" }), "en");
    assert.strictEqual(L.translate("input.placeholder", "en"), "Ask something...");
    assert.strictEqual(L.translate("provider.local", "ru"), "LOCAL");
  });

  test("web search setting defaults on and can be disabled", () => {
    assert.strictEqual(L.mergeSettings({}).webSearch, true);
    assert.strictEqual(L.mergeSettings({ webSearch: false }).webSearch, false);
  });

  test("parseRetryAfter: секунды и HTTP-дата", () => {
    assert.strictEqual(L.parseRetryAfter("30"), 30);
    const now = Date.parse("Mon, 16 Nov 2026 12:00:00 GMT");
    assert.strictEqual(L.parseRetryAfter("Mon, 16 Nov 2026 12:00:45 GMT", now), 45);
    assert.strictEqual(L.parseRetryAfter(null), null);
    assert.strictEqual(L.parseRetryAfter("мусор"), null);
  });

  test("resolveModel: живой список /models (реальный ответ API)", () => {
    const live = L.normalizeModels([{ name: "openai-fast", description: "GPT-OSS 20B Reasoning LLM (OVH)", tier: "anonymous", aliases: ["openai", "gpt-oss", "gpt-oss-20b"] }]);
    assert.strictEqual(L.resolveModel("openai", live, true).model, "openai-fast");
    assert.strictEqual(L.resolveModel("openai", live, true).substituted, false);
    const sub = L.resolveModel("qwen-coder", live, true);
    assert.strictEqual(sub.model, "openai-fast");
    assert.strictEqual(sub.substituted, true);
    assert.ok(sub.reason.includes("qwen-coder"));
    assert.strictEqual(L.resolveModel("mistral", live, false).reason, "unavailable");
    assert.strictEqual(L.resolveModel("mistral", [], true).model, "mistral"); // офлайн — не трогаем выбор
  });

  test("buildModelMenu: только доступная бесплатная модель + ollama", () => {
    const items = L.buildModelMenu(L.DEFAULT_SETTINGS, L.normalizeModels([{ name: "openai-fast", aliases: ["openai"], tier: "anonymous" }]));
    const ids = items.map((i) => i.key);
    for (const k of ["pollinations:openai-fast", "ollama:qwen2.5"]) {
      assert.ok(ids.includes(k), "нет пункта " + k);
    }
    assert.strictEqual(items.find((i) => i.id === "openai-fast").available, true);
    assert.strictEqual(items.some((i) => i.id === "mistral"), false);
  });

  test("buildMessages: system + контекст страницы + история", () => {
    const msgs = L.buildMessages({
      settings: L.DEFAULT_SETTINGS,
      history: [{ role: "user", content: "привет" }, { role: "assistant", content: "здравствуй" }, { role: "assistant", content: "", error: { message: "сбой" } }],
      userText: "о чём статья?",
      pageContext: { title: "Байкал", url: "https://ex.com/b", text: "Озеро Байкал — самое глубокое озеро планеты." }
    });
    assert.strictEqual(msgs[0].role, "system");
    assert.ok(msgs[0].content.includes("КОНТЕКСТ СТРАНИЦЫ"));
    assert.ok(msgs[0].content.includes("Байкал"));
    assert.strictEqual(msgs.length, 4); // system + 2 истории + новый вопрос
    assert.strictEqual(msgs[msgs.length - 1].content, "о чём статья?");
  });

  test("response language controls answer instructions and suggested questions", () => {
    const englishMessages = L.buildMessages({
      settings: { language: "ru", responseLanguage: "en", systemPrompt: "Keep it brief." },
      userText: "Объясни это"
    });
    assert.ok(englishMessages[0].content.includes("Always respond strictly in English"));
    assert.ok(englishMessages[0].content.startsWith("RESPONSE LANGUAGE:"));
    const automaticMessages = L.buildMessages({
      settings: { language: "ru", responseLanguage: "auto", systemPrompt: "Keep it brief." },
      userText: "Hello"
    });
    assert.ok(automaticMessages[0].content.startsWith("RESPONSE LANGUAGE: Automatically detect"));
    assert.ok(automaticMessages[0].content.includes("\n\nKeep it brief."));
    const englishQuestions = L.buildQuestionsMessages(null, { language: "ru", responseLanguage: "en" });
    assert.ok(englishQuestions[0].content.includes("in English"));
    assert.ok(englishQuestions[1].content.includes("valid JSON array"));
    const localQuestions = L.generateQuestions("This article explains how a small change can improve the system. The results are visible in practice.", "A useful change", "page", 4, "en");
    assert.ok(localQuestions.every((question) => /^[A-Z]/.test(question)));
    assert.ok(localQuestions.some((question) => question.includes("article")));
  });

  test("buildMessages adds web results to hidden system context, not the visible user text", () => {
    const msgs = L.buildMessages({
      settings: L.DEFAULT_SETTINGS,
      userText: "Сколько стоит этот товар?",
      webContext: "Источник Bing: цена 12 000 ₽."
    });
    assert.ok(msgs[0].content.includes("Источник Bing"));
    assert.strictEqual(msgs[1].role, "user");
    assert.strictEqual(msgs[1].content, "Сколько стоит этот товар?");
  });

  test("default system prompt answers unrelated questions from general knowledge", () => {
    const previousDefault =
      "Ты — помощник в браузере. Отвечай по-русски кратко и естественно, обычно в 2–5 предложениях. " +
      "Не используй таблицы и длинные списки, если об этом не попросили. Не выдумывай факты; " +
      "если ответа нет в тексте страницы или субтитрах — честно скажи об этом.";
    assert.ok(L.DEFAULT_SETTINGS.systemPrompt.includes("отвечай из общих знаний"));
    assert.strictEqual(L.mergeSettings({ systemPrompt: previousDefault }).systemPrompt, L.DEFAULT_SETTINGS.systemPrompt);
    assert.strictEqual(L.mergeSettings({ systemPrompt: "Моя инструкция" }).systemPrompt, "Моя инструкция");
  });

  test("retryAfterSeconds: заголовок, текст ошибки, дефолт 45", () => {
    assert.strictEqual(L.retryAfterSeconds({ retryAfter: 13 }), 13);
    assert.strictEqual(L.retryAfterSeconds({ message: "Free limit reached: 1 reply every 45 seconds per IP. Please wait 13 seconds" }), 13);
    assert.strictEqual(L.retryAfterSeconds({ message: "лимит" }), 45);
    assert.strictEqual(L.retryAfterSeconds({}, 30), 30);
  });

  test("isModelNotFound / isRateLimited", () => {
    assert.ok(L.isModelNotFound(404, 'Model "mistral" isn\'t on the Classic API.', "NOT_FOUND"));
    assert.ok(L.isModelNotFound(400, "model 'x' not found, try pulling it first"));
    assert.ok(!L.isModelNotFound(402, "rate limited"));
    assert.ok(L.isRateLimited(402) && L.isRateLimited(429));
  });

  console.log("\n== shared.js: транспорт (mock fetch) ==");

  await test("pollinationsChat: стриминг SSE, content + reasoning", async () => {
    const events = [];
    const sse = [
      'data: {"choices":[{"delta":{"role":"assistant","content":""}}],"model":"gpt-oss-20b"}\n\n',
      'data: {"choices":[{"delta":{"reasoning":"думаю"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"При"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"вет"}}]}\n\n',
      "data: [DONE]\n\n"
    ];
    const out = await L.pollinationsChat({
      messages: [{ role: "user", content: "привет" }],
      model: "openai",
      fetchImpl: async () => streamResponse(sse),
      onEvent: (e) => events.push(e)
    });
    assert.strictEqual(out.text, "Привет");
    assert.strictEqual(out.reasoning, "думаю");
    assert.strictEqual(out.model, "gpt-oss-20b");
    assert.strictEqual(events.filter((e) => e.type === "delta").length, 2);
  });

  await test("pollinationsChat: SSE разрезанный посреди строки", async () => {
    const full = 'data: {"choices":[{"delta":{"content":"Целый ответ"}}]}\n\ndata: [DONE]\n\n';
    const parts = [full.slice(0, 20), full.slice(20, 35), full.slice(35)];
    const out = await L.pollinationsChat({ messages: [], fetchImpl: async () => streamResponse(parts) });
    assert.strictEqual(out.text, "Целый ответ");
  });

  await test("pollinationsChat: обычный text/plain ответ", async () => {
    const out = await L.pollinationsChat({
      messages: [], stream: false,
      fetchImpl: async () => new Response("Просто текст", { status: 200, headers: { "Content-Type": "text/plain" } })
    });
    assert.strictEqual(out.text, "Просто текст");
  });

  await test("pollinationsChat: 404 модели → ApiError с кодом", async () => {
    const body = JSON.stringify({ status: 404, error: { code: "NOT_FOUND", message: 'Model "mistral" isn\'t on the Classic API.' } });
    await assert.rejects(
      L.pollinationsChat({ messages: [], fetchImpl: async () => new Response(body, { status: 404, headers: { "Content-Type": "application/json" } }) }),
      (e) => e.status === 404 && e.code === "NOT_FOUND" && L.isModelNotFound(e.status, e.message, e.code)
    );
  });

  await test("pollinationsChat: 402 → retryAfter из заголовка", async () => {
    await assert.rejects(
      L.pollinationsChat({ messages: [], fetchImpl: async () => new Response("Free limit reached", { status: 402, headers: { "Retry-After": "27" } }) }),
      (e) => e.status === 402 && e.retryAfter === 27 && L.isRateLimited(e.status)
    );
  });

  await test("pollinationsChat: JSON-ошибка с кодом 200", async () => {
    await assert.rejects(
      L.pollinationsChat({ messages: [], fetchImpl: async () => new Response('{"error":{"message":"лимит","code":"RATE_LIMIT"}}', { status: 200, headers: { "Content-Type": "application/json" } }) }),
      (e) => /лимит/.test(e.message)
    );
  });

  await test("ollamaChat: NDJSON стриминг", async () => {
    const nd = ['{"message":{"content":"Локаль"},"done":false}\n', '{"message":{"content":"ный ответ"},"done":true}\n'];
    const out = await L.ollamaChat({
      url: "http://localhost:11434", model: "qwen2.5", messages: [],
      fetchImpl: async () => streamResponse(nd, { "Content-Type": "application/x-ndjson" })
    });
    assert.strictEqual(out.text, "Локальный ответ");
  });

  await test("ollamaChat: stream=false", async () => {
    const out = await L.ollamaChat({
      url: "http://localhost:11434/", model: "qwen2.5", messages: [], stream: false,
      fetchImpl: async (url, opts) => {
        assert.strictEqual(url, "http://localhost:11434/api/chat");
        assert.strictEqual(JSON.parse(opts.body).stream, false);
        return new Response('{"message":{"role":"assistant","content":"Готово"},"done":true}', { status: 200, headers: { "Content-Type": "application/json" } });
      }
    });
    assert.strictEqual(out.text, "Готово");
  });

  await test("ollamaChat: нет модели → понятная ошибка", async () => {
    await assert.rejects(
      L.ollamaChat({ url: "http://localhost:11434", model: "nope", messages: [], fetchImpl: async () => new Response('{"error":"model \'nope\' not found, try pulling it first"}', { status: 404 }) }),
      (e) => L.isModelNotFound(e.status, e.message)
    );
  });

  await test("checkOllama: успех и отказ соединения", async () => {
    const ok = await L.checkOllama("http://localhost:11434", async () => new Response('{"models":[{"name":"qwen2.5:7b"},{"name":"llama3"}]}', { status: 200 }));
    assert.deepStrictEqual(ok.models, ["qwen2.5:7b", "llama3"]);
    const bad = await L.checkOllama("http://localhost:11434", async () => { throw new TypeError("fetch failed"); });
    assert.strictEqual(bad.ok, false);
    assert.ok(/fetch failed/.test(bad.error));
  });

  await test("abort: сон и запрос прерываются сигналом", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    await assert.rejects(L.sleep(5000, ctrl.signal), (e) => e.name === "AbortError");
  });

  console.log("\nПройдено тестов: " + passed + "\n");
})();
