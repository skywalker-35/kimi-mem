import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { MemoryCard } from "./MemoryCard";
import { Button } from "$lib/components/ui/button";
import { groupMemories } from "$lib/group-memories";
import { useI18n } from "$lib/i18n";
import type { MemoryItem } from "$lib/types";

type Props = {
  memories: MemoryItem[];
  selectedIds: Set<string>;
  currentPage: number;
  totalPages: number;
  totalItems: number;
  isSearching: boolean;
  loading?: boolean;
  error?: string | null;
  onSelect: (id: string, selected: boolean) => void;
  onPageChange: (delta: number) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onEdit: (id: string) => void;
  onDeleteMemory: (id: string, isLinked: boolean) => void;
  onDeletePrompt: (id: string, isLinked: boolean) => void;
};

export function MemoryList({
  memories,
  selectedIds,
  currentPage,
  totalPages,
  loading = false,
  error = null,
  onSelect,
  onPageChange,
  onPin,
  onUnpin,
  onEdit,
  onDeleteMemory,
  onDeletePrompt,
}: Props) {
  const { t } = useI18n();
  const groups = useMemo(() => groupMemories(memories), [memories]);
  const pageInfo = t("text-page", { current: currentPage, total: totalPages });
  const hasPrev = currentPage > 1;
  const hasNext = currentPage < totalPages;

  const pagination = (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="icon-xs" disabled={!hasPrev} onClick={() => onPageChange(-1)}>
        <ChevronLeft className="size-3.5" />
      </Button>
      <span className="text-xs text-muted-foreground tabular-nums">{pageInfo}</span>
      <Button variant="outline" size="icon-xs" disabled={!hasNext} onClick={() => onPageChange(1)}>
        <ChevronRight className="size-3.5" />
      </Button>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="space-y-3 min-h-32">
        {loading && memories.length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center">{t("loading-init")}</div>
        ) : error ? (
          <div className="text-sm text-destructive py-8 text-center">Error: {error}</div>
        ) : groups.length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            {t("empty-memories")}
          </div>
        ) : (
          groups.map((group) =>
            group.isPair ? (
              <MemoryCard
                key={group.memory.id}
                variant="pair"
                memory={group.memory}
                prompt={group.prompt}
                selected={selectedIds.has(group.memory.id)}
                onSelect={onSelect}
                onPin={onPin}
                onUnpin={onUnpin}
                onEdit={onEdit}
                onDeleteMemory={onDeleteMemory}
                onDeletePrompt={onDeletePrompt}
              />
            ) : group.type === "prompt" ? (
              <MemoryCard
                key={group.item.id}
                variant="prompt"
                item={group.item}
                selected={selectedIds.has(group.item.id)}
                onSelect={onSelect}
                onPin={onPin}
                onUnpin={onUnpin}
                onEdit={onEdit}
                onDeleteMemory={onDeleteMemory}
                onDeletePrompt={onDeletePrompt}
              />
            ) : (
              <MemoryCard
                key={group.item.id}
                variant="memory"
                item={group.item}
                selected={selectedIds.has(group.item.id)}
                onSelect={onSelect}
                onPin={onPin}
                onUnpin={onUnpin}
                onEdit={onEdit}
                onDeleteMemory={onDeleteMemory}
                onDeletePrompt={onDeletePrompt}
              />
            )
          )
        )}
      </div>

      <div className="flex justify-end">{pagination}</div>
    </div>
  );
}
