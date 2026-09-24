import { createServer } from "node:http";
import { listenOnFetchSafePort } from "@iterate-com/shared/test-support/fetch-safe-port";

/**
 * A local HTTP sink for the shop's webhook deliveries: each POST to its URL, with the body and the
 * `signatureHeader` it carried, in arrival order.
 *
 * `listen(0)` gets whichever loopback port the OS hands out, and another process may still be dialing
 * that port for the server that had it before (a reconnect loop, a retry). Recorded, such a request
 * reads as the delivery with an empty body: `SyntaxError: Unexpected end of JSON input`, as in one
 * loaded `pnpm test` run on 2026-09-24. So the URL's path is random, only a POST to it is a delivery,
 * and anything else gets a 404 and is not recorded.
 */
export async function startReceiver(signatureHeader: string) {
  const path = `/hook/${crypto.randomUUID()}`;
  const received: { body: string; signature: string | null }[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== path) {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({ body, signature: request.headers[signatureHeader]?.toString() ?? null });
      response.writeHead(200).end("ok");
    });
  });
  const port = await listenOnFetchSafePort(server);
  return {
    url: `http://127.0.0.1:${port}${path}`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
