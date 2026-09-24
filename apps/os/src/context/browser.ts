// browser.ts — the `itx.browser` built-in root.
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
     * Response and its `{ success, result }` JSON envelope. A failed action
     * throws with the envelope's error — after ONE retry, a second later, when
     * the failure is Browser Run's own timeout on inline HTML (logged as
     * `browser.platform-failure-retry`; scripts/ci/prd-fault-alarm.ts pages on
     * a burst). A quick action only reads the page, so running it twice is safe.
     */
    async quickAction(
      action: CfBrowserQuickAction,
      options: CfBrowserQuickActionOptions,
    ): Promise<string | Uint8Array | unknown> {
      const attempt = async () =>
        unwrapBrowserRunQuickAction(
          action,
          await (
            binding as BrowserRun & {
              quickAction(action: string, options: Record<string, unknown>): Promise<Response>;
            }
          ).quickAction(action, options),
        );
      try {
        return await attempt();
      } catch (error) {
        const message = String((error as { message?: unknown })?.message ?? error);
        // Browser Run's own timeout (`{"code":6002,"message":"A timeout was reached. …"}`) on INLINE
        // HTML: nothing remote to wait for, so the timeout is the service's, never the page's. A `url`
        // page's timeout may be that site's and is not retried.
        if (!("html" in options && /"code":6002\b/.test(message))) throw error;
        console.warn({
          event: "browser.platform-failure-retry",
          namespace: "iterate-context",
          action,
          message,
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return await attempt();
      }
    },
  };
}
