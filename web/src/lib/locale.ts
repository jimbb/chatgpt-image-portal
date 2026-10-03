// UI language. The UI source is Simplified Chinese; zh-TW is produced by converting the rendered page
// (OpenCC, Taiwan phrasing) in components/locale-converter.tsx. components/locale-script.tsx picks the
// locale before first paint and stores it on <html data-locale>.
export const LOCALES = { "zh-CN": "简体中文", "zh-TW": "繁體中文" } as const;
export type Locale = keyof typeof LOCALES;
export const LOCALE_STORAGE_KEY = "chatgpt2api-locale";

export function currentLocale(): Locale {
  return document.documentElement.dataset.locale === "zh-TW" ? "zh-TW" : "zh-CN";
}

export function setLocale(locale: Locale) {
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  window.location.reload(); // re-render from the Simplified source, converting again if needed
}
