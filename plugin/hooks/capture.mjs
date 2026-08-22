// Stop / SessionEnd hook：把捕获请求 POST 给 daemon sidecar，立即退出
// 捕获逻辑在 daemon 进程内异步执行，不 spawn 任何子进程（避免终端退出时弹控制台窗口）
import { loadConfig, readStdinJson, ensureDaemon, readApiToken, logDebug } from "../lib/common.mjs";

async function main() {
  const cfg = loadConfig();
  if (!cfg.capture.enabled) return;

  const payload = await readStdinJson();
  if (!payload.session_id || !payload.cwd) return;

  if (!(await ensureDaemon())) return;

  await fetch(`http://127.0.0.1:${cfg.port + 1}/capture`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-mem-token": readApiToken(),
    },
    body: JSON.stringify({
      session_id: payload.session_id,
      cwd: payload.cwd,
      event: payload.hook_event_name,
    }),
    signal: AbortSignal.timeout(3000),
  });
}

main().catch((err) => {
  logDebug(`capture hook error: ${err?.stack ?? err}`);
  process.exit(0);
});
