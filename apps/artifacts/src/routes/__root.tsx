/** Root layout — repos sidebar + global loading bar + Outlet. */
import { createRootRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createRootRoute({
  loader: () =>
    fetch("/api/repos")
      .then((r) => r.json())
      .then((d) => d.repos.map((r: { name: string }) => r.name) as string[]),
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

function Root() {
  const repos = Route.useLoaderData();
  const [newName, setNewName] = useState("");
  const navigate = useNavigate();
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
    navigate({ to: "/$artifact", params: { artifact: name } });
  }

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
      {/* Global loading bar */}
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

      {/* Repos sidebar */}
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
        <h3 style={H3}>Repos</h3>
        <div style={{ padding: "4px 12px", display: "flex", gap: 4 }}>
          <input
            style={{ ...INPUT, flex: 1 }}
            placeholder="new repo"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <button style={BTN_SMALL} onClick={handleCreate}>
            +
          </button>
        </div>
        {repos.map((r) => (
          <Link
            key={r}
            to="/$artifact"
            params={{ artifact: r }}
            style={ITEM}
            activeProps={{ style: { ...ITEM, background: "#161b22" } }}
          >
            {r}
          </Link>
        ))}
      </div>

      <Outlet />
    </div>
  );
}

const H3 = {
  padding: "8px 12px",
  fontSize: 11,
  textTransform: "uppercase" as const,
  letterSpacing: 1,
  color: "#8b949e",
};
const INPUT = {
  background: "#0d1117",
  color: "#c9d1d9",
  border: "1px solid #30363d",
  borderRadius: 4,
  padding: "4px 8px",
  fontSize: 13,
};
const BTN_SMALL = {
  background: "transparent",
  color: "#58a6ff",
  border: "1px solid #30363d",
  borderRadius: 4,
  padding: "2px 8px",
  cursor: "pointer",
  fontSize: 12,
};
const ITEM = {
  padding: "4px 12px",
  cursor: "pointer",
  fontSize: 13,
  display: "block",
  color: "#c9d1d9",
  textDecoration: "none",
};
