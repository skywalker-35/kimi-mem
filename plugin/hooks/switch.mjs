// TurnStarted hook：/kimi-mem:inject 插件命令的开关状态写入口
// 背景：插件斜杠命令（wire 里 origin.kind=plugin_command）不触发 UserPromptSubmit，
// inject.mjs 的拦截够不到；TurnStarted 对每个 turn 都触发且 payload 带 prompt，由它
// 把开关状态持久化到 ~/.kimi-mem/inject-switch.json（inject.mjs 注入前检查该文件）。
// TurnStarted 是观察型事件，返回值不影响主流程；本轮模型仍会收到命令 body（作为确认文案）。
import { readStdinJson, loadSwitch, saveSwitch, matchSwitchCommand, writeSwitchStatus, logDebug } from "../lib/common.mjs";

async function main() {
  const payload = await readStdinJson();
  // prompt 兼容 content parts 数组与字符串两种形态（同 inject.mjs）
  const rawPrompt = payload.prompt ?? "";
  const prompt = Array.isArray(rawPrompt)
    ? rawPrompt
        .filter((p) => p?.type === "text")
        .map((p) => p.text)
        .join("\n")
    : String(rawPrompt);

  const action = matchSwitchCommand(prompt);
  if (!action) return;

  const sessionId = payload.session_id;
  logDebug(
    `switch hook: session=${sessionId} action=${action} origin=${payload.origin_kind ?? "?"}`
  );
  if (!sessionId) return;
  if (action !== "status") {
    const state = loadSwitch();
    state[sessionId] = { disabled: action === "off", t: Date.now() };
    saveSwitch(state);
    logDebug(`switch hook: 已写入 session=${sessionId} disabled=${action === "off"}`);
  }
  // 所有动作都生成确认文案（含 status），命令 body 让模型原样转述
  writeSwitchStatus(sessionId, action);
}

main().catch((err) => {
  logDebug(`switch error: ${err?.stack ?? err}`);
  process.exit(0);
});
