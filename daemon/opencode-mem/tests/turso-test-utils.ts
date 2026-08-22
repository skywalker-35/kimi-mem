import { rmSync } from "node:fs";

export async function cleanupTursoTestDirectory(baseDir?: string): Promise<void> {
  const [{ closeTursoAndInvalidateCaches }, { withSqliteFileLockRetry }] = await Promise.all([
    import("../src/services/turso/lifecycle.js"),
    import("../src/services/turso/sqlite-handle-release.js"),
  ]);

  await closeTursoAndInvalidateCaches();
  if (baseDir) {
    await withSqliteFileLockRetry(() => rmSync(baseDir, { recursive: true, force: true }));
  }
}
