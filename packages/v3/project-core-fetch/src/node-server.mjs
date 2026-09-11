import { createServer } from "node:http";
import { Readable } from "node:stream";

/** Adapts the portable fetch core to Node for the runnable end-to-end proof. */
export function serve(core) {
  const server = createServer(async (incoming, outgoing) => {
    const method = incoming.method ?? "GET";
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
    });
    try {
      const response = await core.fetch(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.flushHeaders();
      if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
      else outgoing.end();
    } catch (error) {
      outgoing.writeHead(500, { "content-type": "text/plain" });
      outgoing.end(error instanceof Error ? error.message : "unknown error");
    }
  });
  return server;
}
