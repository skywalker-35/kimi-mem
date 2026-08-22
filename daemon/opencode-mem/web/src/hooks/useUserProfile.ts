import { useCallback, useState } from "react";
import { toast } from "sonner";
import { fetchAPI } from "$lib/api";
import { t } from "$lib/i18n";
import type { UserProfile } from "$lib/types";

export function useUserProfile() {
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [aiCleanupOpen, setAiCleanupOpen] = useState(false);

  const loadUserProfile = useCallback(async () => {
    setLoadingProfile(true);
    const result = await fetchAPI<UserProfile>("/api/user-profile");
    setLoadingProfile(false);
    if (result.success && result.data) {
      setUserProfile(result.data);
    } else {
      toast.error(result.error || t("toast-update-failed"));
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    toast.info(t("loading-profile"));
    const result = await fetchAPI("/api/user-profile/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (result.success) {
      toast.success((result.data as { message?: string })?.message || t("toast-update-success"));
      await loadUserProfile();
    } else {
      toast.error(result.error || t("toast-update-failed"));
    }
  }, [loadUserProfile]);

  return {
    userProfile,
    loadingProfile,
    aiCleanupOpen,
    setAiCleanupOpen,
    loadUserProfile,
    refreshProfile,
  };
}
