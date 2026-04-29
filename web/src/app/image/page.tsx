"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, LoaderCircle, LogOut, Ticket } from "lucide-react";
import { toast } from "sonner";

import { ImageComposer } from "@/app/image/components/image-composer";
import { ImageResults, type ImageLightboxItem } from "@/app/image/components/image-results";
import { ImageSidebar } from "@/app/image/components/image-sidebar";
import { ImageLightbox } from "@/components/image-lightbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  createUserImageEditJob,
  createUserImageGenerationJob,
  editImage,
  fetchAccounts,
  fetchUserBalance,
  fetchUserImageJob,
  generateImage,
  logoutUser,
  redeemCdk,
  type Account,
  type ImageModel,
  type ProductImageJob,
} from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { clearStoredAuthSession } from "@/store/auth";
import {
  clearImageConversations,
  deleteImageConversation,
  getImageConversationStats,
  listImageConversations,
  saveImageConversation,
  saveImageConversations,
  setImageConversationOwner,
  type ImageConversation,
  type ImageConversationMode,
  type ImageTurn,
  type ImageTurnStatus,
  type StoredImage,
  type StoredReferenceImage,
} from "@/store/image-conversations";

const ACTIVE_CONVERSATION_STORAGE_KEY = "chatgpt2api:image_active_conversation_id";
const IMAGE_SIZE_STORAGE_KEY = "chatgpt2api:image_last_size";
const FAST_IMAGE_JOB_POLL_INTERVAL_MS = 2000;
const SLOW_IMAGE_JOB_POLL_INTERVAL_MS = 5000;
const IMAGE_JOB_FAST_POLL_WINDOW_MS = 30000;
const activeConversationQueueIds = new Set<string>();
const cancelledTurnIds = new Set<string>();

