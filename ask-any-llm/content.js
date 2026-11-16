/*
 * content.js — живёт в странице (изолированный мир).
 * Достаёт основной текст через Mozilla Readability, отдаёт выделение.
 * Readability.js подключается раньше (см. manifest.json и инъекцию в background.js).
 */
(function () {
  "use strict";

  if (window.__askAnyLlmContent) return; // защита от повторной инъекции
  window.__askAnyLlmContent = true;

  const MIN_ARTICLE_CHARS = 500; // меньше — считаем, что Readability не справился
  const MAX_RAW_CHARS = 60000; // сырой лимит, дальше режет background по настройкам

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      if (!msg || !msg.type) return;
      if (msg.type === "PING") { sendResponse({ ok: true, url: location.href }); return; }
      if (msg.type === "GET_SELECTION") { sendResponse({ ok: true, text: getSelectionText() }); return; }
      if (msg.type === "EXTRACT_PAGE") { sendResponse(extractPage()); return; }
    } catch (e) {
      sendResponse({ ok: false, message: String((e && e.message) || e) });
    }
  });

  // Выделение: обычный текст + текст внутри input/textarea
  function getSelectionText() {
    const sel = window.getSelection();
    let text = sel ? String(sel.toString()) : "";
    if (!text.trim()) {
      const el = document.activeElement;
      if (el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /^(text|search|url|email|tel)$/i.test(el.type || "text")))) {
        const start = el.selectionStart || 0;
        const end = el.selectionEnd || 0;
        if (end > start) text = String(el.value || "").slice(start, end);
      }
    }
    return text.trim();
  }

  function normalize(text) {
    return String(text || "")
      .replace(/\r/g, "")
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function extractPage() {
    if (!document.body) return { ok: false, message: "У страницы нет body — читать нечего." };

    let article = null;
    let readabilityError = "";

    // Readability мутирует DOM, поэтому работаем с клоном документа
    if (typeof Readability === "function") {
      try {
        const clone = document.cloneNode(true);
        article = new Readability(clone, {
          charThreshold: 400,
          keepClasses: false,
          nbTopCandidates: 5
        }).parse();
      } catch (e) {
        readabilityError = String((e && e.message) || e);
        article = null;
      }
    } else {
      readabilityError = "Readability не загружен";
    }

    const articleText = article && article.textContent ? normalize(article.textContent) : "";
    let text = articleText;
    let method = "readability";

    // Фолбэк: видимый текст всей страницы
    if (text.length < MIN_ARTICLE_CHARS) {
      const bodyText = normalize(document.body.innerText || document.body.textContent || "");
      if (bodyText.length > text.length) {
        text = bodyText;
        method = "innerText";
      }
    }

    if (!text) {
      return { ok: false, message: "На странице не найден текст.", hint: "Возможно, это пустая страница или приложение без контента." };
    }

    const truncated = text.length > MAX_RAW_CHARS;
    if (truncated) text = text.slice(0, MAX_RAW_CHARS);

    return {
      ok: true,
      url: location.href,
      title: (article && article.title) || document.title || location.hostname,
      siteName: (article && article.siteName) || location.hostname,
      excerpt: (article && article.excerpt) || "",
      lang: (article && article.lang) || document.documentElement.lang || "",
      text: text,
      length: text.length,
      method: method,
      truncated: truncated,
      readabilityError: readabilityError
    };
  }
})();
