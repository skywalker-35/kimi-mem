import { useEffect, useState, type FormEvent } from "react";
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
import { Input } from "$lib/components/ui/input";
import { Label } from "$lib/components/ui/label";
import { Textarea } from "$lib/components/ui/textarea";
import { useI18n } from "$lib/i18n";
import type { ProfileItem } from "$lib/types";

type ProfileField = "preferences" | "patterns" | "workflows";

type Props = {
  open?: boolean;
  type?: ProfileField | null;
  index?: number;
  action?: "edit" | "delete";
  item?: ProfileItem | null;
  onOpenChange?: (open: boolean) => void;
  onSaved?: () => void;
};

export function ProfileItemDialog({
  open = false,
  type = null,
  index = 0,
  action = "edit",
  item = null,
  onOpenChange,
  onSaved,
}: Props) {
  const { t } = useI18n();
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<string[]>([""]);
  const [deleteStep, setDeleteStep] = useState<"1" | "2">("1");
  const [saving, setSaving] = useState(false);

  const isEdit = action === "edit";
  const isWorkflow = type === "workflows";

  useEffect(() => {
    if (open && item) {
      setCategory(item.category || "");
      setDescription(item.description || "");
      setSteps(item.steps?.length ? [...item.steps] : [""]);
      setDeleteStep("1");
    }
  }, [open, item]);

  const title = isEdit
    ? t("btn-edit") || "Edit Item"
    : deleteStep === "2"
      ? t("confirm-delete-title") || "Confirm Delete"
      : t("confirm-delete") || "Delete Item?";

  function handleOpenChange(next: boolean) {
    onOpenChange?.(next);
  }

  function addStep() {
    setSteps((prev) => [...prev, ""]);
  }

  function removeStep(i: number) {
    setSteps((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      return next.length === 0 ? [""] : next;
    });
  }

  function updateStep(i: number, value: string) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? value : s)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!type) return;

    if (action === "delete") {
      if (deleteStep === "1") {
        setDeleteStep("2");
        return;
      }
      setSaving(true);
      const result = await fetchAPI("/api/user-profile/item", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, index, action: "delete" }),
      });
      setSaving(false);
      if (result.success) {
        toast.success(t("toast-delete-success") || "Item deleted");
        handleOpenChange(false);
        onSaved?.();
      } else {
        toast.error(result.error || t("toast-delete-failed") || "Delete failed");
      }
      return;
    }

    setSaving(true);
    const body: Record<string, unknown> = {
      type,
      index,
      action: "edit",
      category: isWorkflow ? undefined : category,
      description,
    };
    if (type === "workflows") {
      body.steps = steps.map((s) => s.trim()).filter(Boolean);
    }

    const result = await fetchAPI("/api/user-profile/item", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);

    if (result.success) {
      toast.success(t("toast-update-success") || "Item updated");
      handleOpenChange(false);
      onSaved?.();
    } else {
      toast.error(result.error || t("toast-update-failed") || "Update failed");
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          {isEdit || deleteStep === "1" ? (
            <>
              {!isWorkflow ? (
                <div className="space-y-2">
                  <Label htmlFor="profile-item-category">{t("label-category")}</Label>
                  <Input
                    id="profile-item-category"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    disabled={!isEdit}
                  />
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="profile-item-description">{t("label-description")}</Label>
                <Textarea
                  id="profile-item-description"
                  rows={4}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={!isEdit}
                />
              </div>
              {isWorkflow && isEdit ? (
                <div className="space-y-2">
                  <Label>{t("label-steps")}</Label>
                  <div className="space-y-2">
                    {steps.map((step, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground w-5 tabular-nums">
                          {i + 1}
                        </span>
                        <Input
                          value={step}
                          placeholder={`Step ${i + 1}...`}
                          onChange={(e) => updateStep(i, e.target.value)}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => removeStep(i)}
                        >
                          ×
                        </Button>
                      </div>
                    ))}
                  </div>
                  <Button type="button" variant="secondary" size="sm" onClick={addStep}>
                    {t("btn-add-step")}
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
              {t("btn-cancel")}
            </Button>
            <Button type="submit" variant={isEdit ? "default" : "destructive"} disabled={saving}>
              {isEdit ? t("btn-save") || "Save" : t("btn-delete") || "Delete"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
