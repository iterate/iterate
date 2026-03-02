import { http, type RequestHandler } from "msw";
import type { Entry as HarEntry } from "har-format";
import type { HarJournal } from "./msw-http-proxy/har-journal.ts";
import { readRequestBodyBytes, serializeBodyForHar } from "./msw-http-proxy/proxy-request.ts";

/**
 * HAR replay handler that matches against request.url directly.
 * Expects URL rewriting to have already occurred (via transformRequest on the server).
 */
export function createSimpleHarReplayHandler(options: { harJournal: HarJournal }): RequestHandler {
  const matchedEntries = new WeakMap<Request, HarEntry>();

  return http.all(
    async ({ request }) => {
      const body = await readRequestBodyBytes(request);
      const contentType = request.headers.get("content-type") ?? "application/octet-stream";
      const serializedBody = serializeBodyForHar(body, contentType);
      const entries = options.harJournal.entries();

      const entry = entries.find((e) => {
        if (e.request.method.toUpperCase() !== request.method.toUpperCase()) return false;
        if (e.request.url !== request.url) return false;

        const expectedBodyText = e.request.postData?.text;
        if (expectedBodyText === undefined) return serializedBody === null;
        return serializedBody?.text === expectedBodyText;
      });

      if (!entry) return false;
      matchedEntries.set(request, entry);
      return true;
    },
    ({ request }) => {
      const entry = matchedEntries.get(request);
      if (!entry) return;

      const headers = new Headers();
      for (const header of entry.response.headers ?? []) {
        headers.set(header.name, header.value);
      }

      const content = entry.response.content;
      let body: BodyInit | null = null;
      if (content?.text !== undefined) {
        body = content.encoding === "base64" ? Buffer.from(content.text, "base64") : content.text;
      }

      return new Response(body, {
        status: entry.response.status,
        statusText: entry.response.statusText,
        headers,
      });
    },
  );
}
