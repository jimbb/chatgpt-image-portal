"use client";

import localforage from "localforage";
import { Check, ChevronDown, Images, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { currentLocale } from "@/lib/locale";
import type { StoredReferenceImage } from "@/store/image-conversations";

// Named groups of reference images kept in this browser (IndexedDB, like the chat history), so a set
// used for 逐张参考 doesn't have to be uploaded again every time
type ReferenceSet = { id: string; name: string; images: StoredReferenceImage[]; createdAt: string };

const referenceSetStorage = localforage.createInstance({ name: "chatgpt2api", storeName: "reference_sets" });
const REFERENCE_SETS_KEY = "items";

type ReferenceSetsMenuProps = {
  referenceImages: StoredReferenceImage[];
  onLoad: (images: StoredReferenceImage[]) => void;
};

export function ReferenceSetsMenu({ referenceImages, onLoad }: ReferenceSetsMenuProps) {
  const [open, setOpen] = useState(false);
  const [sets, setSets] = useState<ReferenceSet[]>([]);
  const [name, setName] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null); // the set whose photos are shown to pick from
  const [picked, setPicked] = useState<number[]>([]); // indexes in the expanded set, in pick order

  useEffect(() => {
    if (open) {
      void referenceSetStorage.getItem<ReferenceSet[]>(REFERENCE_SETS_KEY).then((items) => setSets(items || []));
    }
  }, [open]);

  const write = async (next: ReferenceSet[]) => {
    await referenceSetStorage.setItem(REFERENCE_SETS_KEY, next);
    setSets(next);
  };

  const load = (images: StoredReferenceImage[]) => {
    onLoad(images);
    setOpen(false);
    setExpandedId(null);
    setPicked([]);
  };

  const toggleExpanded = (id: string) => {
    setExpandedId((current) => (current === id ? null : id));
    setPicked([]);
  };

  const togglePicked = (index: number) =>
    setPicked((current) => (current.includes(index) ? current.filter((item) => item !== index) : [...current, index]));

  const save = async () => {
    const label = name.trim() || `${currentLocale() === "zh-TW" ? "參考集" : "参考集"} ${sets.length + 1}`;
    const saved = { id: `${Date.now()}`, name: label, images: referenceImages, createdAt: new Date().toISOString() };
    await write([saved, ...sets.filter((set) => set.name !== label)]); // same name overwrites
    setName("");
    toast.success(`已保存参考集「${label}」（${referenceImages.length} 张）`);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          title="参考集：保存一组参考图，下次一键载入"
          className="h-9 shrink-0 rounded-full border-stone-200 bg-white px-3 text-xs font-medium text-stone-700 shadow-none sm:h-10 sm:px-4 sm:text-sm"
        >
          <Images className="size-3.5 sm:size-4" />
          <span className="hidden sm:inline">参考集</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 space-y-3 rounded-2xl p-3 text-sm">
        {sets.length === 0 ? (
          <p className="px-1 text-xs text-stone-500">还没有参考集。添加参考图后可以在下面保存。</p>
        ) : (
          <div className="max-h-[26rem] space-y-1 overflow-y-auto">
            {sets.map((set) => {
              const expanded = expandedId === set.id;
              return (
                <div key={set.id} className={cn("rounded-xl", expanded && "bg-stone-50 dark:bg-white/5")}>
                  <div className="flex items-center gap-2 rounded-xl p-1.5 hover:bg-stone-50 dark:hover:bg-white/5">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      title="展开，挑选要载入的照片"
                      onClick={() => toggleExpanded(set.id)}
                    >
                      <div className="flex shrink-0 -space-x-2">
                        {set.images.slice(0, 3).map((image, index) => (
                          <img key={index} src={image.dataUrl} alt="" className="size-8 rounded-lg border-2 border-white object-cover" />
                        ))}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-stone-800 dark:text-stone-100" translate="no">{set.name}</div>
                        <div className="text-xs text-stone-500">{set.images.length} 张</div>
                      </div>
                      <ChevronDown className={cn("size-4 shrink-0 text-stone-400 transition", expanded && "rotate-180")} />
                    </button>
                    <button
                      type="button"
                      className="shrink-0 rounded-full px-2 py-1 text-xs font-medium text-stone-600 hover:bg-stone-200/70 dark:text-stone-300 dark:hover:bg-white/10"
                      title="载入这组的全部照片"
                      onClick={() => load(set.images)}
                    >
                      全部载入
                    </button>
                    <button
                      type="button"
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-stone-400 hover:bg-rose-50 hover:text-rose-600"
                      aria-label={`删除参考集 ${set.name}`}
                      onClick={() => void write(sets.filter((item) => item.id !== set.id))}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  {expanded ? (
                    <div className="space-y-2 px-1.5 pb-2">
                      <div className="grid grid-cols-5 gap-1.5">
                        {set.images.map((image, index) => {
                          const order = picked.indexOf(index);
                          return (
                            <button
                              key={index}
                              type="button"
                              onClick={() => togglePicked(index)}
                              className={cn(
                                "relative aspect-square overflow-hidden rounded-lg border-2 transition",
                                order >= 0 ? "border-sky-500" : "border-transparent opacity-80 hover:opacity-100",
                              )}
                              aria-pressed={order >= 0}
                              aria-label={`照片 ${index + 1}`}
                            >
                              <img src={image.dataUrl} alt="" className="h-full w-full object-cover" />
                              {order >= 0 ? (
                                <span className="absolute right-0.5 top-0.5 inline-flex size-4 items-center justify-center rounded-full bg-sky-500 text-[10px] font-semibold text-white">
                                  {order + 1}
                                </span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-xs text-stone-500 hover:text-stone-800 dark:hover:text-stone-200"
                          onClick={() => setPicked(picked.length === set.images.length ? [] : set.images.map((_, index) => index))}
                        >
                          <Check className="size-3.5" />
                          {picked.length === set.images.length ? "清除" : "全选"}
                        </button>
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 rounded-lg text-xs"
                          disabled={picked.length === 0}
                          onClick={() => load(picked.map((index) => set.images[index]))}
                        >
                          载入所选 {picked.length} 张
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        <div className="flex gap-1.5 border-t border-stone-100 pt-3 dark:border-white/10">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && referenceImages.length > 0) {
                event.preventDefault();
                void save();
              }
            }}
            placeholder="名称（同名会覆盖）"
            className="h-8 text-xs"
          />
          <Button
            type="button"
            size="sm"
            className="h-8 shrink-0 rounded-lg text-xs"
            disabled={referenceImages.length === 0}
            onClick={() => void save()}
          >
            保存当前 {referenceImages.length} 张
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
