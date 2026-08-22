import { jsonrepair } from "jsonrepair";
import type { ProfileItem } from "./types";

export function parseProfileField(field: unknown): ProfileItem[] {
  if (!field) return [];
  let result: unknown = field;
  let lastResult: unknown = null;
  while (typeof result === "string" && result !== lastResult) {
    lastResult = result;
    try {
      result = JSON.parse(jsonrepair(result));
    } catch {
      break;
    }
  }
  if (!Array.isArray(result)) return [];
  const flattened: ProfileItem[] = [];
  const walk = (item: unknown) => {
    if (Array.isArray(item)) item.forEach(walk);
    else if (item && typeof item === "object") flattened.push(item as ProfileItem);
  };
  walk(result);
  return flattened;
}

export function findDescById(
  id: string,
  profileData?: { preferences?: ProfileItem[]; patterns?: ProfileItem[]; workflows?: ProfileItem[] }
): string | null {
  if (!profileData || !id.includes("_")) return null;
  const [prefix, idxStr] = id.split("_");
  const idx = parseInt(idxStr, 10);
  if (Number.isNaN(idx)) return null;
  if (prefix === "pref") return profileData.preferences?.[idx]?.description ?? null;
  if (prefix === "pat") return profileData.patterns?.[idx]?.description ?? null;
  if (prefix === "wf") return profileData.workflows?.[idx]?.description ?? null;
  return null;
}

export function findStepsById(
  id: string,
  profileData?: { preferences?: ProfileItem[]; patterns?: ProfileItem[]; workflows?: ProfileItem[] }
): string[] | null {
  if (!profileData || !id.includes("_")) return null;
  const [prefix, idxStr] = id.split("_");
  const idx = parseInt(idxStr, 10);
  if (Number.isNaN(idx) || prefix !== "wf") return null;
  return profileData.workflows?.[idx]?.steps || null;
}
