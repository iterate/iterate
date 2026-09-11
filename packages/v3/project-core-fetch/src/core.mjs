/**
 * A deliberately small, portable project core. It relies only on Web
 * Request, Response, ReadableStream, URL, and EventTarget-shaped concepts.
 * Storage and dynamic source evaluation are supplied by the host adapter.
 */

export function normalizeContext(value) {
  const path = value.startsWith("/") ? value : `/${value}`;
  return path.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
}

/**
 * @typedef {{
 *   source: string,
 *   request: Request,
 *   api: { append(event: object): object | undefined, read(after?: number): object[] }
 * }} WorkerEvaluation
 */

export class ProjectCore {
  #streams = new Map();
  /** @type {((input: WorkerEvaluation) => Response | Promise<Response>) | undefined} */
  #evaluateWorkerSource;

  /** @param {{ evaluateWorkerSource?: (input: WorkerEvaluation) => Response | Promise<Response> }} [options] */
  constructor({ evaluateWorkerSource } = {}) {
    this.#evaluateWorkerSource = evaluateWorkerSource;
  }

  append(context, inputs) {
    const path = normalizeContext(context);
    const stream = this.#streams.get(path) ?? { events: [], listeners: new Set() };
    this.#streams.set(path, stream);
    const appended = inputs.map((input) => {
      if (!input || typeof input.type !== "string")
        throw new TypeError("event.type must be a string");
      const event = { ...input, context: path, offset: stream.events.length + 1 };
      stream.events.push(event);
      return event;
    });
    for (const listener of stream.listeners) listener(appended);
    return appended;
  }

  read(context, after = 0) {
    return (this.#streams.get(normalizeContext(context))?.events ?? []).filter(
      (event) => event.offset > after,
    );
  }

  subscribe(context, after, deliver) {
    const path = normalizeContext(context);
    const stream = this.#streams.get(path) ?? { events: [], listeners: new Set() };
    this.#streams.set(path, stream);
    const listener = (events) => deliver(events.filter((event) => event.offset > after));
    stream.listeners.add(listener);
    const prior = stream.events.filter((event) => event.offset > after);
    if (prior.length) deliver(prior);
    return () => stream.listeners.delete(listener);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "contexts" || parts.length < 3)
      return new Response("not found", { status: 404 });
    const context = normalizeContext(decodeURIComponent(parts[1]));
    const operation = parts[2];

    if (operation === "append" && request.method === "POST") {
      const input = await request.json();
      const events = Array.isArray(input) ? input : [input];
      return Response.json(this.append(context, events), { status: 201 });
    }
    if (operation === "read" && request.method === "GET") {
      return Response.json(this.read(context, Number(url.searchParams.get("after") ?? 0)));
    }
    if (operation === "subscribe" && request.method === "GET") {
      return this.#sse(context, Number(url.searchParams.get("after") ?? 0));
    }
    if (operation === "fetch") return this.#dispatch(context, request, parts.slice(3).join("/"));
    return new Response("not found", { status: 404 });
  }

  #sse(context, after) {
    let stop;
    const core = this;
    const body = new ReadableStream({
      start(controller) {
        const send = (events) => {
          for (const event of events)
            controller.enqueue(`id: ${event.offset}\ndata: ${JSON.stringify(event)}\n\n`);
        };
        stop = core.subscribe(context, after, send);
      },
      cancel() {
        stop?.();
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }

  async #dispatch(context, request, suffix) {
    const route = `/${suffix}`;
    const configured = this.read(context).findLast(
      (event) => event.type === "worker/configured" && event.route === route,
    );
    if (!configured) return new Response("no worker configured", { status: 404 });
    if (typeof configured.source !== "string")
      return new Response("invalid worker source", { status: 500 });
    if (!this.#evaluateWorkerSource)
      return new Response("worker source loader is unavailable", { status: 501 });
    const response = await this.#evaluateWorkerSource({
      source: configured.source,
      request,
      api: {
        append: (event) => this.append(context, [event])[0],
        read: (after = 0) => this.read(context, after),
      },
    });
    if (!(response instanceof Response))
      throw new TypeError("configured worker must return a Response");
    return response;
  }
}
