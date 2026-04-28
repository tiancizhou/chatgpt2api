"use client";
import { ArrowUp, Check, ChevronDown, ImagePlus, LoaderCircle, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type RefObject } from "react";

import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ImageConversationMode } from "@/store/image-conversations";
import { cn } from "@/lib/utils";

type ImageComposerProps = {
  mode: ImageConversationMode;
  prompt: string;
  imageCount: string;
  imageSize: string;
  availableQuota: string;
  quotaLabel?: string;
  costHint?: string;
  canEdit?: boolean;
  canSubmit?: boolean;
  submitDisabledReason?: string;
  activeTaskCount: number;
  referenceImages: Array<{ name: string; dataUrl: string }>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onModeChange: (value: ImageConversationMode) => void;
  onPromptChange: (value: string) => void;
  onImageCountChange: (value: string) => void;
  onImageSizeChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  onPickReferenceImage: () => void;
  onReferenceImageChange: (files: File[]) => void | Promise<void>;
  onRemoveReferenceImage: (index: number) => void;
};

const imageSizeOptions = [
  { value: "", label: "自动选择" },
  { value: "1:1", label: "正方形 1:1" },
  { value: "16:9", label: "横版 16:9" },
  { value: "4:3", label: "横版 4:3" },
  { value: "3:4", label: "竖版 3:4" },
  { value: "9:16", label: "竖版 9:16" },
];

