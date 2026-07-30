import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

// The OS dashboard vessel: a plain TanStack Start worker. It holds no credentials — every
// useful request reaches it already proxied through an iterate project's config worker, which
// stamps `x-iterate-project-host` + `x-iterate-caller` and forwards the caller's authorization.
export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health")
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    return handler.fetch(request); // SSR routes + client assets
  },
});
