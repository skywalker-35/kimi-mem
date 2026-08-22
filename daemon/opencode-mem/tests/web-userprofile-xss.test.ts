import { describe, expect, it } from "bun:test";
import { escapeHtml } from "../web/src/lib/html.ts";

const MALICIOUS_DISPLAY_NAME = '<img src=x onerror="window.__xssFired=true">';

describe("web user-profile XSS helpers", () => {
  it("escapes displayName HTML event-handler payloads", () => {
    // Given: a stored user profile whose displayName came from an untrusted
    // per-project userNameOverride and contains an HTML event-handler payload.
    // The React ProfileView renders displayName as text (JSX-escaped); escapeHtml
    // is the shared defense for any HTML string sinks.
    const escaped = escapeHtml(MALICIOUS_DISPLAY_NAME);

    // Then: the payload is displayed as text, not parsed as executable HTML.
    expect(escaped).not.toContain("<img src=x");
    expect(escaped).not.toContain('onerror="');
    expect(escaped).toContain("&lt;img src=x");
  });
});