export function ImageComposer({
  mode,
  prompt,
  imageCount,
  imageSize,
  availableQuota,
  quotaLabel = "剩余额度",
  costHint = "",
  canEdit = true,
  canSubmit = true,
  submitDisabledReason = "",
  activeTaskCount,
  referenceImages,
  textareaRef,
  fileInputRef,
  onModeChange,
  onPromptChange,
  onImageCountChange,
  onImageSizeChange,
  onSubmit,
  onPickReferenceImage,
  onReferenceImageChange,
  onRemoveReferenceImage,
}: ImageComposerProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [isSizeMenuOpen, setIsSizeMenuOpen] = useState(false);
  const [isMobileSettingsOpen, setIsMobileSettingsOpen] = useState(false);
  const sizeMenuRef = useRef<HTMLDivElement>(null);
  const lightboxImages = useMemo(
    () => referenceImages.map((image, index) => ({ id: `${image.name}-${index}`, src: image.dataUrl })),
    [referenceImages],
  );
  const imageSizeLabel = imageSizeOptions.find((option) => option.value === imageSize)?.label || "自动选择";
  const mobileImageSizeLabel = imageSize === "3:4" || imageSize === "9:16" ? imageSize : "比例";
  const isEditingImage = canEdit && referenceImages.length > 0;
  const submitDisabled = !canSubmit || !prompt.trim();
  const primaryActionLabel = isEditingImage ? "修改图片" : "生成";
  const helperText = submitDisabledReason || costHint || `${quotaLabel} ${availableQuota}`;

  useEffect(() => {
    if (!isSizeMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!sizeMenuRef.current?.contains(event.target as Node)) {
        setIsSizeMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isSizeMenuOpen]);

  useEffect(() => {
    if (!prompt && textareaRef.current) {
      textareaRef.current.style.height = "";
    }
  }, [prompt, textareaRef]);

  const handleTextareaPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    void onReferenceImageChange(imageFiles);
  };

  const handlePickReferenceImage = () => {
    onPickReferenceImage();
  };

  return (
    <div className="shrink-0 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:pb-0">
      <div className="mx-auto w-full max-w-[980px]">
        {canEdit ? (
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              void onReferenceImageChange(Array.from(event.target.files || []));
            }}
          />
        ) : null}

        {isEditingImage && referenceImages.length > 0 ? (
          <div className="mb-2 flex gap-2 overflow-x-auto px-1 pb-1 sm:mb-3 sm:flex-wrap sm:overflow-visible">
            {referenceImages.map((image, index) => (
              <div key={`${image.name}-${index}`} className="relative size-14 shrink-0 sm:size-16">
                <button
                  type="button"
                  onClick={() => {
                    setLightboxIndex(index);
                    setLightboxOpen(true);
                  }}
                  className="group size-14 overflow-hidden rounded-2xl border border-[#cad9b2] bg-stone-50 transition hover:border-stone-300 sm:size-16"
                  aria-label={`预览参考图 ${image.name || index + 1}`}
                >
                  <img src={image.dataUrl} alt={image.name || `参考图 ${index + 1}`} className="h-full w-full object-cover" />
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveReferenceImage(index);
                  }}
                  className="absolute -right-1 -top-1 inline-flex size-5 items-center justify-center rounded-full border border-[#cad9b2] bg-[#fffdf4] text-stone-500 transition hover:border-stone-300 hover:text-stone-800"
                  aria-label={`移除参考图 ${image.name || index + 1}`}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="paper-surface overflow-hidden rounded-[26px] bg-[#fffdf4]/96 shadow-[0_18px_60px_-38px_rgba(47,98,51,0.65)] sm:leaf-glow sm:rounded-[34px]">
          <div
            className="relative cursor-text"
            onClick={() => {
              textareaRef.current?.focus();
            }}
          >
            <ImageLightbox
              images={lightboxImages}
              currentIndex={lightboxIndex}
              open={lightboxOpen}
              onOpenChange={setLightboxOpen}
              onIndexChange={setLightboxIndex}
            />

            {activeTaskCount > 0 ? (
              <div className="px-3 pt-3 sm:hidden">
                <div className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-700">
                  <LoaderCircle className="size-3 animate-spin" />
                  {activeTaskCount} 个任务处理中
                </div>
              </div>
            ) : null}

            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              onPaste={handleTextareaPaste}
              placeholder={
                isEditingImage
                  ? "告诉我想怎么改这张图，例如：换成春天背景"
                  : "例如：一只穿毛衣的小狗坐在窗边，温暖阳光"
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void onSubmit();
                }
              }}
              className="min-h-[68px] resize-none rounded-[24px] border-0 bg-transparent px-4 pt-3 text-[15px] leading-6 text-[#203d2b] shadow-none placeholder:text-[#8f9a78] focus-visible:ring-0 sm:min-h-[148px] sm:px-6 sm:pt-6 sm:leading-7"
            />

            <div ref={sizeMenuRef} className="bg-[#fffdf4] px-3 pb-3 pt-1 sm:px-6 sm:pb-4 sm:pt-2">
              <div className="space-y-2 sm:hidden">
                <div className="flex items-center justify-between gap-2 px-1">
                  <button
                    type="button"
                    onClick={() => void onSubmit()}
                    disabled={submitDisabled}
                    title={submitDisabledReason}
                    className="nature-interactive inline-flex h-8 min-w-[76px] shrink-0 items-center justify-center rounded-full bg-linear-to-br from-[#2f6233] to-[#6f9f48] px-4 text-xs font-bold text-[#fbf8ed] shadow-[0_10px_24px_-14px_rgba(47,98,51,0.9)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:bg-none disabled:bg-[#b7c5a4]"
                  >
                    {primaryActionLabel}
                  </button>
                  <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
                    {canEdit ? (
                    <button
                      type="button"
                      onClick={handlePickReferenceImage}
                      className="nature-interactive inline-flex shrink-0 items-center gap-1 rounded-full border border-[#cad9b2] bg-[#fffdf4] px-2.5 py-1.5 text-xs font-semibold text-[#315f35]"
                    >
                      <ImagePlus className="size-3.5" />
                      {referenceImages.length > 0 ? "加图" : "传图"}
                    </button>
                  ) : null}
                  <div className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[#cad9b2] bg-[#fffdf4] p-0.5 text-xs font-semibold text-[#315f35]">
                    <button
                      type="button"
                      onClick={() => setIsMobileSettingsOpen((open) => !open)}
                      className={cn(
                        "nature-interactive inline-flex h-7 items-center gap-1 rounded-full px-2",
                        isMobileSettingsOpen && "bg-[#edf6dc]",
                      )}
                    >
                      <SlidersHorizontal className="size-3.5" />
                      {mobileImageSizeLabel}
                    </button>
                    {isMobileSettingsOpen ? (
                      <>
                        <MobileSizeButton active={imageSize === "3:4"} onClick={() => onImageSizeChange("3:4")}>
                          3:4
                        </MobileSizeButton>
                        <MobileSizeButton active={imageSize === "9:16"} onClick={() => onImageSizeChange("9:16")}>
                          9:16
                        </MobileSizeButton>
                      </>
                    ) : null}
                  </div>
                  </div>
                </div>
              </div>

              <div className="hidden items-end justify-between gap-3 sm:flex">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
                  {isEditingImage ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-10 rounded-full border-[#cad9b2] bg-[#fffdf4] px-4 text-sm font-medium text-[#315f35] shadow-none"
                      onClick={handlePickReferenceImage}
                    >
                      <ImagePlus className="size-4" />
                      {referenceImages.length > 0 ? "继续添加参考图" : "上传参考图"}
                    </Button>
                  ) : null}
                  <div className="rounded-full bg-[#edf6dc] px-3 py-2 text-xs font-medium text-[#526642]">
                    {quotaLabel} {availableQuota}
                  </div>
                  {costHint ? <div className="rounded-full bg-[#edf6dc] px-3 py-2 text-xs font-medium text-[#526642]">{costHint}</div> : null}
                  {activeTaskCount > 0 ? (
                    <div className="flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
                      <LoaderCircle className="size-3 animate-spin" />
                      {activeTaskCount} 个任务处理中
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2 rounded-full border border-[#cad9b2] bg-[#fffdf4] px-3 py-1">
                    <span className="text-sm font-medium text-[#315f35]">张数</span>
                    <Input
                      type="number"
                      min="1"
                      max="10"
                      step="1"
                      value={imageCount}
                      onChange={(event) => onImageCountChange(event.target.value)}
                      className="h-8 w-[64px] border-0 bg-transparent px-0 text-center text-sm font-medium text-[#315f35] shadow-none focus-visible:ring-0"
                    />
                  </div>
                  <SizeSelector
                    imageSizeLabel={imageSizeLabel}
                    imageSize={imageSize}
                    isSizeMenuOpen={isSizeMenuOpen}
                    onToggle={() => setIsSizeMenuOpen((open) => !open)}
                    onSelect={(value) => {
                      onImageSizeChange(value);
                      setIsSizeMenuOpen(false);
                    }}
                    desktop
                  />
                  {canEdit ? (
                    <div className="rounded-full bg-[#edf6dc] px-3 py-2 text-xs font-medium text-[#526642]">
                      {isEditingImage ? "已上传参考图，将修改图片" : "未上传参考图，将从文字生成"}
                    </div>
                  ) : null}
                </div>

                <button
                  type="button"
                  onClick={() => void onSubmit()}
                  disabled={submitDisabled}
                  title={submitDisabledReason}
                  className="nature-interactive inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-[#2f6233] to-[#6f9f48] text-[#fbf8ed] shadow-[0_14px_30px_-16px_rgba(47,98,51,0.9)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:bg-none disabled:bg-[#b7c5a4]"
                  aria-label={primaryActionLabel}
                >
                  <ArrowUp className="size-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SizeSelector({
  imageSizeLabel,
  imageSize,
  isSizeMenuOpen,
  desktop = false,
  onToggle,
  onSelect,
}: {
  imageSizeLabel: string;
  imageSize: string;
  isSizeMenuOpen: boolean;
  desktop?: boolean;
  onToggle: () => void;
  onSelect: (value: string) => void;
}) {
  return (
    <div
      className={cn(
        "relative flex max-w-full items-center gap-2 rounded-full border border-[#cad9b2] bg-[#fffdf4] px-3 py-1 text-[13px]",
        !desktop && "min-w-0",
      )}
    >
      <span className="shrink-0 font-medium text-[#315f35]">比例</span>
      <button
        type="button"
        className={cn(
          "flex h-8 items-center justify-between bg-transparent text-left text-sm font-bold text-[#315f35]",
          desktop ? "w-[132px]" : "min-w-0 flex-1",
        )}
        onClick={onToggle}
      >
        <span className="truncate">{imageSizeLabel}</span>
        <ChevronDown className={cn("size-4 shrink-0 opacity-60 transition", isSizeMenuOpen && "rotate-180")} />
      </button>
      {isSizeMenuOpen ? (
        <div className="absolute bottom-[calc(100%+10px)] left-0 z-50 w-[186px] overflow-hidden rounded-3xl border border-white/80 bg-[#fffdf4] p-2 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.35)]">
          {imageSizeOptions.map((option) => {
            const active = option.value === imageSize;
            return (
              <button
                key={option.label}
                type="button"
                className={cn(
                  "flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-sm text-[#315f35] transition hover:bg-[#edf6dc]",
                  active && "bg-[#edf6dc] font-medium text-[#203d2b]",
                )}
                onClick={() => onSelect(option.value)}
              >
                <span>{option.label}</span>
                {active ? <Check className="size-4" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function MobileSizeButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "nature-interactive h-7 rounded-full px-2.5 text-xs font-bold transition",
        active ? "bg-linear-to-br from-[#2f6233] to-[#6f9f48] text-[#fbf8ed]" : "text-[#526642] hover:bg-[#edf6dc]",
      )}
    >
      {children}
    </button>
  );
}
