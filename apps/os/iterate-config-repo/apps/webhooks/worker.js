export default {
  async fetch(request, env) {
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
