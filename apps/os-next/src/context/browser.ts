// browser.ts — apps/os's `itx.browser` (CfBrowserCapabilityRpcTarget + unwrap), as a built-in root.
// Two methods: raw `fetch` for CDP, and `quickAction` which returns the action's RESULT instead of
// the binding's `{ success, result }` Response envelope.

/** A Browser Run quick-action name (`browser.quickAction`'s first argument):
 * what to extract from the rendered page — page content, screenshot, PDF,
 * markdown, accessibility snapshot, scraped elements, structured JSON, links,
 * or a crawl. */
export type CfBrowserQuickAction =
  | "content"
  | "screenshot"
  | "pdf"
  | "markdown"
  | "snapshot"
  | "scrape"
  | "json"
  | "links"
  | "crawl";

/** Options for a Browser Run quick action: the target page as a `url` or as
 * inline `html`, plus the action's own pass-through options (e.g.
 * `screenshotOptions`). */
export type CfBrowserQuickActionOptions = Record<string, unknown> &
  ({ url: string } | { html: string });

/**
 * Unwraps a Browser Run quick-action Response to the caller-facing result:
 * JSON envelopes (`{ success, result }`) yield their `result` (throwing the
 * envelope's error on failure), binary media (screenshot, pdf) yields bytes.
 * Pure so the unwrap contract is unit-testable — the binding itself is an
 * external service local dev cannot dial.
 */
export async function unwrapBrowserRunQuickAction(
  action: string,
  response: Response,
): Promise<string | Uint8Array | unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    // Binary actions (screenshot, pdf) respond with the media itself.
    return new Uint8Array(await response.arrayBuffer());
  }
  const envelope = (await response.json()) as {
    success?: boolean;
    result?: unknown;
    error?: unknown;
  } | null;
  if (envelope && "success" in envelope) {
    if (envelope.success !== true) {
      throw new Error(
        `Browser Run ${action} failed: ${JSON.stringify(envelope.error ?? envelope).slice(0, 500)}`,
      );
    }
    return envelope.result;
  }
  return envelope;
}

/** Cloudflare Browser Run binding exposed through itx. */
export function cfBrowser(binding: BrowserRun) {
  return {
    /** Raw Browser Run fetch, primarily for libraries that connect over CDP. */
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      return binding.fetch(input, init);
    },
    /**
     * Browser Run Quick Actions: content, screenshot, pdf, markdown, snapshot,
     * scrape, json, links, crawl. Returns the action's RESULT directly —
     * `quickAction("markdown", { url })` is the markdown string, structured
     * actions (links, json, scrape, …) are their parsed value, and binary
     * actions (screenshot, pdf) are bytes — instead of the binding's raw
     * Response, whose `{ success, result }` JSON envelope every caller was
     * unwrapping by hand. A failed action throws with the envelope's error.
     */
    async quickAction(
      action: CfBrowserQuickAction,
      options: CfBrowserQuickActionOptions,
    ): Promise<string | Uint8Array | unknown> {
      const response = await (
        binding as BrowserRun & {
          quickAction(action: string, options: Record<string, unknown>): Promise<Response>;
        }
      ).quickAction(action, options);
      return unwrapBrowserRunQuickAction(action, response);
    },
  };
}
