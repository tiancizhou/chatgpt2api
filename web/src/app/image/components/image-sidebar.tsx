"use client";

import { LoaderCircle, MessageSquarePlus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getImageConversationStats, type ImageConversation } from "@/store/image-conversations";

type ImageSidebarProps = {
  conversations: ImageConversation[];
  isLoadingHistory: boolean;
  selectedConversationId: string | null;
  onCreateDraft: () => void;
  onClearHistory: () => void | Promise<void>;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void | Promise<void>;
  formatConversationTime: (value: string) => string;
  hideActionButtons?: boolean;
};

export function ImageSidebar({
  conversations,
  isLoadingHistory,
  selectedConversationId,
  onCreateDraft,
  onClearHistory,
  onSelectConversation,
  onDeleteConversation,
  formatConversationTime,
  hideActionButtons = false,
}: ImageSidebarProps) {
  return (
    <aside className="h-full min-h-0 overflow-hidden">
      <div className="flex h-full min-h-0 flex-col gap-2 py-1 sm:gap-3 sm:py-2">
        {!hideActionButtons ? (
          <div className="flex items-center gap-2">
            <Button className="nature-interactive h-10 flex-1 rounded-xl bg-linear-to-br from-[#2f6233] to-[#6f9f48] text-[#fbf8ed] hover:brightness-105" onClick={onCreateDraft}>
              <MessageSquarePlus className="size-4" />
              新建创作
            </Button>
            <Button
              variant="outline"
              className="h-10 rounded-xl border-[#cad9b2] bg-[#fffdf4]/85 px-3 text-[#6a7458] hover:bg-[#edf6dc]"
              onClick={() => void onClearHistory()}
              disabled={conversations.length === 0}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ) : null}

        <div className="hide-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {isLoadingHistory ? (
            <div className="flex items-center gap-2 rounded-2xl bg-[#fffdf4]/70 px-3 py-4 text-sm text-[#6a7458]">
              <LoaderCircle className="size-4 animate-spin" />
              正在读取图片记录
            </div>
          ) : conversations.length === 0 ? (
            <div className="rounded-[24px] border border-[#cad9b2]/70 bg-[#fffdf4]/80 px-4 py-6 text-sm leading-6 text-[#6a7458]">
              生成过的图片会保存在这里，方便继续修改。
            </div>
          ) : (
            conversations.map((conversation) => {
              const active = conversation.id === selectedConversationId;
              const stats = getImageConversationStats(conversation);
              return (
                <div
                  key={conversation.id}
                  className={cn(
                    "group relative w-full rounded-[22px] border px-3 py-3 text-left shadow-sm transition sm:rounded-none sm:border-l-2 sm:border-y-0 sm:border-r-0 sm:shadow-none",
                    active
                      ? "border-[#6f9f48] bg-[#edf6dc]/78 text-[#203d2b]"
                      : "border-[#cad9b2]/45 bg-[#fffdf4]/68 text-[#315f35] hover:border-[#a9bf82] hover:bg-[#fffdf4]",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelectConversation(conversation.id)}
                    className="block min-h-12 w-full pr-10 text-left"
                  >
                    <div className="truncate text-sm font-semibold">
                      <span className="truncate">{conversation.title}</span>
                    </div>
                    <div className={cn("mt-1 text-xs", active ? "text-[#6a7458]" : "text-[#8f9a78]")}>
                      {conversation.turns.length} 轮 · {formatConversationTime(conversation.updatedAt)}
                    </div>
                    {stats.running > 0 || stats.queued > 0 ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                        {stats.running > 0 ? <span className="rounded-full bg-blue-50 px-2 py-1 text-blue-600">生成中 {stats.running}</span> : null}
                        {stats.queued > 0 ? <span className="rounded-full bg-amber-50 px-2 py-1 text-amber-700">排队 {stats.queued}</span> : null}
                      </div>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDeleteConversation(conversation.id)}
                    className="absolute right-2 top-3 inline-flex size-8 items-center justify-center rounded-full text-[#8f9a78] transition hover:bg-rose-50 hover:text-rose-500 sm:opacity-0 sm:group-hover:opacity-100"
                    aria-label="删除图片记录"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              );
            })
          )}
        </div>

        {hideActionButtons && conversations.length > 0 ? (
          <div className="flex shrink-0 gap-2 border-t border-[#cad9b2]/55 pt-3">
            <Button
              variant="outline"
              className="h-10 flex-1 rounded-full border-[#cad9b2] bg-[#fffdf4]/85 text-[#315f35] hover:bg-[#edf6dc]"
              onClick={onCreateDraft}
            >
              <MessageSquarePlus className="size-4" />
              新建创作
            </Button>
            <Button
              variant="outline"
              className="h-10 rounded-full border-[#cad9b2] bg-[#fffdf4]/85 px-3 text-[#8b7858] hover:bg-[#edf6dc]"
              onClick={() => void onClearHistory()}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
