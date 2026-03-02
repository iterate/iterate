import { HttpResponse, http, type RequestHandler } from "msw";
import type { HarJournal } from "./har-journal.ts";
import {
  createUpstreamRequestHeaders,
  prepareProxyRequest,
  readRequestBodyBytes,
  resolveHttpTargetUrl,
} from "./proxy-request.ts";
import type { MockMswHttpProxyRequestRewrite } from "./types.ts";

export function createPassthroughRecordHandler(options: {
  harJournal: HarJournal;
  rewriteRequest?: MockMswHttpProxyRequestRewrite;
}): RequestHandler {
  return http.all("*", async ({ request }) => {
    let prepared: ReturnType<typeof prepareProxyRequest>;
    let targetUrl: ReturnType<typeof resolveHttpTargetUrl>;
    try {
      prepared = prepareProxyRequest(request, options.rewriteRequest);
      targetUrl = resolveHttpTargetUrl(prepared);
    } catch (error) {
      return HttpResponse.json(
        {
          error: "rewrite_request_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 400 },
      );
    }

    if (!targetUrl) {
      return HttpResponse.json(
        {
          error: "missing_target",
          message:
            "Unable to resolve target URL. Provide x-iterate-target-url or x-iterate-original-host/proto headers.",
        },
        { status: 400 },
      );
    }

    const requestBody = await readRequestBodyBytes(request);
    const startedAt = Date.now();

    const upstreamResponse = await fetch(targetUrl, {
      method: prepared.method,
      headers: createUpstreamRequestHeaders(prepared.headers),
      body: requestBody ? Buffer.from(requestBody) : undefined,
      redirect: "manual",
    });

    const responseCopy = upstreamResponse.clone();
    const responseBuffer = new Uint8Array(await responseCopy.arrayBuffer());

    options.harJournal.appendHttpExchange({
      startedAt,
      durationMs: Date.now() - startedAt,
      method: prepared.method,
      targetUrl,
      requestHeaders: prepared.headers,
      requestBody,
      response: responseCopy,
      responseBody: responseBuffer,
    });

    return upstreamResponse;
  });
}
