"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, LoaderCircle, Ticket, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createCdks, disableCdk, fetchCdks, type CdkItem } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";

function statusLabel(status: CdkItem["status"]) {
  if (status === "redeemed") return "已兑换";
  if (status === "disabled") return "已禁用";
  return "未使用";
}

export default function CdksPage() {
  const { isCheckingAuth } = useAuthGuard(["admin"]);
  const [items, setItems] = useState<CdkItem[]>([]);
  const [generatedItems, setGeneratedItems] = useState<CdkItem[]>([]);
  const [creditAmount, setCreditAmount] = useState("20");
  const [count, setCount] = useState("10");
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);

  const loadCdks = useCallback(async () => {
    try {
      const data = await fetchCdks();
      setItems(data.items);
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取 CDK 失败";
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isCheckingAuth) {
      void loadCdks();
    }
  }, [isCheckingAuth, loadCdks]);

  const handleCreate = async () => {
    const parsedCreditAmount = Math.max(1, Number(creditAmount) || 0);
    const parsedCount = Math.max(1, Number(count) || 0);
    setIsCreating(true);
    try {
      const data = await createCdks(parsedCreditAmount, parsedCount);
      setGeneratedItems(data.items);
      toast.success(`已生成 ${data.items.length} 个 CDK`);
      await loadCdks();
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成 CDK 失败";
      toast.error(message);
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopyGenerated = async () => {
    const text = generatedItems.map((item) => item.code).filter(Boolean).join("\n");
    if (!text) return;
    await navigator.clipboard.writeText(text);
    toast.success("已复制本次生成的 CDK");
  };

  const handleDisable = async (item: CdkItem) => {
    try {
      await disableCdk(item.id);
      toast.success("已禁用 CDK");
      await loadCdks();
    } catch (error) {
      const message = error instanceof Error ? error.message : "禁用失败";
      toast.error(message);
    }
  };

  if (isCheckingAuth || isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return (
    <section className="mx-auto w-full max-w-6xl space-y-5 px-3 pb-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-stone-950">CDK 管理</h1>
          <p className="mt-1 text-sm text-stone-500">生成固定额度 CDK，用户兑换后自动到账。</p>
        </div>
      </div>

      <Card className="rounded-[28px] border-white/80 bg-white/95 shadow-sm">
        <CardContent className="grid gap-4 p-5 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <div className="space-y-2">
            <label className="text-sm font-medium text-stone-700">每个 CDK 额度</label>
            <Input value={creditAmount} onChange={(event) => setCreditAmount(event.target.value)} type="number" min="1" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-stone-700">生成数量</label>
            <Input value={count} onChange={(event) => setCount(event.target.value)} type="number" min="1" max="500" />
          </div>
          <Button className="h-10 bg-stone-950 text-white hover:bg-stone-800" onClick={() => void handleCreate()} disabled={isCreating}>
            {isCreating ? <LoaderCircle className="size-4 animate-spin" /> : <Ticket className="size-4" />}
            生成 CDK
          </Button>
        </CardContent>
      </Card>

      {generatedItems.length > 0 ? (
        <Card className="rounded-[28px] border-emerald-100 bg-emerald-50/80 shadow-sm">
          <CardContent className="space-y-4 p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold text-emerald-950">本次生成结果</h2>
                <p className="text-sm text-emerald-700">明文 CDK 只在这里展示一次，请及时复制保存。</p>
              </div>
              <Button variant="outline" onClick={() => void handleCopyGenerated()}>
                <Copy className="size-4" />
                复制全部
              </Button>
            </div>
            <div className="max-h-56 overflow-auto rounded-2xl bg-white/80 p-3 font-mono text-xs leading-6 text-stone-800">
              {generatedItems.map((item) => (
                <div key={item.id}>{item.code}</div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="rounded-[28px] border-white/80 bg-white/95 shadow-sm">
        <CardContent className="p-0">
          <div className="grid grid-cols-[1.4fr_0.7fr_0.7fr_1fr_1fr_auto] gap-3 border-b border-stone-100 px-5 py-3 text-xs font-semibold text-stone-500">
            <span>CDK</span>
            <span>额度</span>
            <span>状态</span>
            <span>兑换用户</span>
            <span>创建时间</span>
            <span>操作</span>
          </div>
          <div className="divide-y divide-stone-100">
            {items.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-stone-500">暂无 CDK</div>
            ) : (
              items.map((item) => (
                <div key={item.id} className="grid grid-cols-[1.4fr_0.7fr_0.7fr_1fr_1fr_auto] items-center gap-3 px-5 py-3 text-sm text-stone-700">
                  <span className="font-mono text-xs">{item.code_preview || "-"}</span>
                  <span>{item.credit_amount}</span>
                  <span>{statusLabel(item.status)}</span>
                  <span>{item.redeemed_by_username || "-"}</span>
                  <span className="text-xs text-stone-500">{item.created_at ? new Date(item.created_at).toLocaleString() : "-"}</span>
                  <span>
                    {item.status === "unused" ? (
                      <Button variant="outline" size="sm" onClick={() => void handleDisable(item)}>
                        <XCircle className="size-3.5" />
                        禁用
                      </Button>
                    ) : (
                      <span className="text-xs text-stone-400">-</span>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
