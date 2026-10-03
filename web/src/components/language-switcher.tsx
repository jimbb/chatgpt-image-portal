"use client";

import { Languages } from "lucide-react";
import { useSyncExternalStore } from "react";

import { LOCALES, currentLocale, setLocale, type Locale } from "@/lib/locale";

// The locale only changes through setLocale(), which reloads the page, so there's nothing to subscribe to.
const subscribe = () => () => {};
const serverLocale = (): Locale => "zh-CN";

// translate="no": each language name stays in its own script (简体中文 / 繁體中文)
export function LanguageSwitcher() {
  const locale = useSyncExternalStore(subscribe, currentLocale, serverLocale);

  return (
    <label
      translate="no"
      className="inline-flex h-8 shrink-0 items-center gap-1 text-stone-500 transition hover:text-stone-900 dark:text-stone-300 dark:hover:text-white"
    >
      <Languages className="size-4" aria-hidden />
      <span className="sr-only">Language</span>
      <select
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
        className="cursor-pointer bg-transparent text-sm outline-none dark:bg-stone-900"
      >
        {Object.entries(LOCALES).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
