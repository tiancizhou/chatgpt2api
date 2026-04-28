"use client";

import { useState } from "react";
import { Clock3, LoaderCircle, Sparkles, StopCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ImageConversation, ImageTurnStatus, StoredImage, StoredReferenceImage } from "@/store/image-conversations";

export type ImageLightboxItem = {
  id: string;
  src: string;
  sizeLabel?: string;
  dimensions?: string;
};

type ImageResultsProps = {
  selectedConversation: ImageConversation | null;
  onOpenLightbox: (images: ImageLightboxItem[], index: number) => void;
  onContinueEdit: (conversationId: string, image: StoredImage | StoredReferenceImage) => void;
  onCancelTurn: (conversationId: string, turnId: string) => void;
  formatConversationTime: (value: string) => string;
  onUseExamplePrompt?: (prompt: string) => void;
  canEdit?: boolean;
};

const examplePrompts = [
  { label: "商品海报", prompt: "一张高级感护肤品商品海报，浅绿色自然背景，阳光洒落，干净精致，适合小红书发布" },
  { label: "头像", prompt: "一个温柔自然风格的女生头像，柔和光线，清新绿色背景，精致插画感" },
  { label: "小红书配图", prompt: "一张适合小红书的生活方式配图，咖啡、绿植、阳光窗台，画面高级简洁" },
];

