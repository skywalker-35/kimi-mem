import type { MemoryGroup, MemoryItem } from "./types";

export function groupMemories(items: MemoryItem[]): MemoryGroup[] {
  const map = new Map(items.map((item) => [item.id, item]));
  const pairs: MemoryGroup[] = [];
  const processed = new Set<string>();

  for (const item of items) {
    if (processed.has(item.id)) continue;

    if (item.type === "memory" && item.linkedPromptId && map.has(item.linkedPromptId)) {
      const prompt = map.get(item.linkedPromptId)!;
      pairs.push({ isPair: true, memory: item, prompt });
      processed.add(item.id);
      processed.add(prompt.id);
    } else if (item.type === "prompt" && item.linkedMemoryId && map.has(item.linkedMemoryId)) {
      const memory = map.get(item.linkedMemoryId)!;
      pairs.push({ isPair: true, memory, prompt: item });
      processed.add(item.id);
      processed.add(memory.id);
    } else {
      pairs.push({ isPair: false, type: item.type, item });
      processed.add(item.id);
    }
  }

  return pairs.sort((a, b) => {
    const timeA = a.isPair ? a.memory.createdAt : a.item.createdAt;
    const timeB = b.isPair ? b.memory.createdAt : b.item.createdAt;
    return new Date(timeB).getTime() - new Date(timeA).getTime();
  });
}
