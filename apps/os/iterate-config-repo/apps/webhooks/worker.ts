type ProjectWorkerEnv = {
  STREAMS: {
    append(input: { event: unknown; streamPath: string }): Promise<unknown>;
  };
};

export default {
  async fetch(request: Request, env: ProjectWorkerEnv) {
    if (request.headers.get("x-iterate-app-slug") !== "webhooks") return;
    const url = new URL(request.url);

    await env.STREAMS.append({
      streamPath: url.pathname === "/" ? "/webhooks" : `/webhooks${url.pathname}`,
      event: {
        type: "unknown-webhook-received",
        payload: {
          url: url.toString(),
          method: request.method,
          headers: Object.fromEntries(request.headers.entries()),
          body: await request.json(),
        },
      },
    });

    return Response.json({ ok: true });
  },
};
