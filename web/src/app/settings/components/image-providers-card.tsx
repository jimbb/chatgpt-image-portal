"use client";

import { ArrowDown, ArrowUp, Eye, EyeOff, FlaskConical, LoaderCircle, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createImageProvider,
  deleteImageProvider,
  fetchImageProviders,
  saveImageProviderOrder,
  testImageProvider,
  updateImageProvider,
  type ImageProvider,
  type ImageProviderStats,
  type ImageProviderTestResult,
  type ImageProvidersView,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const CHATGPT_POOL = "chatgpt";

type ProviderForm = {
  name: string;
  base_url: string;
  api_key: string;
  models: string;
  async_poll: boolean;
  enabled: boolean;
};

const EMPTY_FORM: ProviderForm = { name: "", base_url: "", api_key: "", models: "", async_poll: false, enabled: true };

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

const DEFAULT_TEST_PROMPT = "a red apple on a white table, studio photo";

type TestTarget = { id: string; name: string; models: string[] };

function StatsBadge({ stats }: { stats?: ImageProviderStats }) {
  if (!stats || stats.total === 0 || stats.rate == null) {
    return <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-500">暂无记录</span>;
  }
  const details = [
    `最近 ${stats.total} 次：成功 ${stats.success} 次`,
    stats.avg_ms ? `成功平均用时 ${(stats.avg_ms / 1000).toFixed(1)} 秒` : "",
    stats.last_error ? `最近失败：${stats.last_error}` : "",
  ].filter(Boolean);
  return (
    <span
      title={details.join("\n")}
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium",
        stats.rate >= 70 ? "bg-emerald-50 text-emerald-700" : stats.rate >= 30 ? "bg-amber-50 text-amber-700" : "bg-rose-50 text-rose-700",
      )}
    >
      近 {stats.total} 次成功 {stats.rate}%
    </span>
  );
}

/** Settings → 生图渠道: external OpenAI-compatible image APIs, tried top to bottom together with the
 *  ChatGPT account pool; a provider that fails or runs out of balance falls through to the next. */
