import { describe, expect, it, afterEach } from "bun:test";
import type { Client } from "@libsql/client";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

describe("turso connection manager", () => {
  let baseDir: string;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
  });

  it("deduplicates concurrent getConnection calls for the same path", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-conn-race-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    const dbPath = join(baseDir, "single.db");

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");

    const [a, b, c] = await Promise.all([
      tursoConnectionManager.getConnection(dbPath),
      tursoConnectionManager.getConnection(dbPath),
      tursoConnectionManager.getConnection(dbPath),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("waits for an in-flight open before closing and serializes a reopen", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-conn-close-race-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    const dbPath = join(baseDir, "close-race.db");

    let releaseOpen!: () => void;
    let markOpenStarted!: () => void;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const openStarted = new Promise<void>((resolve) => {
      markOpenStarted = resolve;
    });
    const clientStates: Array<{ closed: boolean }> = [];
    const clientFactory = (): Client => {
      const clientIndex = clientStates.length;
      const state = { closed: false };
      clientStates.push(state);
      return {
        async execute(statement: { sql: string }) {
          if (clientIndex === 0 && statement.sql === "PRAGMA foreign_keys = ON") {
            markOpenStarted();
            await openGate;
          }
          return {
            columns: statement.sql === "PRAGMA foreign_keys" ? ["foreign_keys"] : [],
            columnTypes: [],
            rows: statement.sql === "PRAGMA foreign_keys" ? [{ foreign_keys: 1 }] : [],
            rowsAffected: 0,
          };
        },
        close() {
          state.closed = true;
        },
      } as unknown as Client;
    };
    const { TursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const manager = new TursoConnectionManager(clientFactory);

    try {
      const opening = manager.getConnection(dbPath);
      await openStarted;

      let closeSettled = false;
      const closing = manager.closeConnection(dbPath).then(() => {
        closeSettled = true;
      });
      const reopening = manager.getConnection(dbPath);

      await Promise.resolve();
      expect(closeSettled).toBeFalse();

      releaseOpen();
      const opened = await opening;
      await closing;
      const reopened = await reopening;

      expect(reopened).not.toBe(opened);
      expect(clientStates).toHaveLength(2);
      expect(clientStates[0]?.closed).toBeTrue();
      const row = await reopened.get(`PRAGMA foreign_keys`);
      expect(Number((row as { foreign_keys?: number } | null)?.foreign_keys)).toBe(1);
    } finally {
      releaseOpen();
      await manager.closeAll();
    }
  });

  it("enables foreign keys on new connections", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-conn-fk-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    const dbPath = join(baseDir, "fk.db");

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const db = await tursoConnectionManager.getConnection(dbPath);
    const row = await db.get(`PRAGMA foreign_keys`);
    expect(Number((row as { foreign_keys?: number } | null)?.foreign_keys)).toBe(1);
  });

  it("refuses paths outside storagePath", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-conn-outside-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    await expect(
      tursoConnectionManager.getConnection(join(tmpdir(), "outside-opencode-mem.db"))
    ).rejects.toThrow(/outside storagePath/);
  });
});
