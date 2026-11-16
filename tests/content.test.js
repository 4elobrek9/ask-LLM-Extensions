/*
 * Тест извлечения текста: вендоренная Mozilla Readability + content.js в jsdom.
 * Запуск: npm i jsdom && node tests/content.test.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch (e) {
  console.log("SKIP: нужен jsdom (npm i jsdom) — тест извлечения страницы пропущен.");
  process.exit(0);
}

const ROOT = path.join(__dirname, "..", "ask-any-llm");
const readabilitySrc = fs.readFileSync(path.join(ROOT, "readability", "Readability.js"), "utf8");
const contentSrc = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");

const ARTICLE = `<!DOCTYPE html><html lang="ru"><head><title>Нерпа Байкала — журнал</title></head><body>
<nav class="menu"><a href="/">Главная</a><a href="/ads">Реклама</a><a href="/x">Ещё</a><a href="/y">Ссылки</a></nav>
<div class="banner">Купи подписку со скидкой 90%! Жми сюда! Купи подписку со скидкой!</div>
<article>
<h1>Нерпа Байкала</h1>
<p>Байкальская нерпа — один из трёх пресноводных видов тюленей в мире и единственный, живущий в озере Байкал. Взрослая нерпа достигает длины около 130 сантиметров и веса до 70 килограммов. Это эндемик озера: больше нигде на планете такой вид не встречается.</p>
<p>Учёные считают, что предки нерпы попали в Байкал из Северного Ледовитого океана по системе рек в эпоху оледенения. Генетические исследования показывают родство с арктической кольчатой нерпой, хотя точный маршрут миграции до сих пор обсуждается в научной литературе.</p>
<p>Зимой нерпа строит на льду снежные логова, где щенится в конце февраля. Детёныш рождается с белым мехом и весит около трёх килограммов. Мать кормит его молоком жирностью до 60 процентов, поэтому малыш быстро набирает вес и уже через месяц выходит к воде.</p>
<p>Питается нерпа в основном голомянкой и бычками. За год одна особь съедает около тонны рыбы, что делает её важным регулятором рыбных запасов озера. Зимой она поддерживает во льду продухи, чтобы дышать, и эти же отверстия используют другие животные.</p>
<p>Популяция оценивается в несколько десятков тысяч особей. Основные угрозы — браконьерство, изменение климата и сокращение ледового покрова, из-за которого щенкам негде строить логова. Природоохранные организации ведут мониторинг с помощью авиаучётов и спутниковых меток.</p>
</article>
<footer>© 2026 Журнал. Все права защищены. Подписывайтесь на рассылку и пишите нам в соцсети.</footer>
</body></html>`;

const SPARSE = `<!DOCTYPE html><html><head><title>Пустая страница</title></head><body>
<div id="app">Загрузка…</div><script>var x = 1;</script>
</body></html>`;

function loadPage(html, url) {
  const dom = new JSDOM(html, { url: url || "https://example.com/nerpa", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  const listeners = [];
  w.chrome = { runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } } };
  w.eval(readabilitySrc);
  w.eval(contentSrc);
  return { dom, w, call: (msg) => new Promise((res) => listeners[0](msg, {}, res)), listeners };
}

let passed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ok  " + name); }
  else { console.error("  FAIL " + name + (extra ? "\n       " + extra : "")); process.exitCode = 1; }
}

(async function run() {
  console.log("\n== content.js + Readability (jsdom) ==");

  const page = loadPage(ARTICLE);
  ok("PING отвечает", (await page.call({ type: "PING" })).ok === true);
  ok("один слушатель после загрузки", page.listeners.length === 1);

  // повторная инъекция не должна плодить слушатели
  page.w.eval(contentSrc);
  ok("защита от повторной инъекции", page.listeners.length === 1);

  const res = await page.call({ type: "EXTRACT_PAGE" });
  ok("извлечение успешно", res.ok === true, JSON.stringify(res).slice(0, 300));
  ok("метод readability", res.method === "readability", "method=" + res.method);
  ok("заголовок статьи", /Нерпа Байкала/.test(res.title), res.title);
  ok("URL страницы", res.url === "https://example.com/nerpa", res.url);
  ok("текст статьи на месте", res.text.includes("эндемик озера") && res.text.includes("продухи"));
  ok("реклама вырезана", !res.text.includes("Купи подписку"), res.text.slice(0, 200));
  ok("футер вырезан", !res.text.includes("Все права защищены"));
  ok("длина адекватная", res.length > 800 && res.length < 4000, "length=" + res.length);
  ok("DOM страницы не сломан (клон)", page.w.document.querySelector("article p") !== null);

  const sparse = loadPage(SPARSE, "https://example.com/empty");
  const res2 = await sparse.call({ type: "EXTRACT_PAGE" });
  ok("слабая страница: fallback", res2.ok === true && res2.method === "innerText", JSON.stringify(res2).slice(0, 200));
  ok("fallback отдаёт видимый текст", res2.text.includes("Загрузка"));

  // выделение текста
  const sel = page.w.getSelection();
  const range = page.w.document.createRange();
  range.selectNodeContents(page.w.document.querySelector("article p"));
  sel.removeAllRanges();
  sel.addRange(range);
  const selRes = await page.call({ type: "GET_SELECTION" });
  ok("GET_SELECTION возвращает выделение", selRes.ok && selRes.text.startsWith("Байкальская нерпа"), selRes.text.slice(0, 60));

  console.log("\nПройдено проверок: " + passed + "\n");
})();
