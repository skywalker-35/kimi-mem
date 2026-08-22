import { useEffect, useState } from "react";
import { fetchAPI } from "$lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "$lib/components/ui/dialog";
import { ScrollArea } from "$lib/components/ui/scroll-area";
import { formatDate } from "$lib/format";
import { useI18n } from "$lib/i18n";

type ChangelogEntry = {
  version: number;
  changeType: string;
  createdAt: string;
  changeSummary: string;
};

type Props = {
  open?: boolean;
  profileId?: string;
  onOpenChange?: (open: boolean) => void;
};

export function ChangelogDialog({ open = false, profileId = "", onOpenChange }: Props) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);

  useEffect(() => {
    if (open && profileId) {
      void loadChangelog(profileId);
    }
  }, [open, profileId]);

  async function loadChangelog(id: string) {
    setLoading(true);
    setEntries([]);
    const result = await fetchAPI<ChangelogEntry[]>(
      `/api/user-profile/changelog?profileId=${encodeURIComponent(id)}&limit=10`
    );
    setLoading(false);
    if (result.success && result.data) {
      setEntries(result.data);
    } else {
      setEntries([]);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("modal-changelog-title")}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-80">
          {loading ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              {t("loading-changelog")}
            </div>
          ) : entries.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              {t("empty-changelog")}
            </div>
          ) : (
            <div className="space-y-3 pr-3">
              {entries.map((entry, i) => (
                <div
                  key={`${entry.version}-${i}`}
                  className="rounded-lg border border-border p-3 space-y-1"
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium">v{entry.version}</span>
                    <span className="text-muted-foreground">{entry.changeType}</span>
                    <span className="text-muted-foreground ml-auto">
                      {formatDate(entry.createdAt)}
                    </span>
                  </div>
                  <p className="text-sm">{entry.changeSummary}</p>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
