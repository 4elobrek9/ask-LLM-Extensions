/*
 * Живой тест реального API Pollinations (без ключей) + проверка Ollama.
 * Соблюдает Retry-After Pollinations; тест может ждать между живыми запросами.
 * Запуск: node tests/live.test.js
 */
const L = require("../ask-any-llm/shared.js");

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP = 8000;
const results = [];

// Тот же ретрай, что и в background.js: 402 → ждём слот → повторяем
async function chatWithRetry(opts) {
  let waited = 0;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { return await L.pollinationsChat(opts); }
    catch (e) {
      if (L.isRateLimited(e.status) && waited < 180) {
        const w = Math.max(3, Math.min(90, L.retryAfterSeconds(e, 45)));
        console.log("       лимит (HTTP " + e.status + "): ждём " + w + " с, попытка " + attempt);
        await pause(w * 1000);
        waited += w;
        continue;
      }
      throw e;
    }
  }
  throw new Error("лимит не отпустил после всех повторов");
}

function log(name, ok, details) {
  results.push({ name, ok, details });
  console.log((ok ? "  ok   " : "  FAIL ") + name + (details ? " — " + details : ""));
}

const ARTICLE =
  "Байкальская нерпа — один из трёх пресноводных видов тюленей и единственный, живущий в озере Байкал. " +
  "Взрослая особь достигает 130 см и 70 кг. Учёные считают, что предки нерпы попали в озеро из Северного Ледовитого океана " +
  "по рекам в эпоху оледенения. Зимой нерпа строит снежные логова и щенится в конце февраля; детёныш весит около 3 кг. " +
  "Питается голомянкой и бычками, съедая около тонны рыбы в год. Популяция — несколько десятков тысяч особей. " +
  "Угрозы: браконьерство, потепление и сокращение ледового покрова.";

(async function run() {
  console.log("\n== Живой API Pollinations (анонимно, без ключа) ==\n");

  // 1. Список моделей
  let models = [];
  try {
    const t0 = Date.now();
    models = await L.fetchPollinationsModels({});
    log("GET /models", models.length > 0, models.map((m) => m.id + (m.aliases.length ? " (алиасы: " + m.aliases.join(", ") + ")" : "")).join("; ") + " · " + (Date.now() - t0) + " мс");
  } catch (e) {
    log("GET /models", false, e.message);
  }

  // 2. Невалидная для free-тира модель: проверяем реальный 404 и подстановку
  try {
    await L.pollinationsChat({ messages: [{ role: "user", content: "привет" }], model: "qwen-coder", stream: false });
    log("qwen-coder напрямую", false, "ожидали 404, а запрос прошёл");
  } catch (e) {
    const expected = L.isModelNotFound(e.status, e.message, e.code);
    log("qwen-coder → 404 NOT_FOUND", expected, "HTTP " + e.status + " · " + String(e.message).slice(0, 90));
  }
  const resolved = L.resolveModel("qwen-coder", models, true);
  log("автозамена qwen-coder", resolved.substituted && !!resolved.model, resolved.model + " · " + resolved.reason);

  await pause(GAP);

  // 3. Обычный (не потоковый) запрос рабочей моделью
  try {
    const t0 = Date.now();
    const out = await chatWithRetry({
      messages: [{ role: "system", content: "Отвечай по-русски, одним словом." }, { role: "user", content: "Поздоровайся одним словом." }],
      model: resolved.model || "openai",
      stream: false
    });
    log("POST / (stream=false)", out.text.length > 0, JSON.stringify(out.text.slice(0, 60)) + " · " + ((Date.now() - t0) / 1000).toFixed(1) + " с · модель " + out.model);
  } catch (e) {
    log("POST / (stream=false)", false, "HTTP " + e.status + " " + e.message);
  }

  await pause(GAP);

  // 4. Потоковый запрос: считаем дельты
  try {
    const t0 = Date.now();
    let deltas = 0, reasoning = 0, firstAt = 0;
    const out = await chatWithRetry({
      messages: [{ role: "user", content: "Назови три факта о Байкале коротко, по-русски." }],
      model: "openai",
      stream: true,
      onEvent: (ev) => {
        if (ev.type === "delta") { deltas++; if (!firstAt) firstAt = Date.now() - t0; }
        if (ev.type === "reasoning") reasoning++;
      }
    });
    log("POST / (stream=true, SSE)", out.text.length > 0 && deltas > 0,
      deltas + " дельт, " + reasoning + " токенов reasoning, первая дельта через " + (firstAt / 1000).toFixed(1) + " с, всего " + ((Date.now() - t0) / 1000).toFixed(1) + " с");
    console.log("       ответ: " + JSON.stringify(out.text.slice(0, 160)));
  } catch (e) {
    log("POST / (stream=true, SSE)", false, "HTTP " + e.status + " " + e.message);
  }

  await pause(GAP);

  // 5. Генерация 3 вопросов по статье (тот же промпт, что в расширении)
  try {
    const t0 = Date.now();
    const out = await chatWithRetry({
      messages: L.buildQuestionsMessages({ title: "Нерпа Байкала", url: "https://example.com/nerpa", text: ARTICLE }, L.DEFAULT_SETTINGS),
      model: "openai",
      stream: false
    });
    const questions = L.parseQuestions(out.text);
    log("3 вопроса по статье → JSON", questions.length === 3, ((Date.now() - t0) / 1000).toFixed(1) + " с");
    questions.forEach((q, i) => console.log("       " + (i + 1) + ". " + q));
    if (questions.length !== 3) console.log("       сырой ответ: " + JSON.stringify(out.text.slice(0, 300)));
  } catch (e) {
    log("3 вопроса по статье → JSON", false, "HTTP " + e.status + " " + e.message);
  }

  // 6. Ollama — опциональна; если сервер запущен, проверяем модель и запрос.
  const ollama = await L.checkOllama("http://localhost:11434");
  if (!ollama.ok) {
    log("Ollama (опционально)", true, "сервер недоступен, локальный тест пропущен: " + ollama.error);
  } else if (!ollama.models.length) {
    log("Ollama (опционально)", true, "сервер доступен, но локальные модели не установлены");
  } else {
    log("GET Ollama /api/tags", true, ollama.models.join(", "));
    try {
      const out = await L.ollamaChat({
        url: ollama.url,
        model: ollama.models[0],
        messages: [{ role: "user", content: "Ответь одним словом: привет." }],
        stream: false
      });
      log("POST Ollama /api/chat", !!out.text, JSON.stringify(out.text.slice(0, 60)) + " · модель " + out.model);
    } catch (e) {
      log("POST Ollama /api/chat", false, "HTTP " + e.status + " " + e.message);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\nИтого: " + (results.length - failed.length) + "/" + results.length + " проверок успешно\n");
  if (failed.length) process.exitCode = 1;
})();
