"use client";

import { useEffect, useState } from "react";

import { getImmediateCachedImageSource, resolveCachedImage } from "@/lib/image-cache";

type CachedSourceState = {
  source: string;
  src: string | null;
};

export function useCachedImageSource(source: string, enabled = true) {
  const [state, setState] = useState<CachedSourceState>(() => ({
    source,
    src: getImmediateCachedImageSource(source),
  }));
  const currentSrc = state.source === source ? state.src : getImmediateCachedImageSource(source);

  useEffect(() => {
    const immediate = getImmediateCachedImageSource(source);
    setState({ source, src: immediate });
    if (!enabled || !source || immediate) return;

    let active = true;
    void resolveCachedImage(source)
      .then((resolved) => {
        if (active) setState({ source, src: resolved.src });
      })
      .catch(() => {
        // 跨域图片无法由脚本缓存时回退到浏览器原生图片加载。
        if (active) setState({ source, src: source });
      });
    return () => {
      active = false;
    };
  }, [enabled, source]);

  return currentSrc;
}
