import { http, type RequestHandler } from "msw";
import type { Entry as HarEntry } from "har-format";
import type { HarJournal } from "./har-journal.ts";
import {
  prepareProxyRequest,
  readRequestBodyBytes,
  resolveHttpTargetUrl,
  serializeBodyForHar,
  type PreparedProxyRequest,
} from "./proxy-request.ts";
import type { MockMswHttpProxyRequestRewrite } from "./types.ts";

type FindReplayEntryInput = {
  method: string;
  targetUrl: URL;
  body: Uint8Array | null;
  prepared: PreparedProxyRequest;
  entries: ReadonlyArray<HarEntry>;
};

function entryResponse(entry: HarEntry): Response {
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
}

function findReplayEntry(input: FindReplayEntryInput): HarEntry | undefined {
  const serializedRequestBody = serializeBodyForHar(
    input.body,
    input.prepared.headers["content-type"] ?? "application/octet-stream",
  );

  return input.entries.find((entry) => {
    if (entry.request.method.toUpperCase() !== input.method.toUpperCase()) return false;
    if (entry.request.url !== input.targetUrl.toString()) return false;

    const expectedBodyText = entry.request.postData?.text;
    if (expectedBodyText === undefined) {
      return serializedRequestBody === null;
    }

    return serializedRequestBody?.text === expectedBodyText;
  });
}

export function createHarReplayHandler(options: {
  harJournal: HarJournal;
  rewriteRequest?: MockMswHttpProxyRequestRewrite;
}): RequestHandler {
  const matchedEntries = new WeakMap<Request, HarEntry>();

  return http.all(
    async ({ request }) => {
      let prepared: ReturnType<typeof prepareProxyRequest>;
      let targetUrl: ReturnType<typeof resolveHttpTargetUrl>;
      try {
        prepared = prepareProxyRequest(request, options.rewriteRequest);
        targetUrl = resolveHttpTargetUrl(prepared);
      } catch {
        return false;
      }
      if (!targetUrl) return false;

      const body = await readRequestBodyBytes(request);
      const entry = findReplayEntry({
        method: prepared.method,
        targetUrl,
        body,
        prepared,
        entries: options.harJournal.entries(),
      });
      if (!entry) return false;

      matchedEntries.set(request, entry);
      return true;
    },
    ({ request }) => {
      const entry = matchedEntries.get(request);
      if (!entry) {
        return;
      }

      return entryResponse(entry);
    },
  );
}
