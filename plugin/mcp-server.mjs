// kimi-mem MCP server：把 opencode-mem 的记忆能力暴露为 MCP 工具
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureDaemon, getProjectTag, loadVendorMemory } from "./lib/common.mjs";
import { api } from "./lib/api.mjs";

const server = new McpServer({
  name: "kimi-mem",
  version: "0.1.0",
});

const scopeParam = z
  .enum(["project", "all-projects"])
  .optional()
  .describe("查询范围：project=仅当前项目（默认），all-projects=跨所有项目");

async function resolveTag(scope, projectPath) {
  if (scope === "all-projects") return undefined;
  return getProjectTag(projectPath ?? process.cwd());
}

server.tool(
  "memory_search",
  "语义搜索长期记忆（项目决策、bug 修复、技术细节）。工作开始前可主动搜一下相关上下文。",
  {
    query: z.string().describe("搜索关键词或自然语言问题"),
    scope: scopeParam,
    projectPath: z.string().optional().describe("项目路径，默认取当前工作目录"),
    limit: z.number().optional().default(10),
  },
  async ({ query, scope, projectPath, limit }) => {
    await ensureDaemon();
    const tag = await resolveTag(scope, projectPath);
    const results = await api.search(query, { tag, pageSize: limit });
    if (results.length === 0) return { content: [{ type: "text", text: "没有匹配的记忆。" }] };
    const text = results
      .map((m, i) => {
        const sim = m.similarity ?? m.score;
        const score = typeof sim === "number" ? ` score=${sim.toFixed(3)}` : "";
        return `${i + 1}. [${m.type ?? "memory"}${score}] (id: ${m.id})\n${m.content}`;
      })
      .join("\n\n");
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "memory_add",
  "立即保存一条长期记忆（重要决策、bug 根因、用户偏好等）。日常对话产生的记忆会自动捕获，无需手动调。",
  {
    content: z.string().describe("要记住的内容，写具体（含文件名/函数名/原因）"),
    type: z
      .string()
      .optional()
      .describe("fact / decision / problem-solution / gotcha / preference"),
    tags: z.array(z.string()).optional().describe("2-4 个英文技术标签"),
    projectPath: z.string().optional().describe("项目路径，默认取当前工作目录"),
  },
  async ({ content, type, tags, projectPath }) => {
    await ensureDaemon();
    const cwd = projectPath ?? process.cwd();
    // 隐私过滤：vendor 用 depth-counter 算法，<private>...</private> 区域替换为 [REDACTED]
    // 完全私有（剥离后为空）则拒绝写入，避免只存下 [REDACTED] 占位
    const { stripPrivateContent, isFullyPrivate } = await loadVendorMemory(cwd);
    if (isFullyPrivate(content)) {
      return {
        content: [
          { type: "text", text: "内容全部为私有标记，未写入。" },
        ],
        isError: true,
      };
    }
    const sanitizedContent = stripPrivateContent(content);
    const result = await api.add({
      content: sanitizedContent,
      containerTag: await getProjectTag(cwd),
      type: type ?? "fact",
      tags,
      projectPath: cwd,
    });
    return {
      content: [{ type: "text", text: `记忆已保存 (id: ${result.id ?? "?"})` }],
    };
  }
);

server.tool(
  "memory_list",
  "列出最近保存的记忆",
  {
    scope: scopeParam,
    projectPath: z.string().optional(),
    limit: z.number().optional().default(20),
  },
  async ({ scope, projectPath, limit }) => {
    await ensureDaemon();
    const tag = await resolveTag(scope, projectPath);
    const results = await api.list({ tag, pageSize: limit });
    if (results.length === 0) return { content: [{ type: "text", text: "暂无记忆。" }] };
    const text = results
      .map((m, i) => `${i + 1}. [${m.type ?? "memory"}] (id: ${m.id}) ${m.content}`)
      .join("\n");
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "memory_forget",
  "删除一条记忆（按 id）",
  { id: z.string().describe("记忆 id，可通过 memory_list / memory_search 获得") },
  async ({ id }) => {
    await ensureDaemon();
    await api.remove(id);
    return { content: [{ type: "text", text: `已删除 ${id}` }] };
  }
);

server.tool(
  "memory_profile",
  "查看跨项目的用户工作偏好画像",
  {},
  async () => {
    await ensureDaemon();
    const profile = await api.profile();
    return {
      content: [{ type: "text", text: JSON.stringify(profile, null, 2) }],
    };
  }
);

// 以下 4 个工具对齐上游 memory tool 的 migrate / list-shards / export / import 4 个 mode
// 这些能力没有 HTTP API 入口，必须在 MCP server 进程内直连 vendor dist 调用

server.tool(
  "memory_export",
  "导出当前项目记忆为可移植 JSON 文件",
  {
    outputPath: z.string().describe("导出文件路径，如 D:/backup/memories.json"),
    projectPath: z.string().optional().describe("项目路径，默认取当前工作目录"),
  },
  async ({ outputPath, projectPath }) => {
    const cwd = projectPath ?? process.cwd();
    const { memoryClient } = await loadVendorMemory(cwd);
    const res = await memoryClient.exportMemories(cwd, outputPath);
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
    };
  }
);

server.tool(
  "memory_import",
  "从 JSON 文件导入记忆到当前项目（默认会重新计算 embedding；存在相同 id 则中止）",
  {
    inputPath: z.string().describe("要导入的 JSON 文件路径"),
    dryRun: z.boolean().optional().describe("仅预览，不实际写入"),
    projectPath: z.string().optional().describe("项目路径，默认取当前工作目录"),
  },
  async ({ inputPath, dryRun, projectPath }) => {
    const cwd = projectPath ?? process.cwd();
    const { memoryClient } = await loadVendorMemory(cwd);
    const res = await memoryClient.importMemories(cwd, inputPath, dryRun);
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
    };
  }
);

server.tool(
  "memory_list_shards",
  "列出所有项目 shard（含孤儿 path 关联），用于发现项目迁移后的孤儿记忆",
  {
    projectPath: z.string().optional().describe("项目路径，默认取当前工作目录"),
  },
  async ({ projectPath }) => {
    const cwd = projectPath ?? process.cwd();
    const { memoryClient } = await loadVendorMemory(cwd);
    const res = await memoryClient.listShards(cwd);
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
    };
  }
);

server.tool(
  "memory_migrate",
  "项目目录迁移后，把孤儿 shard 重新绑定到当前 cwd（先用 list_shards 查 fromPath/fromHash）",
  {
    fromPath: z.string().optional().describe("原项目路径"),
    fromHash: z.string().optional().describe("原项目 hash"),
    dryRun: z.boolean().optional().describe("仅预览，不实际迁移"),
    allowLinkedSource: z
      .boolean()
      .optional()
      .describe("允许从已绑定的源 shard 迁移（默认拒绝）"),
    projectPath: z.string().optional().describe("目标项目路径，默认取当前工作目录"),
  },
  async ({ fromPath, fromHash, dryRun, allowLinkedSource, projectPath }) => {
    if (!fromPath && !fromHash) {
      return {
        content: [
          {
            type: "text",
            text: "fromPath 或 fromHash 至少需要一个；先用 memory_list_shards 查孤儿 shard。",
          },
        ],
        isError: true,
      };
    }
    const cwd = projectPath ?? process.cwd();
    const { memoryClient } = await loadVendorMemory(cwd);
    const res = await memoryClient.migrateProjectPath({
      currentDirectory: cwd,
      fromPath,
      fromHash,
      dryRun,
      allowLinkedSource,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
    };
  }
);

await server.connect(new StdioServerTransport());
