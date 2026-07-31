import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";

// Findings referenced as `review #N`: ../../../../os/docs/simplification/kernel-review-2026-07-28.md
// review #26: the published caller (secret-stripped). No index signature => serializable for SSR.
type Caller = { credentials: { format: string; issuer: string }[] };

// Runs SERVER-SIDE during SSR. The config worker (the project's front door) already authenticated the
// caller and STAMPED the non-secret context onto the proxied request, so SSR just reads it. review #3:
// the vessel never receives the user's auth.iterate.com token — instead the front door minted a NARROW
// `project-app-session` (scoped to THIS project, 15 min) and stamped it. The app calls `/api` AS the
// user with THAT, holding nothing over-privileged. That closes the short-lived-token seam.
const itxContextAtSsr = createServerFn({ method: "GET" }).handler(async () => {
  const projectId = getRequestHeader("x-iterate-project-id") ?? null;
  const callerRaw = getRequestHeader("x-iterate-caller");
  const appSession = getRequestHeader("x-iterate-app-session") || null; // the narrow project token
  // Where to dial `/api` (a CONTROL-PLANE surface — no longer shadowed on this dashboard host). The kernel
  // stamps the control-plane host when one is configured; otherwise `/api` still answers same-origin.
  const controlPlaneHost = getRequestHeader("x-iterate-control-plane-host") || null;
  if (!projectId) {
    return {
      note: "no project context — open this behind a project, e.g. https://alice.<domain>/",
    };
  }
  return {
    projectId,
    caller: callerRaw ? (JSON.parse(callerRaw) as Caller) : null,
    appSession,
    controlPlaneHost,
  };
});

export const Route = createFileRoute("/")({
  loader: async () => ({ ssrItx: await itxContextAtSsr() }),
  component: Dashboard,
});

// The kernel's `/api` capnweb tree from the client's side, mirroring apps/os (no codegen here):
// the root is the OS; authenticate() -> session; session.projects.get(id) -> a project handle whose
// `projectId` getter resolves once you're granted it (review #6). An unknown slug is a prospective
// handle — reading `projectId` throws its "create it" hint; a real project you can't reach throws too.
interface ProjectStub {
  projectId: Promise<string>;
  create(args?: { organizationSlug?: string }): ProjectStub;
}
interface OsStub {
  authenticate(credentials?: { type: string; token?: string }): {
    caller(): Promise<Caller>;
    projects: { get(project: string): ProjectStub };
  };
}

function Dashboard() {
  const { ssrItx } = Route.useLoaderData();
  const appSession = "appSession" in ssrItx ? ssrItx.appSession : null;
  const controlPlaneHost = "controlPlaneHost" in ssrItx ? ssrItx.controlPlaneHost : null;
  const [clientItx, setClientItx] = useState<unknown>(null);
  const [newSlug, setNewSlug] = useState("kernel-poc");
  const [orgSlug, setOrgSlug] = useState("");
  const [createResult, setCreateResult] = useState<unknown>(null);
  return (
    <main>
      {/* Cloudflare Access logout: hitting /cdn-cgi/access/logout on this Access-fronted host clears the
          session (no incognito needed). Harmless on wide-open deployments (no Access => just 404s). */}
      <p style={{ textAlign: "right", margin: 0 }}>
        <a href="/cdn-cgi/access/logout">Log out</a>
      </p>
      <h1>OS dashboard</h1>
      <p>
        A separately-deployed <b>TanStack Start</b> app, reverse-proxied behind an iterate project
        by its config worker. It holds no credentials — it reaches capabilities only through the
        project.
      </p>
      <h2>itx context at SSR (stamped by the project's front door)</h2>
      <pre>
        {JSON.stringify(
          ssrItx,
          (k, v) =>
            k === "appSession" && v ? "<minted project-app-session — used below, not shown>" : v,
          2,
        )}
      </pre>
      <h2>a live capnweb /api call from the rendered client app</h2>
      {/* Real capnweb over a WebSocket to the CONTROL-PLANE host's `/api` — the OS front desk. `/api` is a
          control-plane surface, no longer shadowed on this dashboard host (review), so we dial the
          stamped control-plane host (cross-origin; capnweb's response is CORS-open, and auth rides in the
          authenticate() body, not a cookie). If no control-plane host was stamped (simple/dev deploys
          where `/api` answers everywhere), we fall back to same-origin. We authenticate() with the NARROW
          project-app-session the front door minted (review #3) — the app acts AS the user, scoped to THIS
          project. Then projects.get(thisSlug), which that grant covers; the DIRECTORY gates non-members. */}
      <button
        type="button"
        onClick={async () => {
          const { newWebSocketRpcSession } = await import("capnweb");
          const apiOrigin = controlPlaneHost
            ? `${window.location.protocol}//${controlPlaneHost}`
            : window.location.origin;
          const wsUrl = apiOrigin.replace(/^http/, "ws") + "/api";
          // The project slug is the label after any `<app>--` app prefix: `dashboard--alice` -> `alice`.
          const firstLabel = window.location.hostname.split(".")[0];
          const slug = firstLabel.includes("--") ? firstLabel.split("--")[1]! : firstLabel;
          using os = newWebSocketRpcSession<OsStub>(wsUrl);
          const session = appSession
            ? os.authenticate({ type: "project-app-session", token: appSession })
            : os.authenticate(); // no args => the ingress wall's JWT, or anonymous (pipelined)
          try {
            const [caller, projectId] = await Promise.all([
              session.caller(),
              session.projects.get(slug).projectId, // getter, pipelined
            ]);
            setClientItx({ caller, project: { projectId } });
          } catch (error) {
            const caller = await session.caller();
            setClientItx({ caller, project: `denied: ${(error as Error).message}` });
          }
        }}
      >
        dial /api from the client →
      </button>
      <pre>{clientItx ? JSON.stringify(clientItx, null, 2) : "(click the button)"}</pre>

      <h2>create a real project (writes to auth-prd)</h2>
      {/* Dial /api and call projects.get(slug).create({ organizationSlug }). The owning org is an
          explicit slug — the security-relevant input; auth-prd owns the write (a real row). No login in
          the kernel: identity, if any, comes from the ingress wall. The org is what makes create work. */}
      <p>
        <input
          value={newSlug}
          onChange={(e) => setNewSlug(e.target.value)}
          placeholder="new project slug"
        />{" "}
        <input
          value={orgSlug}
          onChange={(e) => setOrgSlug(e.target.value)}
          placeholder="organizationSlug (required — e.g. v3-test)"
          size={40}
        />
      </p>
      <button
        type="button"
        onClick={async () => {
          const { newWebSocketRpcSession } = await import("capnweb");
          const wsUrl = window.location.origin.replace(/^http/, "ws") + "/api";
          using os = newWebSocketRpcSession<OsStub>(wsUrl);
          const session = os.authenticate(); // the ingress wall's identity, if any (else anonymous)
          try {
            const created = session.projects
              .get(newSlug)
              .create(orgSlug ? { organizationSlug: orgSlug } : {});
            setCreateResult({ ok: true, projectId: await created.projectId });
          } catch (error) {
            setCreateResult({ ok: false, error: (error as Error).message });
          }
        }}
      >
        create project in auth-prd →
      </button>
      <pre>
        {createResult ? JSON.stringify(createResult, null, 2) : "(type slug + org, then create)"}
      </pre>
    </main>
  );
}
