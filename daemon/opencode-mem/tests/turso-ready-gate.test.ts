import { describe, expect, it, afterEach } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

describe("turso ready gate", () => {
  let baseDir: string;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
  });

  it("runs legacy migration once and initializes metadata", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-ready-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;

    const { ensureTursoReady } = await import("../src/services/turso/ready.js");
    await ensureTursoReady();
    await ensureTursoReady();

    expect(existsSync(join(baseDir, "metadata.db"))).toBe(true);
  });

  it("throws when migration lock is held by another live process", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-ready-lock-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;

    writeFileSync(
      join(baseDir, ".turso-migrate.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
      "utf-8"
    );

    const { runLegacyTursoMigration } = await import("../src/services/turso/legacy-migrator.js");
    await expect(runLegacyTursoMigration()).rejects.toThrow(/locked by another process/);
  });
});
