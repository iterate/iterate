// The per-project CONFIG WORKER source — the "project config worker", the dynamic worker the project
// worker loads into a confined Worker-Loader sandbox. It serves the project's own apps, PUBLIC or PRIVATE:
//   • the DEFAULT app ("") is PUBLIC — anyone, no login.
//   • the "admin" app is PRIVATE — it calls `env.ITX.auth.gate(callerHeader, cpOrigin, url)` (forward-auth):
//     `{ authorized:false, loginUrl }` means "not a member — redirect to login"; `{ authorized:true }`
//     means proceed. This is the userspace face of the control plane's session gateway (design §11a).
// The config worker sees ONLY the ITX binding (the confinement).
export const CONFIG_WORKER_SOURCE = /* js */ `
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const page = (title, body) => new Response(
  '<!doctype html><meta charset=utf-8><title>' + esc(title) + '</title>' +
  '<body style="font:16px system-ui;max-width:40rem;margin:3rem auto">' + body,
  { headers: { "content-type": "text/html; charset=utf-8" } },
);
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const app = request.headers.get("x-iterate-app") ?? "";
    const who = await env.ITX.whoami();

    const isPrivate = app === "admin" || url.pathname.startsWith("/admin");
    if (isPrivate) {
      // FORWARD-AUTH: ask the auth capability whether this caller may proceed. Not authorized => return the
      // login redirect (or a 401). We pass primitives (Request/Response don't cross the RPC loopback).
      const g = await env.ITX.auth.gate(
        request.headers.get("x-iterate-caller"),
        request.headers.get("x-iterate-cp-origin"),
        request.url,
      );
      if (!g.authorized) {
        return g.loginUrl
          ? new Response(null, { status: 302, headers: { location: g.loginUrl } })
          : new Response("unauthorized\\n", { status: 401 });
      }
    }

    if (url.pathname === "/__debug") {
      return Response.json({
        projectId: who.projectId,
        app,
        private: isPrivate,
        caller: JSON.parse(request.headers.get("x-iterate-caller") ?? "null"),
        seenBindings: Object.keys(env).sort(),
      });
    }
    return page(
      who.projectId,
      '<h1>' + esc(who.projectId) + (isPrivate ? ' · admin' : '') + '</h1>' +
      '<p>' + (isPrivate ? 'PRIVATE app — you are an authorized member.' : 'PUBLIC app — anyone can see this.') + '</p>',
    );
  },
};
`;
