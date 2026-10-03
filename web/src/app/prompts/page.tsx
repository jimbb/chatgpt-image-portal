"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Copy, ExternalLink, ImageIcon, Search } from "lucide-react";
import { toast } from "sonner";

import { ImageLightbox } from "@/components/image-lightbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fetchPromptLibrary, type PromptLibraryItem } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { listImageConversations, type ImageConversation, type StoredImage } from "@/store/image-conversations";

type PromptImage = StoredImage & { src?: string; conversationId?: string; conversationTitle?: string };
type PromptEntry = {
  key: string;
  prompt: string;
  model: string;
  latest: string;
  images: PromptImage[];
};

function sourceFor(image: StoredImage) {
  const item = image as StoredImage & { src?: string };
  return item.src || image.url || (image.b64_json ? `data:image/png;base64,${image.b64_json}` : "");
}

function titleFor(prompt: string) {
  const line = prompt.trim().split(/\s*\n\s*/)[0] || "未命名提示词";
  return line.length > 72 ? `${line.slice(0, 72)}…` : line;
}

function buildEntries(conversations: ImageConversation[]): PromptEntry[] {
  const grouped = new Map<string, PromptEntry>();
  for (const conversation of conversations) {
    for (const turn of conversation.turns) {
      const prompt = turn.prompt.trim();
      if (!prompt || turn.promptDeleted) continue;
      const key = `${turn.model}\n${prompt}`;
      const current = grouped.get(key) || {
        key,
        prompt,
        model: turn.model,
        latest: turn.createdAt,
        images: [],
      };
      current.latest = current.latest > turn.createdAt ? current.latest : turn.createdAt;
      if (!turn.resultsDeleted) {
        current.images.push(
          ...turn.images
            .filter((image) => image.status === "success" && Boolean(sourceFor(image)))
            .map((image) => ({ ...image, conversationId: conversation.id, conversationTitle: conversation.title })),
        );
      }
      grouped.set(key, current);
    }
  }
  return [...grouped.values()].sort((a, b) => b.latest.localeCompare(a.latest));
}

function mapRemoteEntry(item: PromptLibraryItem): PromptEntry {
  return {
    key: item.key,
    prompt: item.prompt,
    model: item.model,
    latest: item.latest,
    images: item.images.map((image) => ({ id: image.id, src: image.src, taskId: image.task_id, status: "success" as const })),
  };
}

function PromptLibraryContent() {
  const [entries, setEntries] = useState<PromptEntry[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ entry: PromptEntry; index: number } | null>(null);

  useEffect(() => {
    void Promise.all([listImageConversations(), fetchPromptLibrary()])
      .then(([conversations, remote]) => {
        const local = buildEntries(conversations);
        const items = remote.items.length > 0 ? remote.items.map(mapRemoteEntry) : local;
        setEntries(items);
      })
      .catch(() => toast.error("加载提示词库失败"))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return entries;
    return entries.filter((entry) => `${entry.prompt} ${entry.model}`.toLowerCase().includes(normalized));
  }, [entries, query]);

  const copyPrompt = async (prompt: string) => {
    await navigator.clipboard.writeText(prompt);
    setCopied(prompt);
    toast.success("提示词已复制");
    window.setTimeout(() => setCopied((current) => (current === prompt ? null : current)), 1200);
  };

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <div className="text-xs font-semibold tracking-[0.18em] text-stone-500 uppercase">Prompt Library</div>
          <h1 className="text-2xl font-semibold tracking-tight">提示词库</h1>
          <p className="text-sm text-stone-500">浏览用过的提示词和它们生成的结果，复制或再次生成。</p>
        </div>
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索提示词或模型" className="h-10 rounded-xl border-stone-200 bg-white pl-9" />
        </div>
      </div>

      {loading ? (
        <div className="rounded-2xl border border-stone-200 bg-white p-12 text-center text-sm text-stone-400">正在加载提示词…</div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-stone-300 bg-white/70 p-14 text-center">
          <ImageIcon className="size-9 text-stone-300" />
          <p className="font-medium text-stone-600">还没有保存的提示词结果</p>
          <p className="text-sm text-stone-400">在画图页生成图片后，这里会自动按提示词归档。</p>
          <Link href="/image"><Button className="mt-2 rounded-xl bg-stone-950 text-white hover:bg-stone-800">开始画图</Button></Link>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((entry) => {
            const first = entry.images[0];
            const images = entry.images.slice(0, 4);
            return (
              <Card key={entry.key} className="overflow-hidden rounded-2xl border-stone-200 bg-white shadow-sm">
                <div className="grid aspect-[4/3] grid-cols-2 gap-1 bg-stone-100">
                  {images.length > 0 ? images.map((image, index) => (
                    <button key={`${image.id}-${index}`} type="button" className="group relative min-h-0 overflow-hidden bg-stone-100" onClick={() => setLightbox({ entry, index })}>
                      <img src={sourceFor(image)} alt={entry.prompt} className="size-full object-cover transition duration-300 group-hover:scale-105" />
                    </button>
                  )) : <div className="col-span-2 flex items-center justify-center text-sm text-stone-400">暂无成功结果</div>}
                </div>
                <CardContent className="space-y-4 p-5">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="line-clamp-2 text-base leading-6 font-semibold text-stone-800">{titleFor(entry.prompt)}</h2>
                    <Badge variant="secondary" className="shrink-0 rounded-md bg-stone-100 text-stone-600">{entry.images.length} 张</Badge>
                  </div>
                  <p className="line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-stone-500">{entry.prompt}</p>
                  <div className="flex items-center justify-between gap-2 text-xs text-stone-400">
                    <span>{entry.model}</span>
                    <span>{entry.latest.slice(0, 16)}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link href={`/image?prompt=${encodeURIComponent(entry.prompt)}`}><Button size="sm" className="rounded-lg bg-stone-950 text-white hover:bg-stone-800"><ExternalLink className="size-3.5" />再次生成</Button></Link>
                    <Button size="sm" variant="outline" className="rounded-lg border-stone-200" onClick={() => void copyPrompt(entry.prompt)}>{copied === entry.prompt ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}复制</Button>
                    {first?.conversationId ? <Link href={`/image?conversation=${encodeURIComponent(first.conversationId)}&image=${encodeURIComponent(first.id)}`}><Button size="sm" variant="ghost" className="rounded-lg text-stone-500">打开结果</Button></Link> : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {lightbox ? <ImageLightbox images={lightbox.entry.images.map((image) => ({ id: image.id, src: sourceFor(image) }))} currentIndex={lightbox.index} open onOpenChange={(open) => !open && setLightbox(null)} onIndexChange={(index) => setLightbox((current) => current ? { ...current, index } : current)} /> : null}
    </section>
  );
}

export default function PromptsPage() {
  const { isCheckingAuth, session } = useAuthGuard();
  if (isCheckingAuth || !session) return null;
  return <PromptLibraryContent />;
}
