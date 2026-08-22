import { useEffect, useState, type FormEvent } from "react";
import { Button } from "$lib/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "$lib/components/ui/dialog";
import { Label } from "$lib/components/ui/label";
import { Textarea } from "$lib/components/ui/textarea";
import { useI18n } from "$lib/i18n";

type Props = {
  open?: boolean;
  content?: string;
  onOpenChange?: (open: boolean) => void;
  onSave?: (content: string) => void;
};

export function EditMemoryDialog({ open = false, content = "", onOpenChange, onSave }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (open) setDraft(content);
  }, [open, content]);

  function handleOpenChange(next: boolean) {
    onOpenChange?.(next);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = draft.trim();
    if (!value) return;
    onSave?.(value);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("modal-edit-title")}</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="edit-content">{t("label-content")}</Label>
            <Textarea
              id="edit-content"
              rows={6}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
              {t("btn-cancel")}
            </Button>
            <Button type="submit">{t("btn-save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
