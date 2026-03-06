/**
 * Injects missing SSE "event:" lines for anthropic-messages proxies that only send
 * "data:" lines (fixes #37571). The @anthropic-ai/sdk parser requires "event:" to
 * dispatch; when missing, events are dropped and the stream fails with
 * "request ended without sending any chunks".
 *
 * Impact: only active when using anthropic-messages with a custom baseUrl (proxy).
 * Uses AsyncLocalStorage so only requests to that baseUrl are transformed.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const ANTHROPIC_OFFICIAL_BASE = "https://api.anthropic.com";

const anthropicProxyBaseUrlStorage = new AsyncLocalStorage<{ anthropicProxyBaseUrl: string }>();

let fetchWrapperInstalled = false;

/** Reset install state for tests so the wrapper can be re-installed with a new realFetch. */
export function __testingResetInstall(): void {
  fetchWrapperInstalled = false;
}

/**
 * Returns true when the model uses a custom/proxy base URL (not official Anthropic).
 * For those, we may need to inject "event:" lines if the proxy omits them.
 */
export function isCustomAnthropicBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl || typeof baseUrl !== "string") {
    return false;
  }
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    return false;
  }
  return (
    !normalized.startsWith(ANTHROPIC_OFFICIAL_BASE) &&
    !normalized.startsWith("https://api.anthropic.com/")
  );
}

/**
 * Run fn inside an async context that marks requests to baseUrl as needing
 * SSE event injection. Used when calling streamSimple for anthropic-messages
 * with a custom baseUrl so the SDK's fetch sees the context.
 */
export function runWithAnthropicSSEEventInject<T>(baseUrl: string, fn: () => T): T {
  ensureFetchWrapperInstalled();
  return anthropicProxyBaseUrlStorage.run(
    { anthropicProxyBaseUrl: baseUrl.trim().replace(/\/+$/, "") },
    fn,
  );
}

function ensureFetchWrapperInstalled(): void {
  if (fetchWrapperInstalled) {
    return;
  }
  fetchWrapperInstalled = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const store = anthropicProxyBaseUrlStorage.getStore();
    if (!store?.anthropicProxyBaseUrl) {
      return realFetch(input, init);
    }
    const res = await realFetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(store.anthropicProxyBaseUrl) || !res.body) {
      return res;
    }
    const transformedBody = res.body.pipeThrough(createSSEEventInjectTransform());
    return new Response(transformedBody, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

/**
 * TransformStream that, for each SSE "data:" line that contains JSON with a "type"
 * field, prepends "event: <type>\n" when the previous line was not already "event:".
 * This makes proxies that omit "event:" lines compatible with the SDK parser.
 */
function createSSEEventInjectTransform(): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  let buffer = "";
  let lastLineWasEvent = false;

  function flushLine(line: string): string {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed) {
      lastLineWasEvent = false;
      return line;
    }
    if (trimmed.startsWith("event:")) {
      lastLineWasEvent = true;
      return line;
    }
    if (trimmed.startsWith("data:")) {
      const value = trimmed.slice(5).replace(/^\s+/, "");
      let out = line;
      if (!lastLineWasEvent && value) {
        try {
          const parsed = JSON.parse(value) as { type?: string };
          if (typeof parsed?.type === "string" && parsed.type.trim()) {
            out = `event: ${parsed.type.trim()}\n${line}`;
          }
        } catch {
          // not JSON or no type; leave as-is
        }
      }
      lastLineWasEvent = false;
      return out;
    }
    lastLineWasEvent = false;
    return line;
  }

  return new TransformStream({
    transform(chunk, controller) {
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split(/\r\n|\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const flushed = flushLine(line + "\n");
        controller.enqueue(encoder.encode(flushed));
      }
    },
    flush(controller) {
      if (buffer) {
        controller.enqueue(encoder.encode(buffer));
      }
    },
  });
}
