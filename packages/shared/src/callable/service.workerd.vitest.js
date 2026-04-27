import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * Auxiliary Worker used by the callable tests.
 *
 * The Workers Vitest pool requires auxiliary Workers to be plain JavaScript
 * files, not TypeScript. Keeping this as a real WorkerEntrypoint matters: it
 * proves the callable runtime can use the same service binding for both
 * `env.SERVICE.fetch(request)` and native Workers RPC methods.
 */
export default class CallableTestService extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/redirect") {
      return Response.redirect("https://public.example.com/leak", 302);
    }

    const body = request.body ? await request.text() : "";
    return Response.json({
      target: "service",
      method: request.method,
      path: url.pathname,
      query: url.search,
      body,
      contentType: request.headers.get("content-type"),
    });
  }

  echo(input) {
    return { target: "service", input };
  }

  join(left, right) {
    return `${left}:${right}`;
  }

  text() {
    return new Response("service text response", {
      headers: { "content-type": "text/plain" },
    });
  }

  fail() {
    return new Response("service failure body", { status: 418 });
  }
}
