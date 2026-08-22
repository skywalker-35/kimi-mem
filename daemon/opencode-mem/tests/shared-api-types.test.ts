import { describe, expect, it } from "bun:test";
import {
  ApiResultSchema,
  MemoryItemSchema,
  UserProfileSchema,
  type ApiResult,
  type MemoryItem,
  type UserProfile,
} from "../src/shared/api/index.js";

describe("shared API contracts", () => {
  it("parses ApiResult envelope", () => {
    const parsed = ApiResultSchema.parse({ success: true, data: { ok: 1 } });
    expect(parsed.success).toBe(true);
    const typed: ApiResult<{ ok: number }> = { success: true, data: { ok: 1 } };
    expect(typed.data?.ok).toBe(1);
  });

  it("accepts MemoryItem shape used by the web UI", () => {
    const item: MemoryItem = {
      id: "m1",
      type: "memory",
      content: "hello",
      createdAt: new Date().toISOString(),
      isPinned: true,
    };
    expect(MemoryItemSchema.parse(item).id).toBe("m1");
  });

  it("accepts UserProfile shape used by the web UI", () => {
    const profile: UserProfile = {
      exists: true,
      userId: "u@example.com",
      profileData: { preferences: [{ description: "prefers TS" }] },
    };
    expect(UserProfileSchema.parse(profile).exists).toBe(true);
  });
});
