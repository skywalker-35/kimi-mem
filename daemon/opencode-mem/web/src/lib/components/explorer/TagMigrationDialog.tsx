import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { fetchAPI } from "$lib/api";
import { Button } from "$lib/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "$lib/components/ui/dialog";
import { useI18n } from "$lib/i18n";

type Props = {
  open?: boolean;
  count?: number;
  onOpenChange?: (open: boolean) => void;
  onComplete?: () => void;
};

export function TagMigrationDialog({ open = false, count = 0, onOpenChange, onComplete }: Props) {
  const { t } = useI18n();
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (open && !running) {
      setStatus(t("migration-found-tags", { count }));
      setProgress(0);
    }
  }, [open, running, count, t]);

  function handleOpenChange(next: boolean) {
    if (running && !next) return;
    onOpenChange?.(next);
  }

  async function runTagMigration() {
    setRunning(true);
    setStatus(t("status-migration-init"));
    setProgress(0);

    let totalProcessed = 0;
    let hasMore = true;
    let attempts = 0;
    const maxAttempts = 1000;

    while (hasMore && attempts < maxAttempts) {
      attempts++;
      const result = await fetchAPI<{
        processed: number;
        hasMore: boolean;
        total: number;
      }>("/api/migration/tags/run-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchSize: 3 }),
      });

      if (!result.success || !result.data) {
        setStatus(t("toast-migration-failed") + ": " + (result.error || ""));
        setRunning(false);
        return;
      }

      totalProcessed = result.data.processed;
      hasMore = result.data.hasMore;
      const total = result.data.total;
      setProgress(total > 0 ? Math.round((totalProcessed / total) * 100) : 0);
      setStatus(t("status-migration-progress", { current: totalProcessed, total }));
      if (hasMore) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    if (attempts >= maxAttempts) {
      setStatus(t("migration-stopped"));
      setRunning(false);
      return;
    }

    setProgress(100);
    setStatus(t("toast-migration-success"));
    toast.success(t("toast-migration-success"));
    setTimeout(() => {
      setRunning(false);
      handleOpenChange(false);
      onComplete?.();
    }, 2000);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={!running}>
        <DialogHeader>
          <DialogTitle>{t("modal-migration-title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{status}</p>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t("migration-note")}</p>
        </div>
        {!running ? (
          <DialogFooter>
            <Button onClick={runTagMigration}>
              <Play className="size-3.5" />
              {t("btn-start-migration")}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