export function ImageProvidersCard() {
  const [view, setView] = useState<ImageProvidersView | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ImageProvider | null>(null);
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [showKey, setShowKey] = useState(false);
  const [testTarget, setTestTarget] = useState<TestTarget | null>(null);
  const [testModel, setTestModel] = useState("");
  const [testPrompt, setTestPrompt] = useState(DEFAULT_TEST_PROMPT);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<ImageProviderTestResult | null>(null);

  const run = useCallback(async (action: () => Promise<ImageProvidersView>, success?: string) => {
    setBusy(true);
    try {
      setView(await action());
      if (success) {
        toast.success(success);
      }
      return true;
    } catch (error) {
      toast.error(errorText(error, "操作失败"));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchImageProviders()
      .then((data) => !cancelled && setView(data))
      .catch((error) => toast.error(errorText(error, "读取生图渠道失败")));
    return () => {
      cancelled = true;
    };
  }, []);

  const providers = new Map((view?.providers ?? []).map((provider) => [provider.id, provider]));
  const order = view?.order ?? [];

  const move = (index: number, delta: number) => {
    const next = [...order];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    void run(() => saveImageProviderOrder(next));
  };

  const openDialog = (provider: ImageProvider | null) => {
    setEditing(provider);
    setShowKey(false);
    setForm(
      provider
        ? {
            name: provider.name,
            base_url: provider.base_url,
            api_key: "",
            models: provider.models.join("\n"),
            async_poll: provider.async_poll,
            enabled: provider.enabled,
          }
        : EMPTY_FORM,
    );
    setDialogOpen(true);
  };

  const save = async () => {
    const input = {
      name: form.name.trim(),
      base_url: form.base_url.trim(),
      api_key: form.api_key.trim(),
      models: form.models.split(/[\n,]/).map((model) => model.trim()).filter(Boolean),
      async_poll: form.async_poll,
      enabled: form.enabled,
    };
    const ok = await run(
      () => (editing ? updateImageProvider(editing.id, input) : createImageProvider(input)),
      editing ? "渠道已保存" : "渠道已添加",
    );
    if (ok) {
      setDialogOpen(false);
    }
  };

  const openTest = (target: TestTarget) => {
    setTestTarget(target);
    setTestModel(target.models[0] ?? "");
    setTestResult(null);
  };

  const runTest = async () => {
    if (!testTarget || !testModel) {
      return;
    }
    setIsTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testImageProvider(testTarget.id, testModel, testPrompt.trim() || DEFAULT_TEST_PROMPT));
      setView(await fetchImageProviders()); // the test counts toward the success rate
    } catch (error) {
      setTestResult({ ok: false, error: errorText(error, "测试请求失败"), duration_ms: 0 });
    } finally {
      setIsTesting(false);
    }
  };

  const remove = (provider: ImageProvider) => {
    if (window.confirm(`确认删除渠道「${provider.name}」吗？`)) {
      void run(() => deleteImageProvider(provider.id), "渠道已删除");
    }
  };

  return (
    <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
      <CardContent className="space-y-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl space-y-1 text-sm leading-6 text-stone-600">
            <p className="font-semibold text-stone-900">生图渠道与优先顺序</p>
            <p>
              每张图从上到下依次尝试：渠道失败、余额不足或不提供所选模型时，自动换下一个。其他渠道生成的图片同样保存到本地图库。
            </p>
          </div>
          <Button className="h-10 rounded-xl bg-stone-950 px-4 text-white hover:bg-stone-800" onClick={() => openDialog(null)}>
            <Plus className="size-4" />
            添加渠道
          </Button>
        </div>

        {!view ? (
          <div className="flex justify-center p-8">
            <LoaderCircle className="size-5 animate-spin text-stone-400" />
          </div>
        ) : (
          <div className="divide-y divide-stone-100 rounded-xl border border-stone-200">
            {order.map((id, index) => {
              const provider = providers.get(id);
              const isPool = id === CHATGPT_POOL;
              if (!isPool && !provider) {
                return null;
              }
              const enabled = isPool ? view.chatgpt_pool_enabled : provider!.enabled;
              return (
                <div key={id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-stone-100 text-xs font-semibold text-stone-700">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-stone-900">
                      {isPool ? <span>ChatGPT 号池</span> : <span translate="no">{provider!.name}</span>}
                      {isPool ? (
                        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-500">内置 · 本地账号</span>
                      ) : provider!.has_api_key ? (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                          Key …{provider!.api_key_hint}
                        </span>
                      ) : (
                        <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">未设置 Key，暂不使用</span>
                      )}
                      {!isPool && provider!.async_poll ? (
                        <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">异步轮询</span>
                      ) : null}
                      <StatsBadge stats={view.stats[id]} />
                    </div>
                    <div className="truncate text-xs text-stone-500" translate={isPool ? undefined : "no"}>
                      {isPool ? "账号管理页里的 ChatGPT 账号" : `${provider!.base_url} · ${provider!.models.join("、")}`}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-stone-600">
                    <Checkbox
                      checked={enabled}
                      disabled={busy}
                      onCheckedChange={(checked) =>
                        void run(() =>
                          isPool
                            ? saveImageProviderOrder(order, Boolean(checked))
                            : updateImageProvider(provider!.id, { enabled: Boolean(checked) }),
                        )
                      }
                    />
                    启用
                  </label>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-8 rounded-lg"
                      aria-label="测试"
                      title={isPool || provider!.has_api_key ? "用这个渠道真实生成一张测试图" : "先设置 API Key 才能测试"}
                      disabled={busy || isTesting || (!isPool && !provider!.has_api_key)}
                      onClick={() =>
                        openTest({
                          id,
                          name: isPool ? "ChatGPT 号池" : provider!.name,
                          models: isPool ? view.pool_models : provider!.models.map((entry) => entry.split("=")[0].trim()),
                        })
                      }
                    >
                      <FlaskConical className="size-4" />
                    </Button>
                    <Button variant="outline" size="icon" className="size-8 rounded-lg" aria-label="上移" disabled={busy || index === 0} onClick={() => move(index, -1)}>
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button variant="outline" size="icon" className="size-8 rounded-lg" aria-label="下移" disabled={busy || index === order.length - 1} onClick={() => move(index, 1)}>
                      <ArrowDown className="size-4" />
                    </Button>
                    {!isPool ? (
                      <>
                        <Button variant="outline" size="icon" className="size-8 rounded-lg" aria-label="编辑" disabled={busy} onClick={() => openDialog(provider!)}>
                          <Pencil className="size-4" />
                        </Button>
                        <Button variant="outline" size="icon" className="size-8 rounded-lg text-rose-600 hover:text-rose-700" aria-label="删除" disabled={busy} onClick={() => remove(provider!)}>
                          <Trash2 className="size-4" />
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <Dialog open={testTarget !== null} onOpenChange={(open) => !open && !isTesting && setTestTarget(null)}>
        <DialogContent showCloseButton={false} className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>测试渠道：<span translate="no">{testTarget?.name}</span></DialogTitle>
            <DialogDescription className="text-sm leading-6">
              只通过这个渠道真实生成一张图（不走优先顺序），会消耗该渠道一次生成额度，结果计入成功率。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">模型</label>
              <select
                value={testModel}
                onChange={(event) => setTestModel(event.target.value)}
                disabled={isTesting}
                className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-sm dark:bg-stone-900"
              >
                {(testTarget?.models ?? []).map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">测试提示词</label>
              <Input value={testPrompt} onChange={(e) => setTestPrompt(e.target.value)} disabled={isTesting} className="h-11 rounded-xl" />
            </div>
            {isTesting ? (
              <div className="flex items-center gap-2 rounded-xl bg-stone-50 px-4 py-3 text-sm text-stone-600">
                <LoaderCircle className="size-4 animate-spin" />
                生成中，通常需要 30 秒到 3 分钟…
              </div>
            ) : testResult?.ok ? (
              <div className="space-y-2">
                {testResult.url ? <img src={testResult.url} alt="测试结果" className="max-h-72 rounded-xl border border-stone-200" /> : null}
                <p className="text-sm text-emerald-700">成功，用时 {(testResult.duration_ms / 1000).toFixed(1)} 秒</p>
              </div>
            ) : testResult ? (
              <div className="rounded-xl bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700">
                失败{testResult.duration_ms ? `（${(testResult.duration_ms / 1000).toFixed(1)} 秒）` : ""}：{testResult.error}
              </div>
            ) : null}
          </div>
          <DialogFooter className="pt-2">
            <Button
              variant="secondary"
              className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200"
              onClick={() => setTestTarget(null)}
              disabled={isTesting}
            >
              关闭
            </Button>
            <Button className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800" onClick={() => void runTest()} disabled={isTesting || !testModel}>
              {isTesting ? <LoaderCircle className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
              开始测试
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent showCloseButton={false} className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>{editing ? "编辑渠道" : "添加渠道"}</DialogTitle>
            <DialogDescription className="text-sm leading-6">OpenAI 兼容的生图接口（/images/generations 与 /images/edits）。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">名称</label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：fallback-example" className="h-11 rounded-xl" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">API 地址</label>
              <Input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://example.com/v1" className="h-11 rounded-xl" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">API Key</label>
              <div className="relative">
                <Input
                  type={showKey ? "text" : "password"}
                  value={form.api_key}
                  onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                  placeholder={editing?.has_api_key ? `留空则不修改（当前 …${editing.api_key_hint}）` : "sk-..."}
                  className="h-11 rounded-xl pr-10"
                  autoComplete="off"
                />
                <button type="button" className="absolute top-1/2 right-3 -translate-y-1/2 text-stone-400 hover:text-stone-600" onClick={() => setShowKey(!showKey)}>
                  {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">模型（每行一个）</label>
              <Textarea
                value={form.models}
                onChange={(e) => setForm({ ...form, models: e.target.value })}
                placeholder={"gpt-image-2.5\ngpt-image-2\ngpt-image-2.5-sunburst=gpt-image-2.5"}
                className="min-h-28 rounded-xl font-mono text-xs"
              />
              <p className="text-xs leading-5 text-stone-500">
                名称不同时写成「界面模型=渠道模型」，例如 gpt-image-2.5-sunburst=gpt-image-2.5：在界面选 sunburst 时，这个渠道用它的 gpt-image-2.5 生成。
              </p>
            </div>
            <label className="flex items-start gap-2 text-sm text-stone-700">
              <Checkbox checked={form.async_poll} onCheckedChange={(checked) => setForm({ ...form, async_poll: Boolean(checked) })} className="mt-0.5" />
              <span>
                异步提交并轮询
                <span className="block text-xs text-stone-500">chatgpt2api 类站点（如 async-example）勾选：避免 Cloudflare 100 秒超时导致重复扣费。</span>
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm text-stone-700">
              <Checkbox checked={form.enabled} onCheckedChange={(checked) => setForm({ ...form, enabled: Boolean(checked) })} />
              启用
            </label>
          </div>
          <DialogFooter className="pt-2">
            <Button variant="secondary" className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200" onClick={() => setDialogOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800" onClick={() => void save()} disabled={busy}>
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
              {editing ? "保存" : "添加"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
