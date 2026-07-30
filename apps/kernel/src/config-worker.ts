// The per-project config worker the kernel loads into a confined dynamic worker.
// `{ fetch, processEvent }` — mirrors apps/os's config-repo-template/worker.ts, minus the
// npm imports (the minimal kernel has no bundler yet, so the source is a self-contained module).
//
// It serves the project's OWN apps — userspace, mutable, breakable, and contained: a bad config worker
// takes down only this project's own pages. It does NOT serve the dashboard: the dashboard is the
// CONTROL PLANE (how you manage/recover a project), so the kernel serves it directly and never runs
// this worker for it (see kernel.ts `DASHBOARD_APP`). That's why a broken config worker can never lock
// you out of the tool you'd fix it with. The default host `<slug>` is this public site; other named
// apps `<app>--<slug>` route on the stamped `x-iterate-app`.
export const CONFIG_WORKER_SOURCE = /* js */ `
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const page = (title, body) =>
  new Response(
    '<!doctype html><meta charset=utf-8><title>' + esc(title) + '</title>' +
    '<body style="font:16px system-ui;max-width:40rem;margin:3rem auto">' + body,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
const whoLabel = (caller) =>
  caller && caller.credentials && caller.credentials.length
    ? caller.credentials.map((c) => c.issuer + " (" + c.format + ")").join(", ")
    : "anonymous";

// PUBLIC app (the default host \`<slug>.<base>\`): the project website. No login — Access does not
// cover this hostname. Links to the dashboard, which the KERNEL serves at the sibling host
// \`dashboard--<slug>\` (control plane — not this worker).
const publicSite = (projectId, caller, host) =>
  page(projectId, '<h1>' + esc(projectId) + '</h1>' +
    '<p>This is the project <b>public website</b> — anyone can see it, no login required. ' +
    'The <a href="https://dashboard--' + esc(host) + '/">dashboard</a> (a separate hostname) is the ' +
    'kernel-served control plane.</p>' +
    '<p><small>you are: ' + esc(whoLabel(caller)) + '</small></p>');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const caller = JSON.parse(request.headers.get("x-iterate-caller") ?? "null");
    const app = request.headers.get("x-iterate-app") ?? ""; // the kernel resolved <app>--<slug>
    const who = await env.ITX.whoami();

    // Debug (used by the e2e test): prove confinement + identity from inside the sandbox. The config
    // worker sees ONLY the ITX binding — no raw kernel bindings, no vessel origin (the kernel owns the
    // dashboard now). That single-binding surface IS the confinement.
    if (url.pathname === "/__debug") {
      return Response.json({
        projectId: who.projectId,
        app,
        caller,
        seenBindings: Object.keys(env).sort(),
      });
    }

    // Egress + secret-substitution proof (used by the e2e/live test). Userspace only ever writes
    // PLACEHOLDERS; the egress door(s) substitute. We set one project secret, then fetch an external
    // echo with three placeholders and return what the target RECEIVED — proving: platform secret
    // substituted (origin-pinned), project secret substituted, and an unknown/unpinned token left intact.
    if (url.pathname === "/__egress") {
      const target = url.searchParams.get("target") || "https://httpbin.org/headers";
      await env.ITX.setSecret("myproj", "PROJ-SECRET-123"); // write-only; we never read it back
      const res = await fetch(target, {
        headers: {
          "x-platform": "Bearer {{secret:platform:echo}}", // substituted at the CONTROL-PLANE door
          "x-project": "{{secret:project:myproj}}", // substituted at the PROJECT door
          "x-unresolved": "{{secret:platform:nope}}", // unknown platform secret => left intact
        },
      });
      return new Response(await res.text(), {
        status: res.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    // Durable-log proof (used by the e2e/live test). Append events then read them back — proving a real
    // per-project durable stream through the confined ITX binding (the processEvent stub is now real
    // storage underneath). ?append=TYPE appends; otherwise reads the whole log.
    if (url.pathname === "/__stream") {
      const path = url.searchParams.get("path") || "main";
      const append = url.searchParams.get("append");
      const idem = url.searchParams.get("idem"); // optional idempotency key (proves dedup)
      try {
        if (append) {
          const ev = await env.ITX.streamAppend(path, {
            type: append,
            payload: { at: Date.now() },
            ...(idem ? { idempotencyKey: idem } : {}),
          });
          return Response.json({ appended: append, offset: ev.offset });
        }
        const events = await env.ITX.streamRead(path, 0);
        return Response.json({ path, count: events.length, events });
      } catch (e) {
        return Response.json({ error: String(e && e.message ? e.message : e) }, { status: 500 });
      }
    }

    // AI capability proof — per-capability sourcing (ADR M3). The SAME userspace call resolves to a
    // local Workers AI binding or a metered remote endpoint, by deployment config; userspace can't tell.
    if (url.pathname === "/__ai") {
      const prompt = url.searchParams.get("prompt") || "say hello in one word";
      try {
        const out = await env.ITX.aiRun(prompt);
        return Response.json({ prompt, out });
      } catch (e) {
        return Response.json({ error: String(e && e.message ? e.message : e) }, { status: 500 });
      }
    }

    // Every app this worker serves is the project's OWN (default public site + any named apps it adds).
    // The dashboard never reaches here — the kernel reserved it.
    return publicSite(who.projectId, caller, url.host);
  },

  // Events in — the other half of {fetch, processEvent}. review #10: the durable log (append/follow)
  // is a whole point-of-contact this cut doesn't build yet; a real config worker folds committed
  // stream events here (agents, connectors). Stub for now, said honestly.
  async processEvent(event) {
    // stub (review #10)
  },
};
`;
