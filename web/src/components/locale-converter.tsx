"use client";

import { useEffect } from "react";

import { currentLocale } from "@/lib/locale";

const HAN = /[一-鿿]/;
const ATTRIBUTES = ["placeholder", "title", "aria-label", "alt"];
// UI wording OpenCC's Taiwan preset still leaves in mainland style
const OVERRIDES: [string, string][] = [
  ["賬號", "帳號"],
  ["賬戶", "帳戶"],
  ["新建", "新增"],
  ["會話", "對話"],
];
// What the user typed stays as written: form fields, editable areas, and anything marked translate="no"
// (prompts, conversation titles). Input values aren't text nodes, so only their placeholders convert.
const KEEP_TEXT = "script,style,textarea,[contenteditable=true],[translate=no]";
const KEEP = "[translate=no]";

/** zh-TW: converts the Simplified-Chinese page in place, then keeps converting whatever React renders
 *  later (toasts, dialogs, server messages) via a MutationObserver. */
export function LocaleConverter() {
  useEffect(() => {
    if (currentLocale() !== "zh-TW") {
      return;
    }
    const root = document.documentElement;
    let observer: MutationObserver | undefined;
    let cancelled = false;

    import("opencc-js/cn2t")
      .then(({ Converter }) => {
        if (cancelled) {
          return;
        }
        const toTaiwan = Converter({ from: "cn", to: "twp" });
        const convert = (text: string) =>
          OVERRIDES.reduce((out, [from, to]) => out.split(from).join(to), toTaiwan(text));

        const convertAttributes = (element: Element) => {
          for (const name of ATTRIBUTES) {
            const value = element.getAttribute(name);
            if (value && HAN.test(value)) {
              const next = convert(value);
              if (next !== value) {
                element.setAttribute(name, next);
              }
            }
          }
        };
        // Writes only when the text changes, so our own mutations settle instead of looping.
        const visit = (node: Node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.nodeValue ?? "";
            if (HAN.test(text) && !node.parentElement?.closest(KEEP_TEXT)) {
              const next = convert(text);
              if (next !== text) {
                node.nodeValue = next;
              }
            }
          } else if (node instanceof Element && !node.closest(KEEP)) {
            convertAttributes(node);
            node.childNodes.forEach(visit);
          }
        };
        const convertTitle = () => {
          const next = convert(document.title);
          if (next !== document.title) {
            document.title = next;
          }
        };

        visit(document.body);
        convertTitle();
        observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (mutation.type === "childList") {
              mutation.addedNodes.forEach(visit);
            } else if (mutation.type === "characterData") {
              visit(mutation.target);
            } else if (mutation.target instanceof Element && !mutation.target.closest(KEEP)) {
              convertAttributes(mutation.target);
            }
          }
          convertTitle();
        });
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ATTRIBUTES,
        });
      })
      .catch(() => undefined) // converter failed to load: stay in Simplified rather than break the page
      .finally(() => root.classList.remove("locale-pending"));

    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, []);

  return null;
}
