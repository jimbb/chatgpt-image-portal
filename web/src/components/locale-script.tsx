import { LOCALE_STORAGE_KEY } from "@/lib/locale";

// Runs before first paint: saved choice, else browser language (zh-TW/HK/MO/Hant -> Traditional).
// For zh-TW the page stays hidden until LocaleConverter has converted it, so Simplified never flashes
// (3s fail-safe in case the converter can't load).
const localeScript = `
(() => {
  const root = document.documentElement;
  try {
    const saved = localStorage.getItem("${LOCALE_STORAGE_KEY}");
    const locale = saved === "zh-TW" || saved === "zh-CN" ? saved
      : /^zh-(TW|HK|MO)|Hant/i.test(navigator.language) ? "zh-TW" : "zh-CN";
    root.dataset.locale = locale;
    root.lang = locale;
    if (locale === "zh-TW") {
      root.classList.add("locale-pending");
      setTimeout(() => root.classList.remove("locale-pending"), 3000);
    }
  } catch {
    root.dataset.locale = "zh-CN";
  }
})();
`;

export function LocaleScript() {
  return <script dangerouslySetInnerHTML={{ __html: localeScript }} />;
}
