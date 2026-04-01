import { StreamPath, type EventInput } from "@iterate-com/events-contract";
import { StreamDurableObject } from "~/durable-objects/stream.ts";

export default {
  async fetch(request: Request, env: Pick<Env, "STREAM">) {
    const url = new URL(request.url);

    if (url.pathname === "/ping") {
      return new Response("ok");
    }

    if (url.pathname === "/append" && request.method === "POST") {
      const body = (await request.json()) as { path: string; events: EventInput[] };
      const stream = env.STREAM.getByName(StreamPath.parse(body.path));
      const appended = await stream.append({ events: body.events });
      return Response.json(appended);
    }

    if (url.pathname === "/history" && request.method === "GET") {
      const stream = env.STREAM.getByName(StreamPath.parse(url.searchParams.get("path")));
      const afterOffset = parseOptionalOffset(url.searchParams.get("afterOffset"));
      return Response.json(await stream.history({ afterOffset }));
    }

    if (url.pathname === "/state" && request.method === "GET") {
      const stream = env.STREAM.getByName(StreamPath.parse(url.searchParams.get("path")));
      return Response.json(await stream.getState());
    }

    if (url.pathname === "/stream" && request.method === "GET") {
      const stream = env.STREAM.getByName(StreamPath.parse(url.searchParams.get("path")));
      const afterOffset = parseOptionalOffset(url.searchParams.get("afterOffset"));
      const live = url.searchParams.get("live") === "true";
      const eventStream = await stream.stream({ afterOffset, live });

      return new Response(eventStream, {
        headers: {
          "content-type": "application/x-ndjson",
        },
      });
    }

    return new Response("not_found", { status: 404 });
  },
};

export { StreamDurableObject };

function parseOptionalOffset(value: string | null) {
  if (value == null || value === "") {
    return undefined;
  }

  return Number.parseInt(value, 10);
}
