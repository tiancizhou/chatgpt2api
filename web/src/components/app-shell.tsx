"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { TopNav } from "@/components/top-nav";
import { isImageRoute } from "@/lib/routes";
import { cn } from "@/lib/utils";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isImagePage = isImageRoute(pathname);

  useEffect(() => {
    if (!isImagePage) {
      document.documentElement.style.removeProperty("--image-viewport-height");
      return;
    }

    const originalHtmlOverflow = document.documentElement.style.overflow;
    const originalBodyOverflow = document.body.style.overflow;
    const originalBodyWidth = document.body.style.width;
    const originalBodyHeight = document.body.style.height;

    let viewportRaf = 0;
    const updateViewportHeight = () => {
      if (viewportRaf) {
        window.cancelAnimationFrame(viewportRaf);
      }
      viewportRaf = window.requestAnimationFrame(() => {
        viewportRaf = 0;
        const visualViewportBottom = window.visualViewport
          ? window.visualViewport.height + Math.max(0, window.visualViewport.offsetTop)
          : undefined;
        const heights = [
          window.visualViewport?.height,
          visualViewportBottom,
          document.documentElement.clientHeight,
          window.innerHeight,
        ].filter((value): value is number => typeof value === "number" && value > 0);
        const height = Math.floor(Math.min(...heights));
        document.documentElement.style.setProperty("--image-viewport-height", `${height}px`);
      });
    };

    updateViewportHeight();
    window.setTimeout(updateViewportHeight, 250);
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.body.style.width = "100%";
    document.body.style.height = "var(--image-viewport-height, 100vh)";
    window.visualViewport?.addEventListener("resize", updateViewportHeight);
    window.visualViewport?.addEventListener("scroll", updateViewportHeight);
    window.addEventListener("resize", updateViewportHeight);
    window.addEventListener("orientationchange", updateViewportHeight);
    window.addEventListener("pageshow", updateViewportHeight);
    document.addEventListener("visibilitychange", updateViewportHeight);

    return () => {
      document.documentElement.style.overflow = originalHtmlOverflow;
      document.body.style.overflow = originalBodyOverflow;
      document.body.style.width = originalBodyWidth;
      document.body.style.height = originalBodyHeight;
      if (viewportRaf) {
        window.cancelAnimationFrame(viewportRaf);
      }
      document.documentElement.style.removeProperty("--image-viewport-height");
      window.visualViewport?.removeEventListener("resize", updateViewportHeight);
      window.visualViewport?.removeEventListener("scroll", updateViewportHeight);
      window.removeEventListener("resize", updateViewportHeight);
      window.removeEventListener("orientationchange", updateViewportHeight);
      window.removeEventListener("pageshow", updateViewportHeight);
      document.removeEventListener("visibilitychange", updateViewportHeight);
    };
  }, [isImagePage]);

  return (
    <main
      className={cn(
        "nature-canvas px-4 py-2 text-[#203d2b] sm:px-6 lg:px-8",
        isImagePage ? "fixed inset-x-0 top-0 h-[var(--image-viewport-height,100vh)] max-h-[var(--image-viewport-height,100vh)] touch-none overflow-hidden overscroll-none px-2 py-2 sm:px-3 lg:px-8" : "min-h-screen overflow-x-hidden",
      )}
    >
      <div className={cn("mx-auto flex max-w-[1440px] flex-col gap-5", isImagePage && "h-full min-h-0 touch-none gap-0 overflow-hidden") }>
        {isImagePage ? null : <TopNav />}
        {children}
      </div>
    </main>
  );
}