function buildConversationTitle(prompt: string) {
  const trimmed = prompt.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 12)}...`;
}

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatAvailableQuota(accounts: Account[]) {
  const availableAccounts = accounts.filter((account) => account.status !== "禁用");
  return String(availableAccounts.reduce((sum, account) => sum + Math.max(0, account.quota), 0));
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取参考图失败"));
    reader.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl: string, fileName: string, mimeType?: string) {
  const [header, content] = dataUrl.split(",", 2);
  const matchedMimeType = header.match(/data:(.*?);base64/)?.[1];
  const binary = atob(content || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], fileName, { type: mimeType || matchedMimeType || "image/png" });
}

function buildReferenceImageFromResult(image: StoredImage, fileName: string): StoredReferenceImage | null {
  if (!image.b64_json) {
    return null;
  }

  return {
    name: fileName,
    type: "image/png",
    dataUrl: `data:image/png;base64,${image.b64_json}`,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

type CustomerImageJobResult = {
  url?: string;
  b64_json?: string;
};

function isTransientNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /network error|failed to fetch|load failed|timeout|timed out/i.test(message);
}

async function waitForCustomerImageJob({
  mode,
  files,
  prompt,
  model,
  size,
  clientRequestId,
  existingJobId,
  isCancelled,
  onJobId,
}: {
  mode: ImageConversationMode;
  files: File[];
  prompt: string;
  model: ImageModel;
  size: string;
  clientRequestId: string;
  existingJobId?: string;
  isCancelled: () => boolean;
  onJobId: (jobId: string) => Promise<void>;
}): Promise<CustomerImageJobResult> {
  let jobId = existingJobId;

  const startedAt = Date.now();
  while (!jobId) {
    if (isCancelled()) {
      throw new Error("已取消");
    }
    try {
      const created =
        mode === "edit"
          ? await createUserImageEditJob(files, prompt, model, size, clientRequestId)
          : await createUserImageGenerationJob(prompt, model, size, clientRequestId);
      jobId = created.job_id;
      await onJobId(jobId);
    } catch (error) {
      if (!isTransientNetworkError(error)) {
        throw error;
      }
      await sleep(SLOW_IMAGE_JOB_POLL_INTERVAL_MS);
    }
  }

  while (true) {
    if (isCancelled()) {
      throw new Error("已取消");
    }

    let job: ProductImageJob;
    try {
      job = await fetchUserImageJob(jobId);
    } catch {
      await sleep(SLOW_IMAGE_JOB_POLL_INTERVAL_MS);
      continue;
    }

    if (job.status === "succeeded") {
      const first = job.result?.data?.[0];
      const url = first?.url || job.result_urls?.[0];
      const b64_json = first?.b64_json;
      if (!url && !b64_json) {
        throw new Error("未返回图片数据");
      }
      return { url, b64_json };
    }

    if (job.status === "refunded" || job.status === "failed") {
      const reason = String(job.error_message || "").trim();
      throw new Error(reason ? `生成失败，额度已退回：${reason}` : "生成失败，额度已退回");
    }

    const interval =
      Date.now() - startedAt < IMAGE_JOB_FAST_POLL_WINDOW_MS
        ? FAST_IMAGE_JOB_POLL_INTERVAL_MS
        : SLOW_IMAGE_JOB_POLL_INTERVAL_MS;
    await sleep(interval);
  }
}

function pickFallbackConversationId(conversations: ImageConversation[]) {
  const activeConversation = conversations.find((conversation) =>
    conversation.turns.some((turn) => turn.status === "queued" || turn.status === "generating"),
  );
  return activeConversation?.id ?? conversations[0]?.id ?? null;
}

function sortImageConversations(conversations: ImageConversation[]) {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function ImageMobileHeader({
  historyCount,
  activeTaskCount,
  availableQuota,
  isCustomer,
  onOpenHistory,
  onRedeem,
  onLogout,
}: {
  historyCount: number;
  activeTaskCount: number;
  availableQuota: string;
  isCustomer: boolean;
  onOpenHistory: () => void;
  onRedeem: () => void;
  onLogout: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 lg:hidden">
      <button
        type="button"
        onClick={onOpenHistory}
        className="nature-interactive relative inline-flex h-9 shrink-0 items-center gap-1 rounded-full border border-[#cad9b2]/80 bg-[#fffdf4]/90 px-3 text-xs font-semibold text-[#315f35] shadow-sm"
      >
        <History className="size-3.5" />
        我的图片
        {historyCount > 0 ? (
          <span className="ml-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-[#2f6233] px-1.5 text-[10px] font-bold text-[#fbf8ed]">
            {historyCount}
          </span>
        ) : null}
        {activeTaskCount > 0 ? <span className="ml-0.5 size-2.5 rounded-full bg-amber-400" /> : null}
      </button>
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        {isCustomer ? (
          <>
            <button
              type="button"
              className="nature-interactive inline-flex h-9 max-w-[44vw] shrink-0 items-center justify-center gap-1 rounded-full border border-[#cad9b2]/70 bg-[#fffdf4]/82 px-3 text-xs font-semibold text-[#315f35] shadow-sm"
              onClick={onRedeem}
            >
              <span className="truncate">
                额度 <span className="font-bold text-[#203d2b]">{availableQuota}</span>
              </span>
              <span className="text-[#cad9b2]">|</span>
              <Ticket className="size-3.5 shrink-0" />
              <span className="shrink-0">兑换</span>
            </button>
            <button
              type="button"
              className="nature-interactive inline-flex h-9 shrink-0 items-center justify-center gap-1 rounded-full border border-[#cad9b2]/70 bg-[#fffdf4]/82 px-3 text-xs font-semibold text-[#315f35] shadow-sm"
              onClick={onLogout}
            >
              <LogOut className="size-3.5 shrink-0" />
              <span className="shrink-0">退出</span>
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ImageCreditSummary({
  availableQuota,
  isCustomer,
  onRedeem,
  onLogout,
}: {
  availableQuota: string;
  isCustomer: boolean;
  onRedeem: () => void;
  onLogout: () => void;
}) {
  if (!isCustomer) {
    return null;
  }

  return (
    <div className="hidden items-center justify-between gap-2 rounded-full border border-[#cad9b2]/70 bg-[#fffdf4]/82 px-3 py-1.5 text-xs shadow-sm sm:paper-surface sm:flex sm:rounded-[30px] sm:px-5 sm:py-4">
      <div className="min-w-0 text-[#6a7458]">
        额度 <span className="font-bold text-[#203d2b]">{availableQuota}</span>
        <span className="mx-1 text-[#cad9b2]">|</span>
        每张 2 额度
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="nature-interactive inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-[#edf6dc] px-3 font-semibold text-[#315f35] sm:h-10 sm:bg-linear-to-br sm:from-[#2f6233] sm:to-[#6f9f48] sm:text-[#fbf8ed]"
          onClick={onRedeem}
        >
          <Ticket className="size-3.5" />
          兑换
        </button>
        <button
          type="button"
          className="nature-interactive inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-[#cad9b2]/70 bg-[#fffdf4]/82 px-3 font-semibold text-[#315f35] shadow-sm sm:h-10"
          onClick={onLogout}
        >
          <LogOut className="size-3.5" />
          退出
        </button>
      </div>
    </div>
  );
}

async function recoverConversationHistory(items: ImageConversation[]) {
  const normalized = items.map((conversation) => {
    let changed = false;

    const turns = conversation.turns.map((turn) => {
      if (turn.status !== "queued" && turn.status !== "generating") {
        return turn;
      }

      const loadingCount = turn.images.filter((image) => image.status === "loading").length;
      if (loadingCount > 0) {
        changed = changed || turn.status !== "queued" || Boolean(turn.error);
        return {
          ...turn,
          status: "queued" as const,
          error: undefined,
        };
      }

      const failedCount = turn.images.filter((image) => image.status === "error").length;
      const successCount = turn.images.filter((image) => image.status === "success").length;
      const nextStatus: ImageTurnStatus =
        failedCount > 0 ? "error" : successCount > 0 ? "success" : "queued";
      const nextError = failedCount > 0 ? turn.error || `其中 ${failedCount} 张未成功生成` : undefined;
      if (nextStatus === turn.status && nextError === turn.error) {
        return turn;
      }

      changed = true;
      return {
        ...turn,
        status: nextStatus,
        error: nextError,
      };
    });

    if (!changed) {
      return conversation;
    }

    const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
    return {
      ...conversation,
      turns,
      updatedAt: lastTurn?.createdAt || conversation.updatedAt,
    };
  });

  const changedConversations = normalized.filter((conversation, index) => conversation !== items[index]);
  if (changedConversations.length > 0) {
    await saveImageConversations(normalized);
  }

  return normalized;
}

function ImagePageContent({ isAdmin, isCustomer, ownerId }: { isAdmin: boolean; isCustomer: boolean; ownerId: string }) {
  const didLoadQuotaRef = useRef(false);
  const conversationsRef = useRef<ImageConversation[]>([]);
  const resultsViewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [imagePrompt, setImagePrompt] = useState("");
  const [imageCount, setImageCount] = useState("1");
  const [imageMode, setImageMode] = useState<ImageConversationMode>("generate");
  const [imageSize, setImageSize] = useState("");
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [referenceImageFiles, setReferenceImageFiles] = useState<File[]>([]);
  const [referenceImages, setReferenceImages] = useState<StoredReferenceImage[]>([]);
  const [conversations, setConversations] = useState<ImageConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [availableQuota, setAvailableQuota] = useState("加载中...");
  const [lightboxImages, setLightboxImages] = useState<ImageLightboxItem[]>([]);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: "one"; id: string } | { type: "all" } | null>(null);
  const [isRedeemOpen, setIsRedeemOpen] = useState(false);
  const [redeemCode, setRedeemCode] = useState("");
  const [isRedeeming, setIsRedeeming] = useState(false);

  const parsedCount = useMemo(() => Math.max(1, Math.min(10, Number(imageCount) || 1)), [imageCount]);
  const numericAvailableQuota = useMemo(() => Number(availableQuota), [availableQuota]);
  const estimatedCost = isCustomer ? parsedCount * 2 : 0;
  const hasKnownInsufficientBalance = isCustomer && Number.isFinite(numericAvailableQuota) && numericAvailableQuota < estimatedCost;
  const selectedConversation = useMemo(
    () => conversations.find((item) => item.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );
  const activeTaskCount = useMemo(
    () =>
      conversations.reduce((sum, conversation) => {
        const stats = getImageConversationStats(conversation);
        return sum + stats.queued + stats.running;
      }, 0),
    [conversations],
  );
  const deleteConfirmTitle = deleteConfirm?.type === "all" ? "清空历史记录" : deleteConfirm?.type === "one" ? "删除对话" : "";
  const deleteConfirmDescription =
    deleteConfirm?.type === "all"
      ? "确认删除全部图片历史记录吗？删除后无法恢复。"
      : deleteConfirm?.type === "one"
        ? "确认删除这条图片对话吗？删除后无法恢复。"
        : "";

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    setImageConversationOwner(ownerId);
    let cancelled = false;

    const loadHistory = async () => {
      try {
        const storedSize = typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_SIZE_STORAGE_KEY) : null;
        setImageSize(storedSize || "");

        const normalizedItems = await recoverConversationHistory(await listImageConversations());
        if (cancelled) {
          return;
        }

        conversationsRef.current = normalizedItems;
        setConversations(normalizedItems);
        const storedConversationId =
          typeof window !== "undefined" ? window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY) : null;
        const nextSelectedConversationId =
          (storedConversationId && normalizedItems.some((conversation) => conversation.id === storedConversationId)
            ? storedConversationId
            : null) ?? pickFallbackConversationId(normalizedItems);
        setSelectedConversationId(nextSelectedConversationId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取会话记录失败";
        toast.error(message);
      } finally {
        if (!cancelled) {
          setIsLoadingHistory(false);
        }
      }
    };

    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, [ownerId]);

  const loadQuota = useCallback(async () => {
    if (isCustomer) {
      try {
        const data = await fetchUserBalance();
        setAvailableQuota(String(data.credit_balance));
      } catch {
        setAvailableQuota((prev) => (prev === "加载中..." ? "--" : prev));
      }
      return;
    }
    if (!isAdmin) {
      setAvailableQuota("--");
      return;
    }
    try {
      const data = await fetchAccounts();
      setAvailableQuota(formatAvailableQuota(data.items));
    } catch {
      setAvailableQuota((prev) => (prev === "加载中..." ? "--" : prev));
    }
  }, [isAdmin, isCustomer]);

  useEffect(() => {
    if (didLoadQuotaRef.current) {
      return;
    }
    didLoadQuotaRef.current = true;

    const handleFocus = () => {
      void loadQuota();
    };

    void loadQuota();
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [isAdmin, loadQuota]);

  useEffect(() => {
    if (!selectedConversation) {
      return;
    }

    resultsViewportRef.current?.scrollTo({
      top: resultsViewportRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [selectedConversation?.updatedAt, selectedConversation?.turns.length, selectedConversation]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (selectedConversationId) {
      window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, selectedConversationId);
    } else {
      window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
    }
  }, [selectedConversationId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (imageSize) {
      window.localStorage.setItem(IMAGE_SIZE_STORAGE_KEY, imageSize);
      return;
    }
    window.localStorage.removeItem(IMAGE_SIZE_STORAGE_KEY);
  }, [imageSize]);

  useEffect(() => {
    if (selectedConversationId && !conversations.some((conversation) => conversation.id === selectedConversationId)) {
      setSelectedConversationId(pickFallbackConversationId(conversations));
    }
  }, [conversations, selectedConversationId]);

  const persistConversation = async (conversation: ImageConversation) => {
    const nextConversations = sortImageConversations([
      conversation,
      ...conversationsRef.current.filter((item) => item.id !== conversation.id),
    ]);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    await saveImageConversation(conversation);
  };

  const updateConversation = useCallback(
    async (
      conversationId: string,
      updater: (current: ImageConversation | null) => ImageConversation,
      options: { persist?: boolean } = {},
    ) => {
      const current = conversationsRef.current.find((item) => item.id === conversationId) ?? null;
      const nextConversation = updater(current);
      const nextConversations = sortImageConversations([
        nextConversation,
        ...conversationsRef.current.filter((item) => item.id !== conversationId),
      ]);
      conversationsRef.current = nextConversations;
      setConversations(nextConversations);
      if (options.persist !== false) {
        await saveImageConversation(nextConversation);
      }
    },
    [isCustomer],
  );

  const clearComposerInputs = useCallback(() => {
    setImagePrompt("");
    setImageCount("1");
    setReferenceImageFiles([]);
    setReferenceImages([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const resetComposer = useCallback(() => {
    setImageMode("generate");
    clearComposerInputs();
  }, [clearComposerInputs]);

  const handleCreateDraft = () => {
    setSelectedConversationId(null);
    resetComposer();
    textareaRef.current?.focus();
  };

  const handleSelectConversation = (id: string) => {
    setSelectedConversationId(id);
  };

  const handleDeleteConversation = async (id: string) => {
    const nextConversations = conversations.filter((item) => item.id !== id);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    if (selectedConversationId === id) {
      setSelectedConversationId(pickFallbackConversationId(nextConversations));
      resetComposer();
    }

    try {
      await deleteImageConversation(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除会话失败";
      toast.error(message);
      const items = await listImageConversations();
      conversationsRef.current = items;
      setConversations(items);
    }
  };

  const handleClearHistory = async () => {
    try {
      await clearImageConversations();
      conversationsRef.current = [];
      setConversations([]);
      setSelectedConversationId(null);
      resetComposer();
      toast.success("已清空历史记录");
    } catch (error) {
      const message = error instanceof Error ? error.message : "清空历史记录失败";
      toast.error(message);
    }
  };

  const openDeleteConversationConfirm = (id: string) => {
    setIsHistoryOpen(false);
    setDeleteConfirm({ type: "one", id });
  };

  const openClearHistoryConfirm = () => {
    setIsHistoryOpen(false);
    setDeleteConfirm({ type: "all" });
  };

  const handleConfirmDelete = async () => {
    const target = deleteConfirm;
    setDeleteConfirm(null);
    if (!target) {
      return;
    }
    if (target.type === "all") {
      await handleClearHistory();
      return;
    }
    await handleDeleteConversation(target.id);
  };

  const appendReferenceImages = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    try {
      const previews = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          type: file.type || "image/png",
          dataUrl: await readFileAsDataUrl(file),
        })),
      );

      setReferenceImageFiles((prev) => [...prev, ...files]);
      setReferenceImages((prev) => [...prev, ...previews]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取参考图失败";
      toast.error(message);
    }
  }, [isCustomer]);

  const handleReferenceImageChange = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      await appendReferenceImages(files);
    },
    [appendReferenceImages],
  );

  const handleRemoveReferenceImage = useCallback((index: number) => {
    setReferenceImageFiles((prev) => {
      const next = prev.filter((_, currentIndex) => currentIndex !== index);
      if (next.length === 0 && fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return next;
    });
    setReferenceImages((prev) => prev.filter((_, currentIndex) => currentIndex !== index));
  }, []);

  const handleCancelTurn = useCallback(
    async (conversationId: string, turnId: string) => {
      cancelledTurnIds.add(turnId);
      await updateConversation(conversationId, (current) => {
        if (!current) return null as unknown as ImageConversation;
        return {
          ...current,
          updatedAt: new Date().toISOString(),
          turns: current.turns.map((turn) =>
            turn.id === turnId
              ? {
                  ...turn,
                  status: "error" as const,
                  error: "已手动取消",
                  images: turn.images.map((image) =>
                    image.status === "loading"
                      ? { ...image, status: "error" as const, error: "已取消" }
                      : image,
                  ),
                }
              : turn,
          ),
        };
      });
    },
    [updateConversation],
  );

  const handleContinueEdit = useCallback(
    async (conversationId: string, image: StoredImage | StoredReferenceImage) => {
      let nextReferenceImage: StoredReferenceImage | null;
      if ("dataUrl" in image) {
        nextReferenceImage = image;
      } else if (image.url) {
        try {
          const response = await fetch(image.url);
          const blob = await response.blob();
          const dataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.readAsDataURL(blob);
          });
          nextReferenceImage = { name: `conversation-${conversationId}-${Date.now()}.png`, type: blob.type || "image/png", dataUrl };
        } catch {
          toast.error("读取图片失败，无法继续编辑");
          return;
        }
      } else {
        nextReferenceImage = buildReferenceImageFromResult(image, `conversation-${conversationId}-${Date.now()}.png`);
      }
      if (!nextReferenceImage) {
        return;
      }

      setSelectedConversationId(conversationId);
      setImageMode("edit");
      setReferenceImages((prev) => [...prev, nextReferenceImage]);
      setReferenceImageFiles((prev) => [
        ...prev,
        dataUrlToFile(nextReferenceImage.dataUrl, nextReferenceImage.name, nextReferenceImage.type),
      ]);
      setImagePrompt("");
      textareaRef.current?.focus();
      toast.success("已加入当前参考图，继续输入描述即可编辑");
    },
    [],
  );

  const openLightbox = useCallback((images: ImageLightboxItem[], index: number) => {
    if (images.length === 0) {
      return;
    }

    setLightboxImages(images);
    setLightboxIndex(Math.max(0, Math.min(index, images.length - 1)));
    setLightboxOpen(true);
  }, []);

  /* eslint-disable react-hooks/preserve-manual-memoization */
  const runConversationQueue = useCallback(
    async (conversationId: string) => {
      if (activeConversationQueueIds.has(conversationId)) {
        return;
      }

      const snapshot = conversationsRef.current.find((conversation) => conversation.id === conversationId);
      const queuedTurn = snapshot?.turns.find((turn) => turn.status === "queued");
      if (!snapshot || !queuedTurn) {
        return;
      }

      activeConversationQueueIds.add(conversationId);
      await updateConversation(conversationId, (current) => {
        const conversation = current ?? snapshot;
        return {
          ...conversation,
          updatedAt: new Date().toISOString(),
          turns: conversation.turns.map((turn) =>
            turn.id === queuedTurn.id
              ? {
                  ...turn,
                  status: "generating",
                  error: undefined,
                }
              : turn,
          ),
        };
      });

      if (cancelledTurnIds.has(queuedTurn.id)) {
        cancelledTurnIds.delete(queuedTurn.id);
        activeConversationQueueIds.delete(conversationId);
        return;
      }

      try {
        const referenceFiles = queuedTurn.referenceImages.map((image, index) =>
          dataUrlToFile(image.dataUrl, image.name || `${queuedTurn.id}-${index + 1}.png`, image.type),
        );
        const pendingImages = queuedTurn.images.filter((image) => image.status === "loading");

        if (queuedTurn.mode === "edit" && referenceFiles.length === 0) {
          throw new Error("未找到可用于继续编辑的参考图");
        }

        if (pendingImages.length === 0) {
          const existingFailedCount = queuedTurn.images.filter((image) => image.status === "error").length;
          const existingSuccessCount = queuedTurn.images.filter((image) => image.status === "success").length;
          await updateConversation(conversationId, (current) => {
            const conversation = current ?? snapshot;
            return {
              ...conversation,
              updatedAt: new Date().toISOString(),
              turns: conversation.turns.map((turn) =>
                turn.id === queuedTurn.id
                  ? {
                      ...turn,
                      status: existingFailedCount > 0 ? "error" : existingSuccessCount > 0 ? "success" : "queued",
                      error: existingFailedCount > 0 ? `其中 ${existingFailedCount} 张未成功生成` : undefined,
                    }
                  : turn,
              ),
            };
          });
          return;
        }

        const tasks = pendingImages.map(async (pendingImage) => {
          let currentJobId = pendingImage.jobId;
          if (cancelledTurnIds.has(queuedTurn.id)) {
            return Promise.reject(new Error("已取消"));
          }
          try {
            let finalJobId = currentJobId;
            let first: CustomerImageJobResult | undefined;
            if (isCustomer) {
              first = await waitForCustomerImageJob({
                mode: queuedTurn.mode,
                files: referenceFiles,
                prompt: queuedTurn.prompt,
                model: queuedTurn.model,
                size: queuedTurn.size,
                clientRequestId: pendingImage.id,
                existingJobId: currentJobId,
                isCancelled: () => cancelledTurnIds.has(queuedTurn.id),
                onJobId: async (jobId) => {
                  currentJobId = jobId;
                  finalJobId = jobId;
                  await updateConversation(
                    conversationId,
                    (current) => {
                      const conversation = current ?? snapshot;
                      return {
                        ...conversation,
                        updatedAt: new Date().toISOString(),
                        turns: conversation.turns.map((turn) =>
                          turn.id === queuedTurn.id
                            ? {
                                ...turn,
                                images: turn.images.map((image) =>
                                  image.id === pendingImage.id ? { ...image, jobId } : image,
                                ),
                              }
                            : turn,
                        ),
                      };
                    },
                    { persist: true },
                  );
                },
              });
            } else {
              const data = queuedTurn.mode === "edit"
                ? await editImage(referenceFiles, queuedTurn.prompt, queuedTurn.model, queuedTurn.size)
                : await generateImage(queuedTurn.prompt, queuedTurn.model, queuedTurn.size);
              first = data.data?.[0];
            }

            if (!first?.url && !first?.b64_json) {
              throw new Error("未返回图片数据");
            }

            const nextImage: StoredImage = {
              id: pendingImage.id,
              jobId: finalJobId,
              status: "success",
              url: first.url,
              b64_json: first.b64_json,
            };

            await updateConversation(
              conversationId,
              (current) => {
                const conversation = current ?? snapshot;
                return {
                  ...conversation,
                  updatedAt: new Date().toISOString(),
                  turns: conversation.turns.map((turn) =>
                    turn.id === queuedTurn.id
                      ? {
                          ...turn,
                          images: turn.images.map((image) => (image.id === nextImage.id ? nextImage : image)),
                        }
                      : turn,
                  ),
                };
              },
              { persist: false },
            );

            return nextImage;
          } catch (error) {
            const message = error instanceof Error ? error.message : "生成失败";
            const failedImage: StoredImage = {
              id: pendingImage.id,
              jobId: currentJobId,
              status: "error",
              error: message,
            };

            await updateConversation(
              conversationId,
              (current) => {
                const conversation = current ?? snapshot;
                return {
                  ...conversation,
                  updatedAt: new Date().toISOString(),
                  turns: conversation.turns.map((turn) =>
                    turn.id === queuedTurn.id
                      ? {
                          ...turn,
                          images: turn.images.map((image) => (image.id === failedImage.id ? failedImage : image)),
                        }
                      : turn,
                  ),
                };
              },
              { persist: false },
            );

            throw error;
          }
        });

        const settled = await Promise.allSettled(tasks);
        const resumedSuccessCount = settled.filter(
          (item): item is PromiseFulfilledResult<StoredImage> => item.status === "fulfilled",
        ).length;
        const resumedFailedCount = settled.length - resumedSuccessCount;
        const existingSuccessCount = queuedTurn.images.filter((image) => image.status === "success").length;
        const existingFailedCount = queuedTurn.images.filter((image) => image.status === "error").length;
        const successCount = existingSuccessCount + resumedSuccessCount;
        const failedCount = existingFailedCount + resumedFailedCount;

        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns: conversation.turns.map((turn) =>
              turn.id === queuedTurn.id
                ? {
                    ...turn,
                    status: failedCount > 0 ? "error" : "success",
                    error: failedCount > 0 ? `其中 ${failedCount} 张未成功生成` : undefined,
                  }
                : turn,
            ),
          };
        });

        await loadQuota();
      } catch (error) {
        const message = error instanceof Error ? error.message : "生成图片失败";
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns: conversation.turns.map((turn) =>
              turn.id === queuedTurn.id
                ? {
                    ...turn,
                    status: "error",
                    error: message,
                    images: turn.images.map((image) =>
                      image.status === "loading" ? { ...image, status: "error", error: message } : image,
                    ),
                  }
                : turn,
            ),
          };
        });
        toast.error(message);
      } finally {
        activeConversationQueueIds.delete(conversationId);
        for (const conversation of conversationsRef.current) {
          if (
            !activeConversationQueueIds.has(conversation.id) &&
            conversation.turns.some((turn) => turn.status === "queued")
          ) {
            void runConversationQueue(conversation.id);
          }
        }
      }
    },
    [isCustomer, loadQuota, updateConversation],
  );
  /* eslint-enable react-hooks/preserve-manual-memoization */

  useEffect(() => {
    for (const conversation of conversations) {
      if (
        !activeConversationQueueIds.has(conversation.id) &&
        conversation.turns.some((turn) => turn.status === "queued")
      ) {
        void runConversationQueue(conversation.id);
      }
    }
  }, [conversations, runConversationQueue]);

  const handleRedeemCdk = async () => {
    const code = redeemCode.trim();
    if (!code) {
      toast.error("请输入 CDK");
      return;
    }
    setIsRedeeming(true);
    try {
      const data = await redeemCdk(code);
      setAvailableQuota(String(data.balance));
      setRedeemCode("");
      setIsRedeemOpen(false);
      toast.success(`兑换成功，到账 ${data.credited} 额度`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "兑换失败";
      toast.error(message);
    } finally {
      setIsRedeeming(false);
    }
  };

  const handleLogout = async () => {
    try {
      await logoutUser();
    } catch {
    } finally {
      await clearStoredAuthSession();
      if (typeof window !== "undefined") {
        window.location.replace("/login");
      }
    }
  };

  const handleUseExamplePrompt = (value: string) => {
    setImagePrompt(value);
    textareaRef.current?.focus();
  };

  const handleSubmit = async () => {
    const prompt = imagePrompt.trim();
    if (!prompt) {
      toast.error("请输入提示词");
      return;
    }

    if (isCustomer && hasKnownInsufficientBalance) {
      toast.error("额度不足，请先兑换 CDK");
      return;
    }

    const submitMode: ImageConversationMode = referenceImageFiles.length > 0 ? "edit" : "generate";

    const targetConversation = selectedConversationId
      ? conversationsRef.current.find((conversation) => conversation.id === selectedConversationId) ?? null
      : null;
    const now = new Date().toISOString();
    const conversationId = targetConversation?.id ?? createId();
    const turnId = createId();
    const draftTurn: ImageTurn = {
      id: turnId,
      prompt,
      model: "gpt-image-2",
      mode: submitMode,
      referenceImages: submitMode === "edit" ? referenceImages : [],
      count: parsedCount,
      size: imageSize,
      images: Array.from({ length: parsedCount }, (_, index) => ({
        id: `${turnId}-${index}`,
        status: "loading" as const,
      })),
      createdAt: now,
      status: "queued",
    };

    const baseConversation: ImageConversation = targetConversation
      ? {
          ...targetConversation,
          updatedAt: now,
          turns: [...targetConversation.turns, draftTurn],
        }
      : {
          id: conversationId,
          title: buildConversationTitle(prompt),
          createdAt: now,
          updatedAt: now,
          turns: [draftTurn],
        };

    setSelectedConversationId(conversationId);
    clearComposerInputs();

    await persistConversation(baseConversation);
    void runConversationQueue(conversationId);

    const targetStats = getImageConversationStats(baseConversation);
    if (targetStats.running > 0 || targetStats.queued > 1) {
      toast.success("已加入当前对话队列");
    } else if (!targetConversation) {
      toast.success("已创建新对话并开始处理");
    } else {
      toast.success("已发送到当前对话");
    }
  };

  return (
    <>
      <section className="mx-auto grid h-full min-h-0 w-full max-w-[1380px] touch-none grid-cols-1 gap-2 overflow-hidden overscroll-none px-2 pb-3 sm:gap-3 sm:px-3 sm:pb-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div className="hidden h-full min-h-0 border-r border-stone-200/70 pr-3 lg:block">
          <ImageSidebar
            conversations={conversations}
            isLoadingHistory={isLoadingHistory}
            selectedConversationId={selectedConversationId}
            onCreateDraft={handleCreateDraft}
            onClearHistory={openClearHistoryConfirm}
            onSelectConversation={(id) => void handleSelectConversation(id)}
            onDeleteConversation={openDeleteConversationConfirm}
            formatConversationTime={formatConversationTime}
          />
        </div>

        <Dialog open={isHistoryOpen} onOpenChange={setIsHistoryOpen}>
          <DialogContent className="flex h-[80vh] w-[92vw] max-w-[420px] flex-col overflow-hidden rounded-[32px] border-stone-200 bg-white p-0 shadow-2xl">
            <DialogHeader className="px-6 pt-6 pb-2">
              <DialogTitle className="flex items-center gap-2 text-lg font-bold text-[#203d2b]">
                <History className="size-5" />
                我的图片
              </DialogTitle>
              <DialogDescription className="text-sm text-[#6a7458]">
                生成过的图片会保存在这里，方便继续修改。
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
              <ImageSidebar
                conversations={conversations}
                isLoadingHistory={isLoadingHistory}
                selectedConversationId={selectedConversationId}
                onCreateDraft={() => {
                  handleCreateDraft();
                  setIsHistoryOpen(false);
                }}
                onClearHistory={openClearHistoryConfirm}
                onSelectConversation={(id) => {
                  void handleSelectConversation(id);
                  setIsHistoryOpen(false);
                }}
                onDeleteConversation={openDeleteConversationConfirm}
                formatConversationTime={formatConversationTime}
                hideActionButtons
              />
            </div>
          </DialogContent>
        </Dialog>

        <div className="flex h-full min-h-0 touch-none flex-col overflow-hidden sm:gap-4">
          <div className="shrink-0 pb-2">
            <ImageMobileHeader
              historyCount={conversations.length}
              activeTaskCount={activeTaskCount}
              availableQuota={availableQuota}
              isCustomer={isCustomer}
              onOpenHistory={() => setIsHistoryOpen(true)}
              onRedeem={() => setIsRedeemOpen(true)}
              onLogout={() => void handleLogout()}
            />
          </div>

          <ImageCreditSummary
            availableQuota={availableQuota}
            isCustomer={isCustomer}
            onRedeem={() => setIsRedeemOpen(true)}
            onLogout={() => void handleLogout()}
          />

          <div
            ref={resultsViewportRef}
            className="hide-scrollbar min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-0 py-1 sm:px-4 sm:py-4"
            onTouchMove={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            <ImageResults
              selectedConversation={selectedConversation}
              onOpenLightbox={openLightbox}
              onContinueEdit={handleContinueEdit}
              onCancelTurn={handleCancelTurn}
              formatConversationTime={formatConversationTime}
              onUseExamplePrompt={handleUseExamplePrompt}
              canEdit
            />
          </div>

          <ImageComposer
            mode={imageMode}
            prompt={imagePrompt}
            imageCount={imageCount}
            imageSize={imageSize}
            availableQuota={availableQuota}
            quotaLabel={isCustomer ? "可用额度" : "剩余额度"}
            costHint={isCustomer ? `预计消耗 ${estimatedCost} 额度` : ""}
            canEdit
            canSubmit={!hasKnownInsufficientBalance}
            submitDisabledReason={hasKnownInsufficientBalance ? "额度不足，请先兑换 CDK" : ""}
            activeTaskCount={activeTaskCount}
            referenceImages={referenceImages}
            textareaRef={textareaRef}
            fileInputRef={fileInputRef}
            onModeChange={setImageMode}
            onPromptChange={setImagePrompt}
            onImageCountChange={setImageCount}
            onImageSizeChange={setImageSize}
            onSubmit={handleSubmit}
            onPickReferenceImage={() => fileInputRef.current?.click()}
            onReferenceImageChange={handleReferenceImageChange}
            onRemoveReferenceImage={handleRemoveReferenceImage}
          />
        </div>
      </section>

      <ImageLightbox
        images={lightboxImages}
        currentIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={setLightboxIndex}
      />

      {isRedeemOpen ? (
        <div className="fixed inset-0 z-[1200] bg-black/30 px-4 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur-[2px] sm:flex sm:items-center sm:justify-center sm:p-4">
          <div className="paper-surface leaf-glow mx-auto max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-[32px] bg-[#fffdf4]/95 p-6 shadow-[0_36px_120px_-45px_rgba(16,24,40,0.45)]">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div className="space-y-2">
                <h2 className="text-xl font-semibold leading-none text-[#203d2b]">兑换 CDK</h2>
                <p className="text-sm leading-6 text-[#6a7458]">输入管理员发放的 CDK，兑换后额度会立即到账。</p>
              </div>
              <button
                type="button"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-[#6a7458] transition hover:bg-[#edf6dc]"
                onClick={() => setIsRedeemOpen(false)}
                aria-label="关闭兑换窗口"
              >
                ×
              </button>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">CDK</label>
              <input
                value={redeemCode}
                onChange={(event) => setRedeemCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleRedeemCdk();
                  }
                }}
                placeholder="请输入 CDK"
                className="h-12 w-full rounded-2xl border border-[#cad9b2] bg-[#fffdf4]/90 px-4 text-sm text-[#203d2b] outline-none transition duration-200 placeholder:text-[#8f9a78] focus:border-[#6f9f48] focus:ring-4 focus:ring-[#6f9f48]/15"
              />
            </div>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setIsRedeemOpen(false)}>
                取消
              </Button>
              <Button className="nature-interactive bg-linear-to-br from-[#2f6233] to-[#6f9f48] text-[#fbf8ed] shadow-[0_12px_30px_-18px_rgba(47,98,51,0.8)] hover:brightness-105" onClick={() => void handleRedeemCdk()} disabled={isRedeeming}>
                {isRedeeming ? <LoaderCircle className="size-4 animate-spin" /> : null}
                兑换
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteConfirm ? (
        <Dialog open onOpenChange={(open) => (!open ? setDeleteConfirm(null) : null)}>
          <DialogContent showCloseButton={false} className="rounded-2xl p-6">
            <DialogHeader className="gap-2">
              <DialogTitle>{deleteConfirmTitle}</DialogTitle>
              <DialogDescription className="text-sm leading-6">
                {deleteConfirmDescription}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
                取消
              </Button>
              <Button className="bg-rose-600 text-white hover:bg-rose-700" onClick={() => void handleConfirmDelete()}>
                确认删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

export default function ImagePage() {
  const { isCheckingAuth, session } = useAuthGuard();

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <ImagePageContent isAdmin={session.role === "admin"} isCustomer={session.role === "customer"} ownerId={session.subjectId || session.name || session.key} />;
}
