// kimi-mem 对 opencode-mem HTTP API 的薄封装
import { apiBase, readApiToken } from "./common.mjs";

async function req(method, path, body) {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-opencode-mem-token": readApiToken(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  return json.data ?? json;
}

function unwrapList(data) {
  if (Array.isArray(data)) return data;
  return data?.results ?? data?.items ?? data?.memories ?? [];
}

export const api = {
  search: (q, { tag, pageSize = 10 } = {}) =>
    req(
      "GET",
      `/api/search?q=${encodeURIComponent(q)}&pageSize=${pageSize}` +
        (tag ? `&tag=${encodeURIComponent(tag)}` : "")
    ).then(unwrapList),

  list: ({ tag, pageSize = 20 } = {}) =>
    req(
      "GET",
      `/api/memories?pageSize=${pageSize}&includePrompts=false` +
        (tag ? `&tag=${encodeURIComponent(tag)}` : "")
    ).then(unwrapList),

  add: ({ content, containerTag, type, tags, projectPath, projectName }) =>
    req("POST", "/api/memories", {
      content,
      containerTag,
      type,
      tags,
      projectPath,
      projectName,
    }),

  remove: (id) =>
    req("DELETE", `/api/memories/${encodeURIComponent(id)}?cascade=true`),

  profile: () => req("GET", "/api/user-profile"),

  stats: () => req("GET", "/api/stats"),
};
