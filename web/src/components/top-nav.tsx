"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import webConfig from "@/constants/common-env";
import { isImageRoute } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { clearStoredAuthSession, getStoredAuthSession, type StoredAuthSession } from "@/store/auth";

const adminNavItems = [
  { href: "/image", label: "画图" },
  { href: "/accounts", label: "号池管理" },
  { href: "/register", label: "注册机" },
  { href: "/image-manager", label: "图片管理" },
  { href: "/logs", label: "日志管理" },
  { href: "/settings", label: "设置" },
  { href: "/users", label: "用户管理" },
  { href: "/cdks", label: "CDK管理" },
];

const userNavItems = [{ href: "/image", label: "画图" }];

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<StoredAuthSession | null | undefined>(undefined);

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (pathname === "/login") {
        if (!active) {
          return;
        }
        setSession(null);
        return;
      }

      const storedSession = await getStoredAuthSession();
      if (!active) {
        return;
      }
      setSession(storedSession);
    };

    void load();
    return () => {
      active = false;
    };
  }, [pathname]);

  const handleLogout = async () => {
    await clearStoredAuthSession();
    router.replace("/login");
  };

  if (pathname === "/login" || isImageRoute(pathname) || session === undefined || !session) {
    return null;
  }

  const navItems = session.role === "admin" ? adminNavItems : userNavItems;
  const roleLabel = session.role === "admin" ? "管理员" : "普通用户";

  return (
    <header
      className={cn(
        "paper-surface rounded-[20px] border-[#cad9b2]/70 bg-[#fbf8ed]/82 backdrop-blur sm:rounded-[26px]",
        isImageRoute(pathname) && "hidden",
      )}
    >
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-1.5 sm:h-12 sm:flex-nowrap sm:px-6 sm:py-0">
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <Link
            href="/image"
            className="nature-interactive py-1 text-[14px] font-bold tracking-tight text-[#254f2f] transition hover:text-[#3f7f3a] sm:text-[15px]"
          >
            AI 绘图
          </Link>
        </div>
        <div className="order-3 -mx-1 hidden w-full gap-3 overflow-x-auto px-1 pb-0.5 sm:order-none sm:mx-0 sm:flex sm:w-auto sm:flex-1 sm:justify-center sm:gap-8 sm:overflow-visible sm:px-0 sm:pb-0">
          {navItems.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "nature-interactive relative shrink-0 rounded-full px-2 py-1 text-[13px] font-medium transition sm:text-[15px]",
                  active ? "bg-[#e4efd2] font-semibold text-[#254f2f]" : "text-[#6a7458] hover:bg-[#edf6dc] hover:text-[#315f35]",
                )}
              >
                {item.label}
                {active ? <span className="absolute inset-x-2 -bottom-[1px] h-1 rounded-full bg-[#6f9f48]" /> : null}
              </Link>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 sm:gap-3">
          <span className="hidden rounded-md bg-[#edf6dc] px-2 py-1 text-[10px] font-medium text-[#6a7458] sm:inline-block sm:text-[11px]">
            {roleLabel}
          </span>
          <span className="hidden rounded-md bg-[#edf6dc] px-2 py-1 text-[10px] font-medium text-[#6a7458] sm:inline-block sm:text-[11px]">
            v{webConfig.appVersion}
          </span>
          <button
            type="button"
            className="nature-interactive rounded-full px-2 py-1 text-xs text-[#8b7858] transition hover:bg-[#edf6dc] hover:text-[#315f35] sm:text-sm"
            onClick={() => void handleLogout()}
          >
            退出
          </button>
        </div>
      </div>
    </header>
  );
}
