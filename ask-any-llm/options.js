/*
 * options.js — настройки расширения.
 * Пишем в chrome.storage.sync через background (он же пересобирает контекстное меню).
 */
(function () {
  "use strict";

  const L = window.AskLLM;
  const $ = (id) => document.getElementById(id);

  const els = {
    language: $("language"),
    responseLanguage: $("response-language"),
    providerPoll: $("provider-pollinations"),
    providerOllama: $("provider-ollama"),
    pollModel: $("pollinations-model"),
    refreshModels: $("refresh-models"),
    modelsStatus: $("models-status"),
    autoFallback: $("auto-fallback"),
    ollamaUrl: $("ollama-url"),
    ollamaModel: $("ollama-model"),
    ollamaList: $("ollama-models"),
    checkOllama: $("check-ollama"),
    ollamaStatus: $("ollama-status"),
    systemPrompt: $("system-prompt"),
    questionMode: $("question-mode"),
    webSearch: $("web-search"),
    maxContext: $("max-context"),
    timeout: $("timeout"),
    stream: $("stream"),
    save: $("save"),
    reset: $("reset"),
    toast: $("toast")
  };

  let settings = L.mergeSettings({});
  let liveModels = [];

  function toast(text, isError) {
    els.toast.textContent = text;
    els.toast.classList.toggle("err", !!isError);
    els.toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.remove("show"), 3500);
  }

  async function bg(type, extra) {
    const res = await chrome.runtime.sendMessage(Object.assign({ type: type }, extra || {}));
    if (!res) throw new Error("Фоновый процесс не ответил");
    return res;
  }

  function fillModelSelect() {
    const items = L.buildModelMenu(settings, liveModels).filter((i) => i.provider === "pollinations");
    els.pollModel.textContent = "";
    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = item.id === "openai-fast" ? "FREE" : item.label;
      els.pollModel.appendChild(opt);
    }
    if (!items.some((i) => i.id === settings.pollinationsModel)) {
      const opt = document.createElement("option");
      opt.value = settings.pollinationsModel;
      opt.textContent = settings.pollinationsModel;
      els.pollModel.appendChild(opt);
    }
    els.pollModel.value = settings.pollinationsModel;
  }

  function fillForm() {
    els.providerPoll.checked = settings.provider === "pollinations";
    els.providerOllama.checked = settings.provider === "ollama";
    els.ollamaUrl.value = settings.ollamaUrl;
    els.ollamaModel.value = settings.ollamaModel;
    els.autoFallback.checked = settings.autoFallback;
    els.systemPrompt.value = settings.systemPrompt;
    els.questionMode.value = settings.questionMode;
    els.webSearch.checked = settings.webSearch;
    els.maxContext.value = settings.maxContextChars;
    els.timeout.value = settings.requestTimeoutSec;
    els.stream.checked = settings.stream;
    els.language.value = settings.language;
    els.responseLanguage.value = settings.responseLanguage;
    L.localizeDocument(document, settings.language);
    fillModelSelect();
  }

  function readForm() {
    return {
      provider: els.providerOllama.checked ? "ollama" : "pollinations",
      language: els.language.value,
      responseLanguage: els.responseLanguage.value,
      pollinationsModel: els.pollModel.value || "openai-fast",
      ollamaUrl: L.normalizeOllamaUrl(els.ollamaUrl.value),
      ollamaModel: (els.ollamaModel.value || "qwen2.5").trim(),
      autoFallback: els.autoFallback.checked,
      systemPrompt: els.systemPrompt.value,
      questionMode: els.questionMode.value,
      webSearch: els.webSearch.checked,
      maxContextChars: Number(els.maxContext.value),
      requestTimeoutSec: Number(els.timeout.value),
      stream: els.stream.checked
    };
  }

  // Для нестандартного адреса Ollama нужно разрешение на хост
  async function ensureHostPermission(url) {
    let origin;
    try { origin = new URL(url).origin + "/*"; } catch (e) { return false; }
    try {
      if (await chrome.permissions.contains({ origins: [origin] })) return true;
      return await chrome.permissions.request({ origins: [origin] });
    } catch (e) {
      return false;
    }
  }

  async function loadModels(force) {
    els.modelsStatus.textContent = L.translate("settings.modelsLoading", settings.language);
    els.modelsStatus.className = "muted";
    try {
      const res = await bg("GET_MODELS", { force: !!force });
      liveModels = res.models || [];
      if (liveModels.length) {
        els.modelsStatus.textContent = L.translate("settings.modelsAvailable", settings.language) + liveModels.map((m) => m.id).join(", ");
        els.modelsStatus.className = "muted ok";
      } else {
        els.modelsStatus.textContent = L.translate("settings.modelsOfflineShort", settings.language);
        els.modelsStatus.className = "muted err";
      }
    } catch (e) {
      liveModels = [];
      els.modelsStatus.textContent = L.translate("settings.modelsOfflineShort", settings.language) + " " + (e.message || e);
      els.modelsStatus.className = "muted err";
    }
    fillModelSelect();
  }

  async function checkOllama() {
    const url = L.normalizeOllamaUrl(els.ollamaUrl.value);
    els.ollamaStatus.textContent = L.translate("settings.ollamaChecking", settings.language) + url + "…";
    els.ollamaStatus.className = "muted";
    const allowed = await ensureHostPermission(url);
    if (!allowed) {
      els.ollamaStatus.textContent = L.translate("settings.ollamaPermission", settings.language) + url;
      els.ollamaStatus.className = "muted err";
      return;
    }
    const res = await bg("CHECK_OLLAMA", { url: url });
    if (res.ok) {
      els.ollamaStatus.textContent = res.models.length
        ? L.translate("settings.ollamaConnected", settings.language) + res.models.join(", ")
        : L.translate("settings.ollamaNoModels", settings.language) + (els.ollamaModel.value || "qwen2.5");
      els.ollamaStatus.className = "muted ok";
      els.ollamaList.textContent = "";
      for (const name of res.models) {
        const opt = document.createElement("option");
        opt.value = name;
        els.ollamaList.appendChild(opt);
      }
    } else {
      els.ollamaStatus.textContent = L.translate("settings.ollamaUnavailable", settings.language) + res.error;
      els.ollamaStatus.className = "muted err";
    }
  }

  async function save() {
    const patch = readForm();
    if (patch.provider === "ollama") {
      const allowed = await ensureHostPermission(patch.ollamaUrl);
      if (!allowed) toast(L.translate("settings.permissionNotice", settings.language), true);
    }
    els.save.disabled = true;
    try {
      const res = await bg("SAVE_SETTINGS", { patch: patch });
      settings = L.mergeSettings(res.settings);
      fillForm();
      toast(L.translate("settings.saved", settings.language));
    } catch (e) {
      toast(L.translate("settings.saveError", settings.language) + (e.message || e), true);
    } finally {
      els.save.disabled = false;
    }
  }

  async function reset() {
    els.save.disabled = true;
    try {
      const res = await bg("SAVE_SETTINGS", { patch: L.DEFAULT_SETTINGS });
      settings = L.mergeSettings(res.settings);
      fillForm();
      toast(L.translate("settings.resetDone", settings.language));
    } catch (e) {
      toast(L.translate("settings.resetError", settings.language) + (e.message || e), true);
    } finally {
      els.save.disabled = false;
    }
  }

  els.save.addEventListener("click", save);
  els.language.addEventListener("change", () => {
    settings.language = els.language.value === "en" ? "en" : "ru";
    L.localizeDocument(document, settings.language);
  });
  els.reset.addEventListener("click", reset);
  els.refreshModels.addEventListener("click", () => loadModels(true));
  els.checkOllama.addEventListener("click", checkOllama);
  els.providerPoll.addEventListener("change", () => { settings.provider = "pollinations"; });
  els.providerOllama.addEventListener("change", () => { settings.provider = "ollama"; });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings) {
      settings = L.mergeSettings(changes.settings.newValue);
      fillForm();
    }
  });

  (async function init() {
    try {
      const res = await bg("GET_SETTINGS");
      settings = L.mergeSettings(res.settings);
    } catch (e) { /* дефолты */ }
    fillForm();
    els.save.disabled = false;
    await loadModels(false);
  })();
})();
