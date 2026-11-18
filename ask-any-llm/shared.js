/*
 * shared.js — общие утилиты и провайдеры.
 * Подключается в service worker через importScripts() и в UI через <script src>.
 * Никаких зависимостей и никаких API-ключей.
 */
(function (root) {
  "use strict";

  const POLLINATIONS_BASE = "https://text.pollinations.ai";
  const OLLAMA_DEFAULT_URL = "http://localhost:11434";

  // Настройки по умолчанию (лежат в chrome.storage.sync)
  const DEFAULT_SETTINGS = {
    provider: "pollinations", // pollinations | ollama
    pollinationsModel: "openai-fast", // единственная бесплатная модель без ключа
    ollamaUrl: OLLAMA_DEFAULT_URL,
    ollamaModel: "qwen2.5",
    stream: true, // потоковый вывод
    autoFallback: true, // менять недоступную модель на доступную
    promptTemplate: "Ответь кратко и по-русски: {text}",
    systemPrompt:
      "Ты — помощник в браузере. Отвечай кратко и естественно, обычно в 2–5 предложениях. " +
      "Не используй таблицы и длинные списки, если об этом не попросили. Не выдумывай факты; " +
      "если вопрос относится к открытой странице или видео — используй их текст. " +
      "Если информации там нет или вопрос не связан со страницей, отвечай из общих знаний; " +
      "при сомнении обозначай неопределённость, а не отказывайся только из-за отсутствия контекста.",
    maxContextChars: 10000, // оставляем запрос быстрым и помещающимся в контекст модели
    historyLimit: 12, // короткая история ускоряет последующие ответы
    questionMode: "answer", // page | answer
    theme: "dark", // light | dark
    language: "ru", // ru | en
    responseLanguage: "auto", // auto | ru | en
    webSearch: true,
    requestTimeoutSec: 180
  };

  const UI_TEXT = {
    ru: {
      "theme.label": "Сменить тему",
      "theme.light": "Светлая тема",
      "theme.dark": "Тёмная тема",
      "chat.new": "Новый чат",
      "settings.open": "Настройки",
      "analyze.page": "Прочитать страницу",
      "history.label": "Предыдущие чаты",
      "history.current": "Текущий чат",
      "history.previous": "Предыдущий чат",
      "history.empty": "Пока нет сохранённых чатов.",
      "empty.title": "Спросите о странице или видео",
      "empty.body": "Напишите вопрос или нажмите «Прочитать страницу». Можно выбрать несколько вкладок внизу.",
      "empty.enter": "Enter — отправить, Shift+Enter — новая строка.",
      "input.placeholder": "Спросите что-нибудь...",
      "send.title": "Отправить (Enter)",
      "stop.title": "Остановить (Esc)",
      "source.label": "Источники и чат",
      "source.current": "Эта вкладка",
      "source.help": "Выберите страницы для кнопки «Прочитать».",
      "copy": "копировать",
      "settings.title": "ASK AI by 4elobrek9 — настройки",
      "settings.subtitle": "Короткие ответы на вопросы по открытым страницам и видео.",
      "settings.ready": "Всё под контролем",
      "settings.personalize": "Ваш ритм",
      "settings.languageHint": "Язык интерфейса и ответов — отдельно.",
      "settings.providerHint": "Выберите, где будут рождаться ответы.",
      "settings.recommended": "БЕЗ КЛЮЧА",
      "settings.private": "НА ВАШЕМ ПК",
      "settings.freeHint": "Быстрый старт без лишних настроек.",
      "settings.localHint": "Ваш компьютер. Ваши модели. Ваши правила.",
      "settings.responsesHint": "Настройте ощущение от каждого диалога.",
      "settings.language": "Язык интерфейса",
      "settings.responseLanguage": "Язык ответов",
      "settings.responseLanguageHint": "Вопросы и ответы будут написаны на выбранном языке.",
      "settings.auto": "Автоматически",
      "questions.closeAll": "Закрыть все вопросы",
      "questions.title": "Вопросы по теме",
      "settings.russian": "Русский",
      "settings.english": "English",
      "settings.provider": "Провайдер по умолчанию",
      "provider.free": "FREE",
      "provider.free.description": "Работает без настройки внешнего сервера.",
      "provider.local": "LOCAL",
      "provider.local.description": "Ответы на вашем компьютере через Ollama.",
      "settings.pollinations": "FREE",
      "settings.defaultModel": "Модель по умолчанию",
      "settings.refreshModels": "Обновить список моделей",
      "settings.autoFallback": "Если модель недоступна, автоматически выбрать доступную.",
      "settings.ollama": "LOCAL",
      "settings.server": "Адрес сервера",
      "settings.modelName": "Имя модели",
      "settings.checkConnection": "Проверить соединение",
      "settings.responses": "Ответы и вопросы",
      "settings.suggest": "Предлагать вопросы",
      "settings.webSearch": "Искать актуальные сведения в интернете",
      "settings.webSearchHint": "Подходящие запросы, в том числе короткие названия товаров из выделения, отправляются в Bing.",
      "settings.pageQuestions": "По странице или видео",
      "settings.answerQuestions": "Углубить последний ответ",
      "settings.advanced": "Дополнительные настройки",
      "settings.selectionPrompt": "Промпт для выделенного текста (<code>{text}</code> — подстановка выделения)",
      "settings.systemPrompt": "Системный промпт",
      "settings.contextLength": "Символов контекста страницы",
      "settings.timeout": "Таймаут запроса, секунд",
      "settings.streaming": "Показывать ответ по мере генерации.",
      "settings.save": "Сохранить",
      "settings.reset": "Сбросить к умолчаниям",
      "settings.history": "История чатов хранится в вашем браузере.",
      "settings.modelsLoading": "Список ещё не загружен.",
      "settings.ollamaNotChecked": "Не проверялось.",
      "settings.pollinationsHint": "FREE использует доступную бесплатную модель; список зависит от сервиса.",
      "settings.ollamaHint": "Модель не установлена? Выполните <code>ollama pull qwen2.5</code>. Для другого адреса Chrome запросит доступ.",
      "settings.modelsAvailable": "Доступно: ",
      "settings.modelsOfflineShort": "Список недоступен. Используется модель по умолчанию.",
      "settings.saved": "Настройки сохранены.",
      "settings.saveError": "Не удалось сохранить: ",
      "settings.resetDone": "Настройки сброшены.",
      "settings.resetError": "Ошибка сброса: ",
      "settings.ollamaChecking": "Проверяю ",
      "settings.ollamaPermission": "Нет разрешения на адрес ",
      "settings.ollamaConnected": "На связи. Модели: ",
      "settings.ollamaNoModels": "Сервер отвечает, но моделей нет. Выполните: ollama pull ",
      "settings.ollamaUnavailable": "Недоступна: ",
      "settings.permissionNotice": "Адрес сохранён, но доступ не выдан — LOCAL не сможет отвечать.",
      "action.retry": "Повторить",
      "action.switchFree": "Переключиться на FREE",
      "action.switchLocal": "Переключиться на LOCAL",
      "action.allowSites": "Разрешить доступ к сайтам",
      "runtime.errorTitle": "Ошибка",
      "status.questionsLoading": "Готовлю вопросы…",
      "status.answerLoading": "Готовлю короткий ответ…",
      "status.waitCurrent": "Сначала дождитесь текущего ответа.",
      "status.contextLoading": "Подключаю контекст вкладок…",
      "status.readingPage": "Читаю страницу…",
      "status.webSearch": "Ищу актуальные сведения…",
      "status.questionsReady": "Готово: ",
      "status.questionsReadyTail": " вопроса по странице. Нажмите на вопрос.",
      "status.questionFallback": "Не удалось получить вопросы от ИИ — показаны общие вопросы.",
      "notice.stopped": "Запрос остановлен.",
      "notice.accessGranted": "Доступ к сайтам выдан.",
      "notice.accessDenied": "Доступ не выдан. Обновите вкладку и попробуйте снова.",
      "notice.readPage": "Прочитана страница «",
      "notice.readTabs": "Прочитано вкладок: ",
      "notice.webSearchUnavailable": "Интернет-поиск не сработал; ответ без веб-источников. ",
      "notice.readErrorHint": "Проверьте, что вкладки открыты на обычных веб-страницах.",
      "notice.copied": "скопировано",
      "error.noTabResponse": "Вкладка не ответила. Обновите её и попробуйте снова.",
      "error.webSearch": "Поиск не выполнился.",
      "error.searchExtensionReload": "Фоновый процесс устарел. Перезагрузите ASK AI на chrome://extensions.",
      "web.image": "Найденное изображение",
      "error.backgroundResponse": "Фоновый процесс не ответил. Перезагрузите расширение в chrome://extensions."
    },
    en: {
      "theme.label": "Change theme",
      "theme.light": "Light theme",
      "theme.dark": "Dark theme",
      "chat.new": "New chat",
      "settings.open": "Settings",
      "analyze.page": "Read page",
      "history.label": "Previous chats",
      "history.current": "Current chat",
      "history.previous": "Previous chat",
      "history.empty": "No saved chats yet.",
      "empty.title": "Ask about this page or video",
      "empty.body": "Ask a question or choose “Read page”. Select multiple tabs below.",
      "empty.enter": "Enter to send, Shift+Enter for a new line.",
      "input.placeholder": "Ask something...",
      "send.title": "Send (Enter)",
      "stop.title": "Stop (Esc)",
      "source.label": "Sources and chat",
      "source.current": "This tab",
      "source.help": "Choose pages for “Read page”.",
      "copy": "copy",
      "settings.title": "ASK AI by 4elobrek9 — Settings",
      "settings.subtitle": "Quick answers about open pages and videos.",
      "settings.ready": "All in your hands",
      "settings.personalize": "Your pace",
      "settings.languageHint": "Interface and response languages are separate.",
      "settings.providerHint": "Choose where your answers come from.",
      "settings.recommended": "NO API KEY",
      "settings.private": "ON YOUR PC",
      "settings.freeHint": "A quick start, without the setup.",
      "settings.localHint": "Your computer. Your models. Your rules.",
      "settings.responsesHint": "Shape the feel of every conversation.",
      "settings.language": "Interface language",
      "settings.responseLanguage": "Response language",
      "settings.responseLanguageHint": "Questions and answers will use the selected language.",
      "settings.auto": "Auto",
      "questions.closeAll": "Close all questions",
      "questions.title": "Suggested questions",
      "settings.russian": "Русский",
      "settings.english": "English",
      "settings.provider": "Default provider",
      "provider.free": "FREE",
      "provider.free.description": "Works without setting up an external server.",
      "provider.local": "LOCAL",
      "provider.local.description": "Answers locally on your computer with Ollama.",
      "settings.pollinations": "FREE",
      "settings.defaultModel": "Default model",
      "settings.refreshModels": "Refresh model list",
      "settings.autoFallback": "If a model is unavailable, automatically choose an available one.",
      "settings.ollama": "LOCAL",
      "settings.server": "Server address",
      "settings.modelName": "Model name",
      "settings.checkConnection": "Check connection",
      "settings.responses": "Answers and suggestions",
      "settings.suggest": "Suggest questions",
      "settings.webSearch": "Search the web for current information",
      "settings.webSearchHint": "Matching queries, including short product names selected on a page, are sent to Bing.",
      "settings.pageQuestions": "About the page or video",
      "settings.answerQuestions": "Explore the last answer",
      "settings.advanced": "Advanced settings",
      "settings.selectionPrompt": "Prompt for selected text (<code>{text}</code> is replaced with the selection)",
      "settings.systemPrompt": "System prompt",
      "settings.contextLength": "Page context characters",
      "settings.timeout": "Request timeout, seconds",
      "settings.streaming": "Show the answer as it is generated.",
      "settings.save": "Save",
      "settings.reset": "Reset to defaults",
      "settings.history": "Chat history is stored in your browser.",
      "settings.modelsLoading": "Model list has not loaded.",
      "settings.ollamaNotChecked": "Not checked.",
      "settings.pollinationsHint": "FREE uses an available free model; availability depends on the service.",
      "settings.ollamaHint": "Model not installed? Run <code>ollama pull qwen2.5</code>. Chrome will ask permission for a custom address.",
      "settings.modelsAvailable": "Available: ",
      "settings.modelsOfflineShort": "Model list unavailable. Using the default model.",
      "settings.saved": "Settings saved.",
      "settings.saveError": "Could not save: ",
      "settings.resetDone": "Settings reset.",
      "settings.resetError": "Reset failed: ",
      "settings.ollamaChecking": "Checking ",
      "settings.ollamaPermission": "No permission for ",
      "settings.ollamaConnected": "Connected. Models: ",
      "settings.ollamaNoModels": "Server is online, but has no models. Run: ollama pull ",
      "settings.ollamaUnavailable": "Unavailable: ",
      "settings.permissionNotice": "Address saved, but access was not granted; LOCAL cannot respond.",
      "action.retry": "Retry",
      "action.switchFree": "Switch to FREE",
      "action.switchLocal": "Switch to LOCAL",
      "action.allowSites": "Allow access to websites",
      "runtime.errorTitle": "Error",
      "status.questionsLoading": "Preparing questions…",
      "status.answerLoading": "Preparing a short answer…",
      "status.waitCurrent": "Wait for the current response first.",
      "status.contextLoading": "Loading tab context…",
      "status.readingPage": "Reading page…",
      "status.webSearch": "Searching for current information…",
      "status.questionsReady": "Ready: ",
      "status.questionsReadyTail": " page questions. Select one to ask.",
      "status.questionFallback": "Could not get AI suggestions; showing general questions.",
      "notice.stopped": "Request stopped.",
      "notice.accessGranted": "Website access granted.",
      "notice.accessDenied": "Access was not granted. Refresh the tab and try again.",
      "notice.readPage": "Read page “",
      "notice.readTabs": "Read tabs: ",
      "notice.webSearchUnavailable": "Web search failed; answering without web sources. ",
      "notice.readErrorHint": "Make sure the tabs are open to regular web pages.",
      "notice.copied": "Copied",
      "error.noTabResponse": "The tab did not respond. Refresh it and try again.",
      "error.webSearch": "Search failed.",
      "error.searchExtensionReload": "The background worker is outdated. Reload ASK AI at chrome://extensions.",
      "web.image": "Image result",
      "error.backgroundResponse": "The background worker did not respond. Reload the extension in chrome://extensions."
    }
  };

  // Модели из ТЗ: показываем всегда, доступность уточняется через /models
  const STATIC_MODELS = [
    { id: "openai-fast", label: "Быстрая", note: "модель по умолчанию, без ключа" },
    { id: "qwen-coder", label: "qwen-coder", note: "нужен ключ Pollinations" },
    { id: "mistral", label: "mistral", note: "нужен ключ Pollinations" },
    { id: "llama", label: "llama", note: "нужен ключ Pollinations" }
  ];

  /* ------------------------------------------------------------------ */
  /* Настройки                                                           */
  /* ------------------------------------------------------------------ */

  function mergeSettings(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, raw && typeof raw === "object" ? raw : {});
    if (s.pollinationsModel === "openai") s.pollinationsModel = "openai-fast";
    if (s.systemPrompt ===
      "Ты — помощник в браузере. Отвечай по-русски кратко и естественно, обычно в 2–5 предложениях. " +
      "Не используй таблицы и длинные списки, если об этом не попросили. Не выдумывай факты; " +
      "если вопрос относится к открытой странице или видео — используй их текст. " +
      "Если информации там нет или вопрос не связан со страницей, отвечай из общих знаний; " +
      "при сомнении обозначай неопределённость, а не отказывайся только из-за отсутствия контекста.") {
      s.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
    }
    if (s.systemPrompt ===
      "Ты — помощник в браузере. Отвечай по-русски кратко и естественно, обычно в 2–5 предложениях. " +
      "Не используй таблицы и длинные списки, если об этом не попросили. Не выдумывай факты; " +
      "если ответа нет в тексте страницы или субтитрах — честно скажи об этом.") {
      s.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
    }
    if (s.systemPrompt ===
      "Ты — полезный ассистент внутри браузера. Отвечай на русском языке, точно и по делу. " +
      "Используй markdown для списков и кода. Если контекста не хватает — скажи об этом прямо.") {
      s.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
    }
    s.provider = s.provider === "ollama" ? "ollama" : "pollinations";
    s.pollinationsModel = String(s.pollinationsModel || DEFAULT_SETTINGS.pollinationsModel).trim();
    s.ollamaModel = String(s.ollamaModel || DEFAULT_SETTINGS.ollamaModel).trim();
    s.ollamaUrl = normalizeOllamaUrl(s.ollamaUrl);
    s.promptTemplate = String(s.promptTemplate || DEFAULT_SETTINGS.promptTemplate);
    s.systemPrompt = String(s.systemPrompt == null ? DEFAULT_SETTINGS.systemPrompt : s.systemPrompt);
    s.stream = !!s.stream;
    s.autoFallback = !!s.autoFallback;
    s.maxContextChars = clampInt(s.maxContextChars, 1000, 60000, DEFAULT_SETTINGS.maxContextChars);
    s.historyLimit = clampInt(s.historyLimit, 2, 100, DEFAULT_SETTINGS.historyLimit);
    s.questionMode = s.questionMode === "answer" ? "answer" : "page";
    s.theme = s.theme === "light" ? "light" : "dark";
    s.language = s.language === "en" ? "en" : "ru";
    s.responseLanguage = ["ru", "en"].includes(s.responseLanguage) ? s.responseLanguage : "auto";
    s.webSearch = s.webSearch !== false;
    s.requestTimeoutSec = clampInt(s.requestTimeoutSec, 20, 600, DEFAULT_SETTINGS.requestTimeoutSec);
    return s;
  }

  function translate(key, language) {
    const locale = language === "en" ? "en" : "ru";
    return (UI_TEXT[locale] && UI_TEXT[locale][key]) || (UI_TEXT.ru && UI_TEXT.ru[key]) || key;
  }

  function getResponseLanguage(settings) {
    const s = mergeSettings(settings);
    return s.responseLanguage === "auto" ? s.language : s.responseLanguage;
  }

  function localizeDocument(doc, language) {
    const locale = language === "en" ? "en" : "ru";
    doc.documentElement.lang = locale;
    for (const node of doc.querySelectorAll("[data-i18n]")) {
      const key = node.getAttribute("data-i18n");
      node.textContent = translate(key, locale);
    }
    for (const node of doc.querySelectorAll("[data-i18n-html]")) {
      const key = node.getAttribute("data-i18n-html");
      node.innerHTML = translate(key, locale);
    }
    for (const node of doc.querySelectorAll("[data-i18n-placeholder]")) {
      node.placeholder = translate(node.getAttribute("data-i18n-placeholder"), locale);
    }
    for (const node of doc.querySelectorAll("[data-i18n-title]")) {
      node.title = translate(node.getAttribute("data-i18n-title"), locale);
    }
    for (const node of doc.querySelectorAll("[data-i18n-aria-label]")) {
      node.setAttribute("aria-label", translate(node.getAttribute("data-i18n-aria-label"), locale));
    }
    for (const node of doc.querySelectorAll("option[data-i18n]")) {
      node.textContent = translate(node.getAttribute("data-i18n"), locale);
    }
  }

  function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function normalizeOllamaUrl(url) {
    let u = String(url || OLLAMA_DEFAULT_URL).trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(u)) u = "http://" + u;
    return u;
  }

  /* ------------------------------------------------------------------ */
  /* Промпты и контекст                                                  */
  /* ------------------------------------------------------------------ */

  // Шаблон промпта для выделенного текста
  function buildPrompt(template, text) {
    const t = String(text || "").trim();
    const tpl = String(template || DEFAULT_SETTINGS.promptTemplate);
    if (/\{text\}|\{selection\}/.test(tpl)) {
      return tpl.replace(/\{text\}|\{selection\}/g, t);
    }
    return tpl + "\n\n" + t;
  }

  // Чистим текст страницы и режем по границе слова
  function trimContext(text, maxChars) {
    const clean = String(text || "")
      .replace(/\r/g, "")
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const max = maxChars || DEFAULT_SETTINGS.maxContextChars;
    if (clean.length <= max) return { text: clean, truncated: false };
    let cut = clean.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace > max * 0.6) cut = cut.slice(0, lastSpace);
    return { text: cut.trim() + "\n…[текст сокращён]", truncated: true };
  }

  function pageContextBlock(pageContext, maxChars) {
    if (!pageContext || !pageContext.text) return "";
    const t = trimContext(pageContext.text, maxChars);
    return (
      "КОНТЕКСТ СТРАНИЦЫ\n" +
      "Заголовок: " + (pageContext.title || "без заголовка") + "\n" +
      "URL: " + (pageContext.url || "") + "\n" +
      "Текст:\n" + t.text + "\n" +
      "КОНЕЦ КОНТЕКСТА. Если вопрос об этой странице — опирайся на текст; если вопрос посторонний, отвечай из общих знаний."
    );
  }

  // Сборка messages: system (+ контекст страницы) + история + новый вопрос
  function buildMessages(opts) {
    const settings = mergeSettings(opts.settings);
    const languageInstruction = settings.responseLanguage === "auto"
      ? "RESPONSE LANGUAGE: Automatically detect the language of the user's latest message and always respond strictly in that language."
      : settings.responseLanguage === "en"
      ? "RESPONSE LANGUAGE: Always respond strictly in English, regardless of the language used in the question, page, or custom instructions."
      : "ЯЗЫК ОТВЕТА: Всегда отвечай на русском языке, независимо от языка вопроса, страницы или пользовательских инструкций.";
    const history = (opts.history || []).filter(
      (m) => m && (m.role === "user" || m.role === "assistant") && !m.error && String(m.content || "").trim()
    );
    const tail = history.slice(-settings.historyLimit);
    const sys = [languageInstruction, settings.systemPrompt, pageContextBlock(opts.pageContext, settings.maxContextChars), opts.webContext]
      .filter(Boolean)
      .join("\n\n");
    const messages = [];
    if (sys.trim()) messages.push({ role: "system", content: sys });
    for (const m of tail) messages.push({ role: m.role, content: String(m.content) });
    if (opts.userText && String(opts.userText).trim()) {
      messages.push({ role: "user", content: String(opts.userText).trim() });
    }
    return messages;
  }

  const QUESTIONS_PROMPT =
    "Предложи 3 интересных вопроса по этой статье. " +
    "Ответь строго JSON массивом из трёх строк на русском языке, без пояснений и без markdown. " +
    'Пример: ["Вопрос 1?", "Вопрос 2?", "Вопрос 3?"]';

  function buildQuestionsMessages(pageContext, settings) {
    const s = mergeSettings(settings);
    const language = getResponseLanguage(s);
    const questionsPrompt = language === "en"
      ? 'Suggest 3 interesting questions about this article. Reply with only a valid JSON array of three strings in English, without explanations or markdown. Example: ["Question 1?", "Question 2?", "Question 3?"]'
      : 'Предложи 3 интересных вопроса по этой статье. Ответь строго JSON массивом из трёх строк на русском языке, без пояснений и без markdown. Пример: ["Вопрос 1?", "Вопрос 2?", "Вопрос 3?"]';
    const block = pageContextBlock(pageContext, s.maxContextChars);
    return [
      { role: "system", content: language === "en"
        ? "Help the reader understand the article. Return only valid JSON. Write question strings in English."
        : "Ты помогаешь читателю разобраться в статье. Отвечай только валидным JSON, вопросы формулируй на русском." },
      { role: "user", content: block + "\n\n" + questionsPrompt }
    ];
  }

  function generateQuestions(text, title, mode, seed, language) {
    const source = String(text || "")
      .replace(/\[\d{2}:\d{2}(?::\d{2})?\][ \t]*/g, "")
      .replace(/\r/g, "\n")
      .trim();
    const heading = String(title || "этой теме").replace(/[<>"]/g, "").trim().slice(0, 90);
    const sentences = source.split(/(?<=[.!?])\s+|\n+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length >= 24 && sentence.length <= 220 && !/\?$/.test(sentence));
    const pool = language === "en"
      ? (mode === "answer"
        ? [
            "Could you explain this idea more simply and give an example?",
            "What important caveats or exceptions are there?",
            "What is this conclusion based on?",
            "How could this be applied in practice?",
            "What might someone disagree with here?"
          ]
        : [
            'What is the main idea of "' + heading + '"?',
            "What causes and effects does the article describe?",
            "Which fact in the text matters most, and why?",
            "What solution does the author suggest?",
            "What conclusions can we draw from this topic?"
          ])
      : mode === "answer"
      ? [
          "Можешь объяснить эту мысль проще и привести пример?",
          "Какие есть важные оговорки или исключения?",
          "На чём основан этот вывод?",
          "Как это можно применить на практике?",
          "С чем здесь можно поспорить?"
        ]
      : [
          "Какова главная мысль материала «" + heading + "»?",
          "Какие причины и последствия описаны в материале?",
          "Какой факт из текста важнее всего и почему?",
          "Что автор предлагает или считает решением?",
          "Какие выводы можно сделать по этой теме?"
        ];
    const facts = sentences.slice(0, 8);
    for (const sentence of facts) {
      const short = sentence.length > 150 ? sentence.slice(0, 147).replace(/\s+\S*$/, "") + "…" : sentence;
      if (language === "en") {
        if (mode === "answer") {
          pool.push('Could you explain this idea in more detail: "' + short + '"?');
          pool.push('What example supports this claim: "' + short + '"?');
        } else {
          pool.push('How does the article explain this fact: "' + short + '"?');
        }
      } else if (mode === "answer") {
        pool.push("Можешь подробнее раскрыть мысль: «" + short + "»?");
        pool.push("Какой пример подтверждает утверждение: «" + short + "»?");
      } else {
        pool.push("Как в материале объясняется факт: «" + short + "»?");
      }
    }

    const uniquePool = Array.from(new Set(pool));
    let randomSeed = Number(seed) || Date.now();
    const random = () => {
      randomSeed = (randomSeed * 1664525 + 1013904223) >>> 0;
      return randomSeed / 4294967296;
    };
    for (let i = uniquePool.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [uniquePool[i], uniquePool[j]] = [uniquePool[j], uniquePool[i]];
    }
    const specific = uniquePool.filter((question) => language === "en"
      ? question.startsWith("How does the article explain this fact:") ||
        question.startsWith("Could you explain this idea in more detail:") ||
        question.startsWith("What example supports this claim:")
      : question.startsWith("Как в материале объясняется факт:") ||
        question.startsWith("Можешь подробнее раскрыть мысль:") ||
        question.startsWith("Какой пример подтверждает утверждение:"));
    const general = uniquePool.filter((question) => !specific.includes(question));
    const selected = specific.slice(0, Math.min(2, specific.length));
    while (selected.length < 3 && general.length) selected.push(general.shift());
    for (let i = selected.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [selected[i], selected[j]] = [selected[j], selected[i]];
    }
    return selected.slice(0, 3);
  }

  // Достаём 3 вопроса из любого ответа модели: JSON, ```json, список, нумерация
  function parseQuestions(raw) {
    const text = String(raw || "").trim();
    if (!text) return [];
    let out = [];

    const stripped = text.replace(/```[a-zA-Z]*\s*([\s\S]*?)```/g, "$1").trim();
    for (const candidate of [stripped, text]) {
      const arr = extractJsonArray(candidate);
      if (arr) {
        out = arr.map(questionToString).filter(Boolean);
        if (out.length) break;
      }
      const obj = extractJsonObject(candidate);
      if (obj && Array.isArray(obj.questions)) {
        out = obj.questions.map(questionToString).filter(Boolean);
        if (out.length) break;
      }
    }

    // Фолбэк: нумерованный/маркированный список (берём только похожие на вопросы строки)
    if (!out.length) {
      out = stripped
        .split(/\n+/)
        .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•—])\s*/, "").trim())
        .map((l) => l.replace(/^["'«»]+|["'«»]+$/g, "").trim())
        .filter((l) => l.length > 8 && l.length < 300 && !/^[\[\]{}]/.test(l))
        .filter((l) => /\?/.test(l) || /^(как|что|почему|зачем|какой|какие|какая|кто|где|когда|сколько|расскажи|объясни|перечисли)\b/i.test(l));
    }

    const seen = new Set();
    const uniq = [];
    for (const q of out) {
      const key = q.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(q.length > 220 ? q.slice(0, 217) + "…" : q);
      if (uniq.length >= 3) break;
    }
    return uniq;
  }

  function questionToString(v) {
    if (typeof v === "string") return v.trim();
    if (v && typeof v === "object") {
      const val = v.question || v.text || v.title || v.q;
      if (typeof val === "string") return val.trim();
    }
    return "";
  }

  // Первый сбалансированный JSON-массив в тексте
  function extractJsonArray(text) {
    const start = text.indexOf("[");
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1));
            if (Array.isArray(parsed)) return parsed;
          } catch (e) { /* пробуем дальше */ }
          return null;
        }
      }
    }
    return null;
  }

  function extractJsonObject(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Markdown → безопасный HTML (без библиотек, всё экранируется)         */
  /* ------------------------------------------------------------------ */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderMarkdown(src) {
    let text = String(src == null ? "" : src).replace(/\r/g, "");
    const blocks = [];

    // Вырезаем fenced-код (в т.ч. незакрытый — так бывает при стриминге)
    text = text.replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, (m, lang, code) => {
      const idx = blocks.length;
      blocks.push(
        '<pre class="code"><code>' + escapeHtml(code.replace(/\n$/, "")) + "</code></pre>"
      );
      return "\u0000B" + idx + "\u0000";
    });

    const sourceLines = text.split("\n");
    const tableLines = [];
    for (let i = 0; i < sourceLines.length; i++) {
      const row = sourceLines[i].trim();
      const separator = sourceLines[i + 1] && sourceLines[i + 1].trim();
      if (row.includes("|") && separator && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(separator)) {
        const parseCells = (line) => line.replace(/^\s*\||\|\s*$/g, "").split("|").map((cell) => escapeHtml(cell.trim()));
        const headers = parseCells(row);
        const rows = [];
        i += 2;
        while (i < sourceLines.length && sourceLines[i].includes("|")) rows.push(parseCells(sourceLines[i++]));
        i--;
        const table = '<div class="table-wrap"><table><thead><tr>' +
          headers.map((cell) => "<th>" + cell + "</th>").join("") +
          "</tr></thead><tbody>" +
          rows.map((cells) => "<tr>" + headers.map((_, column) => "<td>" + (cells[column] || "") + "</td>").join("") + "</tr>").join("") +
          "</tbody></table></div>";
        const index = blocks.length;
        blocks.push(table);
        tableLines.push("\u0000B" + index + "\u0000");
      } else {
        tableLines.push(sourceLines[i]);
      }
    }
    text = tableLines.join("\n");

    let html = escapeHtml(text);

    // Инлайн-код
    const inline = [];
    html = html.replace(/`([^`\n]+)`/g, (m, code) => {
      inline.push("<code>" + code + "</code>");
      return "\u0000I" + (inline.length - 1) + "\u0000";
    });

    // Ссылки [текст](url) — только http/https
    html = html.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,500})\)/g,
      (m, label, url) => '<a href="' + url + '" target="_blank" rel="noreferrer noopener">' + label + "</a>");

    // Жирный / курсив / зачёркнутый
    html = html
      .replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?):;]|$)/g, "$1<em>$2</em>")
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?):;]|$)/g, "$1<em>$2</em>")
      .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

    // Автоссылки Outside тегов
    html = html
      .split(/(<a\b[^>]*>[\s\S]*?<\/a>|<[^>]+>)/g)
      .map((part) => {
        if (!part || part.startsWith("<")) return part;
        return part.replace(/(^|[\s(])(https?:\/\/[^\s<)"']+)/g,
          (m, pre, url) => pre + '<a href="' + url + '" target="_blank" rel="noreferrer noopener">' + url + "</a>");
      })
      .join("");

    // Построчная разметка: заголовки, списки, цитаты, абзацы
    const lines = html.split("\n");
    const out = [];
    let listType = null;
    let paragraph = [];

    const flushParagraph = () => {
      if (paragraph.length) {
        out.push("<p>" + paragraph.join("<br>") + "</p>");
        paragraph = [];
      }
    };
    const closeList = () => {
      if (listType) {
        out.push("</" + listType + ">");
        listType = null;
      }
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) { flushParagraph(); closeList(); continue; }

      const blockOnly = line.match(/^\u0000B(\d+)\u0000$/);
      if (blockOnly) {
        flushParagraph(); closeList();
        out.push(blocks[Number(blockOnly[1])] || "");
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph(); closeList();
        const level = Math.min(6, heading[1].length + 2);
        out.push("<h" + level + ">" + heading[2] + "</h" + level + ">");
        continue;
      }

      if (/^([-*_]\s*){3,}$/.test(line)) { flushParagraph(); closeList(); out.push("<hr>"); continue; }

      const quote = line.match(/^&gt;\s?(.*)$/);
      if (quote) { flushParagraph(); closeList(); out.push("<blockquote>" + quote[1] + "</blockquote>"); continue; }

      const ul = line.match(/^[-*•+]\s+(.*)$/);
      const ol = line.match(/^\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushParagraph();
        const want = ul ? "ul" : "ol";
        if (listType !== want) { closeList(); out.push("<" + want + ">"); listType = want; }
        out.push("<li>" + (ul ? ul[1] : ol[1]) + "</li>");
        continue;
      }

      closeList();
      paragraph.push(line);
    }
    flushParagraph(); closeList();

    html = out.join("\n");
    html = html.replace(/\u0000I(\d+)\u0000/g, (m, i) => inline[Number(i)] || "");
    html = html.replace(/\u0000B(\d+)\u0000/g, (m, i) => blocks[Number(i)] || "");
    return html;
  }

  /* ------------------------------------------------------------------ */
  /* Ошибки                                                              */
  /* ------------------------------------------------------------------ */

  class ApiError extends Error {
    constructor(message, extra) {
      super(message);
      this.name = "ApiError";
      Object.assign(this, extra || {});
    }
  }

  // Достаём человекочитаемое сообщение из тела ошибки
  function parseApiErrorBody(body) {
    const text = String(body || "").trim();
    if (!text) return { message: "", code: "" };
    try {
      const j = JSON.parse(text);
      const e = j && j.error;
      if (typeof e === "string") return { message: e, code: j.code || "" };
      if (e && typeof e === "object") return { message: e.message || "", code: e.code || "" };
      if (j && typeof j.message === "string") return { message: j.message, code: j.code || "" };
    } catch (err) { /* не JSON */ }
    return { message: text.slice(0, 400), code: "" };
  }

  // Retry-After: секунды или HTTP-дата
  function parseRetryAfter(value, nowMs) {
    if (value == null || value === "") return null;
    const now = nowMs == null ? Date.now() : nowMs;
    const n = Number(String(value).trim());
    if (isFinite(n)) return Math.max(0, Math.min(600, Math.round(n)));
    const ts = Date.parse(String(value));
    if (!isNaN(ts)) return Math.max(0, Math.min(600, Math.round((ts - now) / 1000)));
    return null;
  }

  function isModelNotFound(status, message, code) {
    const m = String(message || "");
    return (
      status === 404 ||
      String(code || "").toUpperCase() === "NOT_FOUND" ||
      /isn't on the Classic API|model .*not found|unknown model|no such model|try pulling it first/i.test(m)
    );
  }

  function isRateLimited(status) {
    return status === 402 || status === 429 || status === 503;
  }

  // Сколько ждать: заголовок Retry-After, затем текст ошибки, затем дефолт free-тира
  function retryAfterSeconds(err, fallback) {
    if (err && typeof err.retryAfter === "number" && isFinite(err.retryAfter)) return err.retryAfter;
    const text = String((err && (err.raw || err.message)) || "");
    const m = text.match(/wait\s+(\d+)\s*second/i) || text.match(/подожд\w*\s+(\d+)\s*сек/i);
    if (m) return Number(m[1]);
    return fallback == null ? 45 : fallback;
  }

  // Понятные сообщения о сетевых сбоях
  function networkErrorMessage(err, provider, ollamaUrl) {
    if (err && err.name === "AbortError") return "Запрос остановлен.";
    if (provider === "ollama") {
      return (
        "Не удалось подключиться к Ollama по адресу " + ollamaUrl + ". " +
        "Похоже, локальный сервер не запущен или недоступен."
      );
    }
    return "Не удалось связаться с Pollinations. Проверьте интернет или попробуйте позже.";
  }

  /* ------------------------------------------------------------------ */
  /* Модели                                                              */
  /* ------------------------------------------------------------------ */

  // GET /models: приводит и старый (строки), и новый (объекты) формат
  function normalizeModels(payload) {
    const arr = Array.isArray(payload) ? payload : Array.isArray(payload && payload.models) ? payload.models : [];
    const out = [];
    for (const item of arr) {
      if (typeof item === "string") {
        out.push({ id: item, description: "", aliases: [], tier: "anonymous", reasoning: false });
      } else if (item && (item.name || item.id)) {
        out.push({
          id: String(item.name || item.id),
          description: String(item.description || ""),
          aliases: Array.isArray(item.aliases) ? item.aliases.map(String) : [],
          tier: String(item.tier || "anonymous"),
          reasoning: !!item.reasoning
        });
      }
    }
    return out;
  }

  function modelMatches(model, id) {
    if (!model || !id) return false;
    const want = String(id).toLowerCase();
    if (String(model.id).toLowerCase() === want) return true;
    return (model.aliases || []).some((a) => a.toLowerCase() === want);
  }

  // Есть ли запрошенная модель в анонимном списке
  function findModel(liveModels, id) {
    return (liveModels || []).find((m) => modelMatches(m, id)) || null;
  }

  function firstAnonymousModel(liveModels) {
    const list = liveModels || [];
    return list.find((m) => m.tier === "anonymous") || list[0] || null;
  }

  // Подбор замены: {model, substituted, reason}
  function resolveModel(requestedId, liveModels, autoFallback) {
    const list = liveModels || [];
    if (!list.length) return { model: requestedId, substituted: false, reason: "" };
    const exact = findModel(list, requestedId);
    if (exact) return { model: exact.id, substituted: false, reason: "" };
    if (!autoFallback) {
      return { model: requestedId, substituted: false, reason: "unavailable" };
    }
    const sub = firstAnonymousModel(list);
    if (!sub) return { model: requestedId, substituted: false, reason: "unavailable" };
    return {
      model: sub.id,
      substituted: true,
      reason:
        "Модель «" + requestedId + "» недоступна без API-ключа. Ответ дала «" + sub.id + "»" +
        (sub.description ? " (" + sub.description + ")" : "") + "."
    };
  }

  // Показываем реально доступные без ключа модели, а не нерабочие алиасы из примера.
  function buildModelMenu(settings, liveModels) {
    const s = mergeSettings(settings);
    const live = liveModels || [];
    const items = [];
    const used = new Set();

    for (const st of STATIC_MODELS) {
      const found = findModel(live, st.id);
      const known = live.length > 0;
      if (known && (!found || found.tier !== "anonymous")) continue;
      if (!known && st.id !== "openai") continue;
      items.push({
        key: "pollinations:" + (found ? found.id : st.id),
        provider: "pollinations",
        id: found ? found.id : st.id,
        label: st.id === "openai" || st.id === "openai-fast" ? "Быстрая" : st.label,
        note: found ? found.description || st.note : st.note,
        available: true,
        group: "Pollinations (без ключа)"
      });
      used.add(st.id);
      if (found) used.add(found.id);
    }

    for (const m of live) {
      if (used.has(m.id) || m.tier !== "anonymous") continue;
      used.add(m.id);
      items.push({
        key: "pollinations:" + m.id,
        provider: "pollinations",
        id: m.id,
        label: m.id,
        note: m.description || (m.tier === "anonymous" ? "анонимно" : "нужен ключ"),
        available: m.tier === "anonymous",
        group: "Pollinations (без ключа)"
      });
    }

    items.push({
      key: "ollama:" + s.ollamaModel,
      provider: "ollama",
      id: s.ollamaModel,
      label: "ollama",
      note: s.ollamaModel + " · " + s.ollamaUrl.replace(/^https?:\/\//, ""),
      available: true,
      group: "Локально"
    });
    return items;
  }

  /* ------------------------------------------------------------------ */
  /* Транспорт: чтение потока построчно                                  */
  /* ------------------------------------------------------------------ */

  async function readLines(response, onLine, signal) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    // Отдельный отказ по abort: читаем поток, даже если он сам не умеет отменяться
    let onAbort;
    const abortPromise = signal
      ? new Promise((_, reject) => {
          onAbort = () => reject(new DOMException("Aborted", "AbortError"));
          signal.addEventListener("abort", onAbort, { once: true });
        })
      : null;
    if (abortPromise) abortPromise.catch(() => {}); // не оставляем unhandled rejection
    try {
      while (true) {
        if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
        const read = reader.read();
        const { done, value } = abortPromise ? await Promise.race([read, abortPromise]) : await read;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.search(/\r?\n/)) >= 0) {
          const line = buffer.slice(0, idx);
          const skip = buffer[idx] === "\r" && buffer[idx + 1] === "\n" ? 2 : 1;
          buffer = buffer.slice(idx + skip);
          onLine(line); // пустые строки важны: в SSE они разделяют события
        }
      }
      buffer += decoder.decode();
      if (buffer.length) onLine(buffer);
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      try { reader.cancel(); } catch (e) {}
      try { reader.releaseLock(); } catch (e) {}
    }
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function emit(onEvent, event) {
    if (typeof onEvent === "function") {
      try { onEvent(event); } catch (e) { /* UI не должен ломать запрос */ }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Провайдер 1: Pollinations (без ключей)                              */
  /* ------------------------------------------------------------------ */

  async function pollinationsChat(opts) {
    const doFetch = opts.fetchImpl || fetch;
    const base = (opts.baseUrl || POLLINATIONS_BASE).replace(/\/+$/, "");
    const stream = opts.stream !== false;
    const body = {
      messages: opts.messages,
      model: opts.model || "openai",
      stream: stream,
      private: true,
      referrer: opts.referrer || "ask-any-llm-extension"
    };
    if (typeof opts.seed === "number") body.seed = opts.seed;

    const res = await doFetch(base + "/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "text/plain"
      },
      body: JSON.stringify(body),
      signal: opts.signal
    });

    if (!res.ok) {
      const raw = await safeText(res);
      const parsed = parseApiErrorBody(raw);
      throw new ApiError(parsed.message || "Pollinations вернул HTTP " + res.status, {
        status: res.status,
        code: parsed.code,
        retryAfter: parseRetryAfter(res.headers.get("Retry-After")),
        provider: "pollinations",
        raw: raw
      });
    }

    const ctype = (res.headers.get("Content-Type") || "").toLowerCase();
    let text = "";
    let reasoning = "";
    let reportedModel = body.model;

    if (ctype.includes("text/event-stream")) {
      let dataBuf = [];
      const flush = () => {
        if (!dataBuf.length) return;
        const payload = dataBuf.join("\n").trim();
        dataBuf = [];
        if (!payload || payload === "[DONE]") return;
        let chunk;
        try { chunk = JSON.parse(payload); } catch (e) {
          text += payload; // редкий случай: SSE с plain-text
          emit(opts.onEvent, { type: "delta", text: payload });
          return;
        }
        if (chunk.model) reportedModel = chunk.model;
        const choice = chunk.choices && chunk.choices[0];
        const delta = (choice && (choice.delta || choice.message)) || {};
        if (typeof delta.reasoning === "string" && delta.reasoning) {
          reasoning += delta.reasoning;
          emit(opts.onEvent, { type: "reasoning", text: delta.reasoning });
        }
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          emit(opts.onEvent, { type: "delta", text: delta.content });
        }
        if (chunk.error) {
          const msg = typeof chunk.error === "string" ? chunk.error : chunk.error.message;
          throw new ApiError(msg || "Ошибка в потоке Pollinations", { provider: "pollinations" });
        }
      };
      await readLines(res, (line) => {
        if (line.startsWith("data:")) { dataBuf.push(line.slice(5).replace(/^ /, "")); return; }
        if (/^(event|id|retry):/.test(line)) return;
        if (!line.trim()) flush();
      }, opts.signal);
      flush();
    } else {
      // Сервер мог проигнорировать stream или вернуть JSON ошибки с кодом 200
      const raw = await safeText(res);
      if (ctype.includes("application/json")) {
        const j = safeJson(raw);
        if (j && j.error) {
          const parsed = parseApiErrorBody(raw);
          throw new ApiError(parsed.message || "Ошибка Pollinations", {
            status: j.status || 200, code: parsed.code, provider: "pollinations", raw: raw
          });
        }
        const choice = j && j.choices && j.choices[0];
        const msg = choice && (choice.message || choice.delta);
        if (msg && typeof msg.content === "string") {
          text = msg.content;
          if (typeof msg.reasoning === "string") reasoning = msg.reasoning;
          if (j.model) reportedModel = j.model;
        } else {
          text = raw;
        }
      } else {
        text = raw;
      }
      if (text) emit(opts.onEvent, { type: "delta", text: text });
    }

    return { text: text.trim(), reasoning: reasoning.trim(), model: reportedModel, provider: "pollinations" };
  }

  /* ------------------------------------------------------------------ */
  /* Провайдер 2: локальная Ollama                                       */
  /* ------------------------------------------------------------------ */

  async function ollamaChat(opts) {
    const doFetch = opts.fetchImpl || fetch;
    const base = normalizeOllamaUrl(opts.url);
    const stream = opts.stream !== false;
    const res = await doFetch(base + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: opts.model || "qwen2.5", messages: opts.messages, stream: stream }),
      signal: opts.signal
    });

    if (!res.ok) {
      const raw = await safeText(res);
      const parsed = parseApiErrorBody(raw);
      throw new ApiError(parsed.message || "Ollama вернула HTTP " + res.status, {
        status: res.status, code: parsed.code, provider: "ollama", raw: raw
      });
    }

    let text = "";
    let reasoning = "";
    if (stream) {
      await readLines(res, (line) => {
        const j = safeJson(line);
        if (!j) return;
        if (j.error) throw new ApiError(String(j.error), { provider: "ollama", status: 400 });
        const msg = j.message || {};
        if (typeof msg.thinking === "string" && msg.thinking) {
          reasoning += msg.thinking;
          emit(opts.onEvent, { type: "reasoning", text: msg.thinking });
        }
        if (typeof msg.content === "string" && msg.content) {
          text += msg.content;
          emit(opts.onEvent, { type: "delta", text: msg.content });
        }
      }, opts.signal);
    } else {
      const j = safeJson(await safeText(res)) || {};
      if (j.error) throw new ApiError(String(j.error), { provider: "ollama", status: 400 });
      text = (j.message && j.message.content) || "";
      reasoning = (j.message && j.message.thinking) || "";
      if (text) emit(opts.onEvent, { type: "delta", text: text });
    }
    return { text: text.trim(), reasoning: reasoning.trim(), model: opts.model, provider: "ollama" };
  }

  // Проверка Ollama + список локальных моделей
  async function checkOllama(url, fetchImpl) {
    const doFetch = fetchImpl || fetch;
    const base = normalizeOllamaUrl(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    try {
      const res = await doFetch(base + "/api/tags", { signal: ctrl.signal });
      if (!res.ok) throw new ApiError("Ollama ответила HTTP " + res.status, { status: res.status });
      const j = safeJson(await safeText(res)) || {};
      const models = (j.models || []).map((m) => (typeof m === "string" ? m : m.name || m.model)).filter(Boolean);
      return { ok: true, models: models, url: base };
    } catch (e) {
      return {
        ok: false,
        url: base,
        models: [],
        error: e && e.name === "AbortError" ? "Таймаут: сервер не ответил за 7 секунд." : (e && e.message) || String(e)
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchPollinationsModels(opts) {
    const doFetch = (opts && opts.fetchImpl) || fetch;
    const base = ((opts && opts.baseUrl) || POLLINATIONS_BASE).replace(/\/+$/, "");
    const res = await doFetch(base + "/models", { headers: { Accept: "application/json" }, signal: opts && opts.signal });
    if (!res.ok) throw new ApiError("Список моделей недоступен: HTTP " + res.status, { status: res.status });
    return normalizeModels(safeJson(await safeText(res)));
  }

  async function safeText(res) {
    try { return await res.text(); } catch (e) { return ""; }
  }

  function safeJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  const api = {
    POLLINATIONS_BASE,
    OLLAMA_DEFAULT_URL,
    DEFAULT_SETTINGS,
    UI_TEXT,
    STATIC_MODELS,
    QUESTIONS_PROMPT,
    ApiError,
    mergeSettings,
    translate,
    getResponseLanguage,
    localizeDocument,
    normalizeOllamaUrl,
    buildPrompt,
    trimContext,
    pageContextBlock,
    buildMessages,
    buildQuestionsMessages,
    generateQuestions,
    parseQuestions,
    extractJsonArray,
    escapeHtml,
    renderMarkdown,
    parseApiErrorBody,
    parseRetryAfter,
    isModelNotFound,
    isRateLimited,
    retryAfterSeconds,
    networkErrorMessage,
    normalizeModels,
    modelMatches,
    findModel,
    firstAnonymousModel,
    resolveModel,
    buildModelMenu,
    readLines,
    sleep,
    pollinationsChat,
    ollamaChat,
    checkOllama,
    fetchPollinationsModels
  };

  root.AskLLM = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
