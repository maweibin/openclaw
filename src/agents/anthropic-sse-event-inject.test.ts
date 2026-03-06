import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  __testingResetInstall,
  isCustomAnthropicBaseUrl,
  runWithAnthropicSSEEventInject,
} from "./anthropic-sse-event-inject.js";

describe("isCustomAnthropicBaseUrl", () => {
  it("returns false for undefined or empty", () => {
    expect(isCustomAnthropicBaseUrl(undefined)).toBe(false);
    expect(isCustomAnthropicBaseUrl("")).toBe(false);
  });

  it("returns false for official Anthropic base", () => {
    expect(isCustomAnthropicBaseUrl("https://api.anthropic.com")).toBe(false);
    expect(isCustomAnthropicBaseUrl("https://api.anthropic.com/")).toBe(false);
    expect(isCustomAnthropicBaseUrl("https://api.anthropic.com/v1")).toBe(false);
  });

  it("returns true for custom/proxy base URLs", () => {
    expect(isCustomAnthropicBaseUrl("https://proxy.example.com")).toBe(true);
    expect(isCustomAnthropicBaseUrl("https://proxy.example.com/")).toBe(true);
    expect(isCustomAnthropicBaseUrl("http://localhost:8080")).toBe(true);
  });

  it("returns true for hostnames that only share the official prefix (boundary check)", () => {
    expect(isCustomAnthropicBaseUrl("https://api.anthropic.com.evil.com")).toBe(true);
    expect(isCustomAnthropicBaseUrl("https://api.anthropic.comx")).toBe(true);
  });
});

describe("runWithAnthropicSSEEventInject", () => {
  const baseUrl = "https://proxy.example.com";
  const encoder = new TextEncoder();
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __testingResetInstall();
  });

  it("injects event lines before data lines when proxy omits them", async () => {
    const sseWithoutEvents =
      'data: {"type":"message_start"}\n\n' +
      'data: {"type":"content_block_start"}\n\n' +
      'data: {"type":"ping"}\n\n';
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(sseWithoutEvents));
            c.close();
          },
        }),
      );

    const result = await runWithAnthropicSSEEventInject(baseUrl, async () => {
      const res = await fetch(`${baseUrl}/v1/messages`);
      return await new Response(res.body).text();
    });

    expect(result).toContain("event: message_start\n");
    expect(result).toContain("event: content_block_start\n");
    expect(result).toContain("event: ping\n");
    expect(result).toContain('data: {"type":"message_start"}');
  });

  it("does not duplicate event lines when proxy already sends them", async () => {
    const sseWithEvents = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(sseWithEvents));
            c.close();
          },
        }),
      );

    const result = await runWithAnthropicSSEEventInject(baseUrl, async () => {
      const res = await fetch(`${baseUrl}/v1/messages`);
      return await new Response(res.body).text();
    });

    // Should still have exactly one "event: message_start"
    const eventCount = (result.match(/event: message_start/g) ?? []).length;
    expect(eventCount).toBe(1);
  });
});
