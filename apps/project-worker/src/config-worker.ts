// The per-project CONFIG WORKER source — the "project config worker", the dynamic worker the project
// worker loads into a confined Worker-Loader sandbox. It serves the project's own apps. It sees ONLY the
// ITX binding (the confinement) — no raw bindings, no secrets. This is a minimal but real version
// (whoami via ITX + echo of the stamped caller/app); the kernel's fuller config worker (egress, secrets,
// streams) is already proven there and folds in later.
export const CONFIG_WORKER_SOURCE = /* js */ `
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const caller = JSON.parse(request.headers.get("x-iterate-caller") ?? "null");
    const app = request.headers.get("x-iterate-app") ?? "";
    const who = await env.ITX.whoami(); // the ONE capability surface — proves confinement + identity

    if (url.pathname === "/__debug") {
      return Response.json({ projectId: who.projectId, app, caller, seenBindings: Object.keys(env).sort() });
    }
    return new Response(
      '<!doctype html><meta charset=utf-8><title>' + esc(who.projectId) + '</title>' +
      '<body style="font:16px system-ui;max-width:40rem;margin:3rem auto">' +
      '<h1>' + esc(who.projectId) + '</h1>' +
      '<p>Served by the <b>project config worker</b>, loaded by the project worker, ' +
      'for the project the control plane resolved. app=<b>' + esc(app || "(default)") + '</b>.</p>' +
      '<p><small>caller: ' + esc(JSON.stringify(caller)) + '</small></p>',
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
};
`;
