"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoaderCircle, LockKeyhole } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { login, loginWithPassword } from "@/lib/api";
import { useRedirectIfAuthenticated } from "@/lib/use-auth-guard";
import { getDefaultRouteForRole, setStoredAuthSession } from "@/store/auth";

type LoginMode = "user" | "admin";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<LoginMode>("user");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authKey, setAuthKey] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { isCheckingAuth } = useRedirectIfAuthenticated();

  const handleUserLogin = async () => {
    const normalizedUsername = username.trim();
    if (!normalizedUsername || !password) {
      toast.error("请输入用户名和密码");
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await loginWithPassword(normalizedUsername, password);
      await setStoredAuthSession({
        key: data.token,
        role: data.role,
        subjectId: data.subject_id,
        name: data.name,
      });
      router.replace(getDefaultRouteForRole(data.role));
    } catch (error) {
      const message = error instanceof Error ? error.message : "登录失败";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAdminLogin = async () => {
    const normalizedAuthKey = authKey.trim();
    if (!normalizedAuthKey) {
      toast.error("请输入管理员密钥");
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await login(normalizedAuthKey);
      await setStoredAuthSession({
        key: normalizedAuthKey,
        role: data.role,
        subjectId: data.subject_id,
        name: data.name,
      });
      router.replace(getDefaultRouteForRole(data.role));
    } catch (error) {
      const message = error instanceof Error ? error.message : "登录失败";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = () => {
    if (mode === "admin") {
      void handleAdminLogin();
      return;
    }
    void handleUserLogin();
  };

  if (isCheckingAuth) {
    return (
      <div className="grid min-h-[calc(100vh-1rem)] w-full place-items-center px-4 py-6">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return (
    <div className="grid min-h-[calc(100dvh-1rem)] w-full place-items-center px-4 py-4 sm:py-6">
      <Card className="paper-surface leaf-glow w-full max-w-[505px] rounded-[34px] bg-[#fffdf4]/95 sm:rounded-[40px]">
        <CardContent className="space-y-6 p-5 sm:space-y-7 sm:p-8">
          <div className="space-y-4 text-center">
            <div className="mx-auto inline-flex size-12 items-center justify-center rounded-[18px] bg-linear-to-br from-[#2f6233] to-[#6f9f48] text-[#fbf8ed] shadow-sm sm:size-14">
              <LockKeyhole className="size-5" />
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight text-[#203d2b] sm:text-3xl">欢迎回来</h1>
              <p className="text-sm leading-6 text-[#6a7458]">
                {mode === "admin" ? "管理员可使用密钥进入后台。" : "登录后即可使用额度生成图片。"}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 rounded-2xl bg-[#edf6dc] p-1 text-sm font-medium text-[#6a7458]">
            <button
              type="button"
              className={`rounded-xl py-2 transition ${mode === "user" ? "bg-[#fffdf4] text-[#203d2b] shadow-sm" : "hover:text-[#315f35]"}`}
              onClick={() => setMode("user")}
            >
              用户登录
            </button>
            <button
              type="button"
              className={`rounded-xl py-2 transition ${mode === "admin" ? "bg-[#fffdf4] text-[#203d2b] shadow-sm" : "hover:text-[#315f35]"}`}
              onClick={() => setMode("admin")}
            >
              管理员
            </button>
          </div>

          {mode === "user" ? (
            <div className="space-y-4">
              <div className="space-y-3">
                <label htmlFor="username" className="block text-sm font-medium text-[#315f35]">
                  用户名
                </label>
                <Input
                  id="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      handleSubmit();
                    }
                  }}
                  placeholder="请输入用户名"
                  className="h-13 rounded-2xl border-[#cad9b2] bg-[#fffdf4]/90 focus-visible:ring-[#6f9f48]/25 px-4"
                />
              </div>
              <div className="space-y-3">
                <label htmlFor="password" className="block text-sm font-medium text-[#315f35]">
                  密码
                </label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      handleSubmit();
                    }
                  }}
                  placeholder="请输入密码"
                  className="h-13 rounded-2xl border-[#cad9b2] bg-[#fffdf4]/90 focus-visible:ring-[#6f9f48]/25 px-4"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <label htmlFor="auth-key" className="block text-sm font-medium text-[#315f35]">
                管理员密钥
              </label>
              <Input
                id="auth-key"
                type="password"
                value={authKey}
                onChange={(event) => setAuthKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    handleSubmit();
                  }
                }}
                placeholder="请输入管理员密钥"
                className="h-13 rounded-2xl border-[#cad9b2] bg-[#fffdf4]/90 focus-visible:ring-[#6f9f48]/25 px-4"
              />
            </div>
          )}

          <Button
            className="h-13 w-full rounded-2xl bg-linear-to-br from-[#2f6233] to-[#6f9f48] text-[#fbf8ed] hover:brightness-105"
            onClick={handleSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
            登录
          </Button>

          {mode === "user" ? (
            <p className="text-center text-sm text-[#6a7458]">
              还没有账号？
              <Link href="/signup" className="font-medium text-[#203d2b] underline-offset-4 hover:underline">
                立即注册
              </Link>
            </p>
          ) : null}

          <div className="flex items-center gap-2 rounded-2xl border border-[#b8d48a] bg-[#edf6dc] px-4 py-3 text-sm text-[#3a6b2a]">
            <span className="text-base">🎁</span>
            <span>
              免费领取额度，加 VX：<span className="font-semibold tracking-wide">DMQ_QQ_DMQ</span>
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
