import { describe, expect, it } from "bun:test";
import { escapeHtml } from "../web/src/lib/html.ts";

const MALICIOUS_MEMORY_TYPE = '</span><img src=x onerror="window.__xssFired=true"><span>';

describe("web memoryType XSS helpers", () => {
  it("escapes memoryType HTML event-handler payloads", () => {
    // Given: a stored memory with an HTML event-handler payload in memoryType.
    // The React MemoryCard renders memoryType as text (JSX-escaped); escapeHtml
    // is the shared defense for any HTML string sinks.
    const escaped = escapeHtml(MALICIOUS_MEMORY_TYPE);

    // Then: the payload is displayed as badge text, not parsed as executable HTML.
    expect(escaped).not.toContain("<img src=x");
    expect(escaped).not.toContain('onerror="');
    expect(escaped).toContain("&lt;/span&gt;&lt;img src=x");
  });
});