export function ImageResults({
  selectedConversation,
  onOpenLightbox,
  onContinueEdit,
  onCancelTurn,
  formatConversationTime,
  onUseExamplePrompt,
  canEdit = true,
}: ImageResultsProps) {
  const [imageDimensions, setImageDimensions] = useState<Record<string, string>>({});
  const isLoadingHistoryResult = selectedConversation?.turns.some((turn) =>
    turn.images.some((image) => image.status !== "loading" && Boolean(image.jobId) && !image.b64_json),
  );

  const updateImageDimensions = (id: string, width: number, height: number) => {
    const dimensions = formatImageDimensions(width, height);
    setImageDimensions((current) => {
      if (current[id] === dimensions) {
        return current;
      }
      return { ...current, [id]: dimensions };
    });
  };

  if (!selectedConversation) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center text-center">
        <div className="w-full max-w-xl px-3 py-4 sm:paper-surface sm:leaf-glow sm:rounded-[34px] sm:bg-[#fffdf4]/92 sm:px-8 sm:py-12 sm:shadow-[0_24px_70px_-48px_rgba(47,98,51,0.65)]">
          <h1 className="text-xl font-bold tracking-tight text-[#203d2b] sm:text-4xl">今天想做什么图片？</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[#6a7458] sm:mt-3 sm:text-[15px]">
            直接描述想法，不需要会写提示词。
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2 sm:mt-5">
            {examplePrompts.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => onUseExamplePrompt?.(item.prompt)}
                className="nature-interactive rounded-full border border-[#cad9b2] bg-[#fffdf4] px-4 py-2 text-xs font-semibold text-[#315f35] shadow-sm hover:bg-[#edf6dc] sm:text-sm"
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-4 sm:gap-8">
      {selectedConversation.turns.map((turn, turnIndex) => {
        const referenceLightboxImages = turn.referenceImages.map((image, index) => ({
          id: `${turn.id}-reference-${index}`,
          src: image.dataUrl,
        }));
        const successfulTurnImages = turn.images.flatMap((image) =>
          image.status === "success" && (image.url || image.b64_json)
            ? [
                {
                  id: image.id,
                  src: image.url || `data:image/png;base64,${image.b64_json}`,
                  sizeLabel: image.b64_json ? formatBase64ImageSize(image.b64_json) : undefined,
                  dimensions: imageDimensions[image.id],
                },
              ]
            : [],
        );

        return (
          <section key={turn.id} className="space-y-3 sm:space-y-4">
            <div className="ml-auto max-w-[92%] rounded-[26px] bg-[#fffdf4]/82 px-4 py-3 shadow-sm ring-1 ring-[#cad9b2]/60 sm:max-w-[82%] sm:px-5 sm:py-4">
              <div className="mb-2 flex flex-wrap items-center justify-end gap-2 text-[11px] text-[#8f9a78]">
                <span className="rounded-full bg-[#edf6dc] px-2 py-1 text-[#526642]">你的需求</span>
                <span>{turn.mode === "edit" ? "修改已有图片" : "从文字生成"}</span>
                <span>{getTurnStatusLabel(turn.status)}</span>
                <span className="hidden sm:inline">第 {turnIndex + 1} 轮</span>
                <span>{formatConversationTime(turn.createdAt)}</span>
              </div>
              <div className="text-right text-[15px] leading-7 text-[#203d2b]">{turn.prompt}</div>
            </div>

            <div className="w-full rounded-[24px] bg-[#fffdf4]/32 p-1.5 sm:rounded-[28px] sm:p-3">
              {turn.referenceImages.length > 0 ? (
                <div className="mb-4 rounded-[24px] bg-[#edf6dc]/42 p-3">
                  <div className="mb-3 text-xs font-semibold text-[#6a7458]">参考图</div>
                  <div className="flex gap-3 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible">
                    {turn.referenceImages.map((image, index) => (
                      <div key={`${turn.id}-${image.name}-${index}`} className="flex shrink-0 flex-col gap-2">
                        <button
                          type="button"
                          onClick={() => onOpenLightbox(referenceLightboxImages, index)}
                          className="group relative size-20 overflow-hidden rounded-2xl border border-[#cad9b2]/80 bg-[#edf6dc]/60 text-left transition hover:border-stone-300 sm:size-24"
                          aria-label={`预览参考图 ${image.name || index + 1}`}
                        >
                          <img
                            src={image.dataUrl}
                            alt={image.name || `参考图 ${index + 1}`}
                            className="absolute inset-0 h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                          />
                        </button>
                        {canEdit ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 rounded-full border-[#cad9b2] bg-[#fffdf4] text-xs text-[#315f35] hover:bg-[#edf6dc]"
                            onClick={() => onContinueEdit(selectedConversation.id, image)}
                          >
                            <Sparkles className="size-3.5" />
                            继续修改
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-[#6a7458]">
                <span className="rounded-full bg-[#edf6dc] px-3 py-1">生成结果</span>
                <span className="rounded-full bg-[#edf6dc] px-3 py-1">{getTurnStatusLabel(turn.status)}</span>
                {turn.status === "queued" ? <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">已排队，马上开始</span> : null}
                {turn.status === "generating" || turn.status === "queued" ? (
                  <button
                    type="button"
                    onClick={() => onCancelTurn(selectedConversation.id, turn.id)}
                    className="nature-interactive inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-3 py-1 font-medium text-rose-600 hover:bg-rose-100"
                  >
                    <StopCircle className="size-3" />
                    取消
                  </button>
                ) : null}
              </div>

              <div className="columns-1 gap-4 space-y-4 sm:columns-2 xl:columns-3">
                {turn.images.map((image, index) => {
                  const imageSrc = image.url || (image.b64_json ? `data:image/png;base64,${image.b64_json}` : "");
                  if (image.status === "success" && imageSrc) {
                    const currentIndex = successfulTurnImages.findIndex((item) => item.id === image.id);
                    const sizeLabel = image.b64_json ? formatBase64ImageSize(image.b64_json) : undefined;
                    const dimensions = imageDimensions[image.id];
                    const imageMeta = [sizeLabel, dimensions].filter(Boolean).join(" · ");

                    return (
                      <div key={image.id} className="break-inside-avoid overflow-hidden rounded-[26px] bg-[#fffdf4] shadow-[0_20px_52px_-42px_rgba(47,98,51,0.8)] ring-1 ring-[#cad9b2]/55">
                        <button
                          type="button"
                          onClick={() => onOpenLightbox(successfulTurnImages, currentIndex)}
                          className="group block w-full cursor-zoom-in overflow-hidden"
                        >
                          <img
                            src={imageSrc}
                            alt={`Generated result ${index + 1}`}
                            className="block h-auto w-full transition duration-200 group-hover:brightness-105"
                            onLoad={(event) => {
                              updateImageDimensions(
                                image.id,
                                event.currentTarget.naturalWidth,
                                event.currentTarget.naturalHeight,
                              );
                            }}
                          />
                        </button>
                        <div className="flex items-center justify-between gap-2 px-3 py-3">
                          <div className="min-w-0 text-xs text-[#6a7458]">
                            <span className="font-semibold text-[#315f35]">结果 {index + 1}</span>
                            {imageMeta ? <span className="ml-2 hidden text-[#8f9a78] sm:inline">{imageMeta}</span> : null}
                          </div>
                          {canEdit ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 shrink-0 rounded-full border-[#cad9b2] bg-[#fffdf4] text-xs text-[#315f35] hover:bg-[#edf6dc]"
                              onClick={() => onContinueEdit(selectedConversation.id, image)}
                            >
                              <Sparkles className="size-3.5" />
                              继续修改
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    );
                  }

                  if (image.status === "error") {
                    return (
                      <div
                        key={image.id}
                        className={cn(
                          "break-inside-avoid overflow-hidden rounded-[26px] border border-[#e5b59c] bg-[#fff1e8]",
                          getImageAspectClass(turn.size),
                        )}
                      >
                        <div className="flex h-full items-center justify-center px-6 py-8 text-center text-sm leading-6 text-[#a65434]">
                          {image.error || "生成失败"}
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={image.id}
                      className={cn(
                        "break-inside-avoid overflow-hidden rounded-[26px] border border-[#cad9b2]/80 bg-linear-to-br from-[#edf6dc]/90 to-[#e7f4f4]/85",
                        getImageAspectClass(turn.size),
                      )}
                    >
                      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center text-[#6a7458]">
                        <div className="rounded-full bg-white p-3 shadow-sm">
                          {turn.status === "queued" ? <Clock3 className="size-5" /> : <LoaderCircle className="size-5 animate-spin" />}
                        </div>
                        <p className="text-sm">
                          {isLoadingHistoryResult ? "正在读取图片" : turn.status === "queued" ? "已排队，马上开始" : "正在为你生成图片"}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {turn.status === "error" && turn.error ? (
                <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm leading-6 text-amber-700">
                  {turn.error}
                </div>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function getTurnStatusLabel(status: ImageTurnStatus) {
  if (status === "queued") {
    return "排队中";
  }
  if (status === "generating") {
    return "生成中";
  }
  if (status === "success") {
    return "已完成";
  }
  return "失败";
}

function getImageAspectClass(size: string) {
  if (size === "1:1") return "aspect-square";
  if (size === "16:9") return "aspect-video";
  if (size === "9:16") return "aspect-[9/16]";
  if (size === "4:3") return "aspect-[4/3]";
  if (size === "3:4") return "aspect-[3/4]";
  return "aspect-square";
}

function formatBase64ImageSize(base64: string) {
  const normalized = base64.replace(/\s/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);

  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function formatImageDimensions(width: number, height: number) {
  return `${width} x ${height}`;
}
