/**
 * Artifacts — Cloudflare Artifacts browser + editor.
 *
 * Code-based routing with two routes:
 * - / — select a repo
 * - /$artifact — browse/edit repo files + commit history
 *
 * https://tanstack.com/router/latest/docs/framework/react/guide/code-based-routing
 */
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
  Link,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ArtifactView } from "./artifact.tsx";

const rootRoute = createRootRoute({
  loader: async () => {
    const res = await fetch("/api/repos");
    if (!res.ok) throw new Error(`Failed to load repos: ${res.status}`);
    return (await res.json()).repos.map((r: { name: string }) => r.name) as string[];
  },
  pendingComponent: () => (
    <div
      style={{
        display: "flex",
        height: "100vh",
        alignItems: "center",
        justifyContent: "center",
        background: "#0d1117",
        color: "#8b949e",
        fontFamily: "monospace",
      }}
    >
      Loading...
    </div>
  ),
  component: Root,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#8b949e",
      }}
    >
      Select a repo to get started
    </div>
  ),
});

// https://tanstack.com/router/latest/docs/framework/react/guide/data-loading
export const artifactRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$artifact",
  validateSearch: (search: Record<string, unknown>) => ({
    commit: (search.commit as string) ?? undefined,
    file: (search.file as string) ?? undefined,
  }),
  loaderDeps: ({ search }) => ({ commit: search.commit }),
  loader: async ({ params, deps }) => {
    const commitsRes = await fetch(`/api/log?repo=${params.artifact}`);
    if (!commitsRes.ok) throw new Error(`Failed to load commits: ${commitsRes.status}`);
    const commits = await commitsRes.json();
    const qs = deps.commit ? `&oid=${deps.commit}` : "";
    const treeRes = await fetch(`/api/tree?repo=${params.artifact}${qs}`);
    if (!treeRes.ok) throw new Error(`Failed to load tree: ${treeRes.status}`);
    return { commits, tree: ((await treeRes.json()).paths ?? []) as string[] };
  },
  pendingComponent: () => (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#8b949e",
      }}
    >
      Loading repository...
    </div>
  ),
  errorComponent: ({ error }) => (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#f85149",
      }}
    >
      Failed to load: {error.message}
    </div>
  ),
  component: ArtifactView,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, artifactRoute]),
  defaultPendingMs: 150,
  defaultPendingMinMs: 200,
  defaultStaleTime: 30_000,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function Root() {
  const repos = rootRoute.useLoaderData();
  const [newName, setNewName] = useState("");
  const navigate = useNavigate();
  const r = useRouter();
  const isLoading = useRouterState({ select: (s) => s.isLoading });

  async function handleCreate() {
    if (!newName.trim()) return;
    const name = newName.trim();
    await fetch("/api/repos", {
      method: "POST",
      body: JSON.stringify({ name }),
      headers: { "content-type": "application/json" },
    });
    setNewName("");
    await r.invalidate();
    navigate({ to: "/$artifact", params: { artifact: name } });
  }

  const linkStyle = {
    padding: "4px 12px",
    cursor: "pointer",
    fontSize: 13,
    display: "block",
    color: "#c9d1d9",
    textDecoration: "none",
  };

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        fontFamily: "monospace",
        background: "#0d1117",
        color: "#c9d1d9",
      }}
    >
      {isLoading && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            background: "#1f6feb",
            zIndex: 100,
          }}
        />
      )}
      <div
        style={{
          width: 220,
          borderRight: "1px solid #30363d",
          display: "flex",
          flexDirection: "column",
          overflow: "auto",
          flexShrink: 0,
        }}
      >
        <h3
          style={{
            padding: "8px 12px",
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 1,
            color: "#8b949e",
          }}
        >
          Repos
        </h3>
        <div style={{ padding: "4px 12px", display: "flex", gap: 4 }}>
          <input
            style={{
              background: "#0d1117",
              color: "#c9d1d9",
              border: "1px solid #30363d",
              borderRadius: 4,
              padding: "4px 8px",
              fontSize: 13,
              flex: 1,
            }}
            placeholder="new repo"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <button
            style={{
              background: "transparent",
              color: "#58a6ff",
              border: "1px solid #30363d",
              borderRadius: 4,
              padding: "2px 8px",
              cursor: "pointer",
              fontSize: 12,
            }}
            onClick={handleCreate}
          >
            +
          </button>
        </div>
        {repos.map((r) => (
          <Link
            key={r}
            to="/$artifact"
            params={{ artifact: r }}
            style={linkStyle}
            activeProps={{ style: { ...linkStyle, background: "#161b22" } }}
          >
            {r}
          </Link>
        ))}
      </div>
      <Outlet />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
