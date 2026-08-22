import { describe, expect, it } from "bun:test";
import pkg from "../package.json";

describe("published dependency constraints", () => {
  it("uses @libsql/client for Turso persistence and vector search", () => {
    expect(pkg.dependencies["@libsql/client"]).toBeTruthy();
    expect(pkg.dependencies).not.toHaveProperty("usearch");
  });

  it("uses @huggingface/transformers (v4+) as the local embedding backend", () => {
    expect(pkg.dependencies["@huggingface/transformers"]).toMatch(/^\^?4\./);
    expect(pkg.dependencies).not.toHaveProperty("@xenova/transformers");
  });

  it("pins onnxruntime-node@1.20.1 as a direct dependency (Intel binding + Bun teardown)", () => {
    // Nested package.json overrides are ignored by npm/Arborist (#184). A direct
    // dependency is required so Intel Mac (darwin/x64) gets a shipping binding.
    // Stay on 1.20.1 until onnxruntime publishes a post-teardown-fix x64 build
    // (#225 / microsoft/onnxruntime#24579 / #27961) and OpenCode embeds Bun >1.3.14.
    expect(pkg.dependencies["onnxruntime-node"]).toBe("1.20.1");
    expect((pkg as { overrides?: Record<string, string> }).overrides?.["onnxruntime-node"]).toBe(
      "1.20.1"
    );
  });
});
