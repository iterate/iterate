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
    <div className="flex h-screen items-center justify-center text-[#8b949e]">Loading...</div>
  ),
  component: Root,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <div className="flex-1 flex items-center justify-center text-[#8b949e]">
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
    <div className="flex-1 flex items-center justify-center text-[#8b949e]">
      Loading repository...
    </div>
  ),
  errorComponent: ({ error }) => (
    <div className="flex-1 flex items-center justify-center text-red-400">
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

  return (
    <div className="flex h-screen">
      {isLoading && <div className="fixed top-0 left-0 right-0 h-0.5 bg-blue-500 z-50" />}
      <div className="w-[220px] border-r border-[#30363d] flex flex-col overflow-auto shrink-0">
        <h3 className="px-3 py-2 text-[11px] uppercase tracking-wide text-[#8b949e]">Repos</h3>
        <div className="px-3 py-1 flex gap-1">
          <input
            className="bg-[#0d1117] text-[#c9d1d9] border border-[#30363d] rounded px-2 py-1 text-[13px] flex-1 outline-none focus:border-blue-500"
            placeholder="new repo"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <button
            className="bg-transparent text-blue-400 border border-[#30363d] rounded px-2 py-0.5 cursor-pointer text-xs hover:bg-[#161b22]"
            onClick={handleCreate}
          >
            +
          </button>
        </div>
        {repos.map((name) => (
          <Link
            key={name}
            to="/$artifact"
            params={{ artifact: name }}
            className="block px-3 py-1 text-[13px] text-[#c9d1d9] no-underline hover:bg-[#161b22] truncate"
            activeProps={{
              className:
                "block px-3 py-1 text-[13px] text-[#c9d1d9] no-underline bg-[#161b22] truncate",
            }}
          >
            {name}
          </Link>
        ))}
      </div>
      <Outlet />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
