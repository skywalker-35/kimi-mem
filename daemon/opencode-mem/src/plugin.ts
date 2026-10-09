import type { PluginModule } from "@opencode-ai/plugin";
import type { Plugin as V2Plugin } from "@opencode/plugin/promise/plugin";
import pkg from "../package.json" with { type: "json" };
const { OpenCodeMemPlugin } = await import("./index.js");
const { default: OpenCodeMemPluginV2 } = await import("./v2/plugin.js");

export const id =
  typeof pkg.name === "string" && pkg.name.trim() ? pkg.name.trim() : "opencode-mem";
export { OpenCodeMemPlugin };
export default {
  ...OpenCodeMemPluginV2,
  id,
  server: OpenCodeMemPlugin,
} satisfies PluginModule & V2Plugin;
