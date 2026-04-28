"use client";

import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, Minus, Plus, Users } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { adjustProductUserCredits, fetchProductUsers, type ProductUser } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";

function formatTime(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

export default function UsersPage() {
  const { isCheckingAuth } = useAuthGuard(["admin"]);
  const [items, setItems] = useState<ProductUser[]>([]);
  const [adjustments, setAdjustments] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [adjustingUserId, setAdjustingUserId] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    try {
      const data = await fetchProductUsers();
      setItems(data.items);
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取用户失败";
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isCheckingAuth) {
      void loadUsers();
    }
  }, [isCheckingAuth, loadUsers]);

  const handleAdjust = async (user: ProductUser, direction: 1 | -1) => {
    const rawAmount = Math.abs(Number(adjustments[user.id]) || 0);
    if (!rawAmount) {
      toast.error("请输入调整额度");
      return;
    }
    const amount = rawAmount * direction;
    setAdjustingUserId(user.id);
    try {
      const data = await adjustProductUserCredits(user.id, amount);
      setItems((prev) => prev.map((item) => (item.id === user.id ? data.user : item)));
      setAdjustments((prev) => ({ ...prev, [user.id]: "" }));
      toast.success(`${amount > 0 ? "增加" : "扣除"}额度成功`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "调整额度失败";
      toast.error(message);
    } finally {
      setAdjustingUserId(null);
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
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-stone-950">
          <Users className="size-6" />
          用户管理
        </h1>
        <p className="mt-1 text-sm text-stone-500">查看注册用户，并手动增加或扣除用户额度。</p>
      </div>

      <Card className="rounded-[28px] border-white/80 bg-white/95 shadow-sm">
        <CardContent className="p-0">
          <div className="grid grid-cols-[1.2fr_0.7fr_1fr_1fr_1.2fr] gap-3 border-b border-stone-100 px-5 py-3 text-xs font-semibold text-stone-500">
            <span>用户名</span>
            <span>余额</span>
            <span>注册时间</span>
            <span>最后登录</span>
            <span>额度调整</span>
          </div>
          <div className="divide-y divide-stone-100">
            {items.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-stone-500">暂无用户</div>
            ) : (
              items.map((item) => (
                <div key={item.id} className="grid grid-cols-[1.2fr_0.7fr_1fr_1fr_1.2fr] items-center gap-3 px-5 py-3 text-sm text-stone-700">
                  <span className="font-medium text-stone-950">{item.username}</span>
                  <span className="font-semibold">{item.credit_balance}</span>
                  <span className="text-xs text-stone-500">{formatTime(item.created_at)}</span>
                  <span className="text-xs text-stone-500">{formatTime(item.last_login_at)}</span>
                  <span className="flex items-center gap-2">
                    <Input
                      type="number"
                      min="1"
                      value={adjustments[item.id] || ""}
                      onChange={(event) => setAdjustments((prev) => ({ ...prev, [item.id]: event.target.value }))}
                      placeholder="额度"
                      className="h-9 w-24 rounded-xl"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleAdjust(item, 1)}
                      disabled={adjustingUserId === item.id}
                    >
                      <Plus className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleAdjust(item, -1)}
                      disabled={adjustingUserId === item.id}
                    >
                      <Minus className="size-3.5" />
                    </Button>
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
