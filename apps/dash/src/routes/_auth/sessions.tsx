// /sessions: every OAuth grant the signed-in user holds (browsers, connected apps, personal access
// tokens), each endable on its own, and the one place a personal access token is minted: a name and
// the projects it may reach → `api.grants.mint` → the token, shown ONCE (it is a finite provider
// access token, never stored readable). The list is one page of `grants.list(cursor)` — the route's
// loader, `?cursor=` in the URL; a mint or an end invalidates the router, which reloads it. Ported
// from apps/os-next's console page: every string, role and test id is the same.
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { z } from "zod";

export const Route = createFileRoute("/_auth/sessions")({
  validateSearch: z.object({ cursor: z.string().optional() }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: async ({ context, deps }) => await context.api.grants.list(deps.cursor),
  component: SessionsPage,
});

/** A personal access token as the form just minted it — held only in this page's state, shown
 *  once; a reload forgets it, as the server already has. */
type MintedPersonalAccessToken = { name: string; token: string; expiresAt: number };

function SessionsPage() {
  const { items, cursor: nextCursor, projects, canMintToken } = Route.useLoaderData();
  const { cursor } = Route.useSearch();
  const { api } = Route.useRouteContext();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState("");
  const [excludedProjectIds, setExcludedProjectIds] = useState<Set<string>>(new Set());
  const [minted, setMinted] = useState<MintedPersonalAccessToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [minting, setMinting] = useState(false);
  const selectedProjectIds = projects
    .filter((project) => !excludedProjectIds.has(project.id))
    .map((project) => project.id);

  const mintPersonalAccessToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = tokenName.trim();
    setError(null);
    setMinting(true);
    try {
      const { token, expiresAt } = await api.grants.mint({ name, projects: selectedProjectIds });
      setMinted({ name, token, expiresAt });
      setCopied(false);
      setTokenName("");
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMinting(false);
    }
  };
  const copyMintedToken = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <main>
      <p>
        <Link to="/dashboard">Projects</Link>
      </p>
      <h1>Sessions</h1>
      <p className="muted">
        Each browser, connected client, and personal access token can be signed out independently.
        Existing connections end within a minute.
      </p>
      {error && <p role="alert">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Last used</th>
            <th>Expires</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                {item.name}
                {item.current && " (this browser)"}
              </td>
              <td>{item.kind}</td>
              <td>{item.lastUsedAt ? new Date(item.lastUsedAt).toISOString() : "Not used yet"}</td>
              <td>
                {item.cleanupPending
                  ? "Access revoked; cleanup pending"
                  : item.expired
                    ? "Expired"
                    : item.expiresAt
                      ? new Date(item.expiresAt).toISOString()
                      : "—"}
              </td>
              <td>
                <button
                  type="button"
                  onClick={async () => {
                    setError(null);
                    try {
                      await api.grants.end(item.id);
                      if (item.current) window.location.assign("/");
                      else await router.invalidate();
                    } catch (caught) {
                      setError(caught instanceof Error ? caught.message : String(caught));
                    }
                  }}
                >
                  {item.cleanupPending
                    ? "Retry cleanup"
                    : item.expired
                      ? "Remove"
                      : item.kind === "Personal access token"
                        ? "Revoke"
                        : "Log out"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && <p className="muted">No sessions on this page.</p>}
      <p>
        {cursor && (
          <Link to="/sessions" search={{}}>
            First page
          </Link>
        )}{" "}
        {nextCursor && (
          <Link to="/sessions" search={{ cursor: nextCursor }}>
            Next page
          </Link>
        )}
      </p>

      <h2>Personal access tokens</h2>
      <p className="muted">
        A personal access token is one OAuth grant: it acts as you, for the projects you choose, for
        30 days, and is shown once. Send it as <code>Authorization: Bearer</code> on{" "}
        <code>/api</code>, <code>/mcp</code> or a project host; revoke it from the list above.
      </p>
      {minted && (
        <p role="status" data-testid="minted">
          <strong>{minted.name}</strong> — copy it now; it is not shown again. Expires{" "}
          {new Date(minted.expiresAt).toISOString()}.{" "}
          <code data-testid="minted-token">{minted.token}</code>{" "}
          <button type="button" onClick={copyMintedToken}>
            {copied ? "Copied" : "Copy"}
          </button>{" "}
          <button type="button" onClick={() => setMinted(null)}>
            Dismiss
          </button>
        </p>
      )}
      {canMintToken ? (
        <form onSubmit={mintPersonalAccessToken}>
          <label>
            Name{" "}
            <input
              aria-label="Token name"
              value={tokenName}
              onChange={(event) => setTokenName(event.target.value)}
              maxLength={100}
              placeholder="My script"
              required
            />
          </label>
          <p aria-label="Projects the token may reach">
            {projects.length > 0
              ? projects.map((project) => (
                  <label key={project.id}>
                    <input
                      type="checkbox"
                      aria-label={project.id}
                      checked={!excludedProjectIds.has(project.id)}
                      disabled={minting}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setExcludedProjectIds((current) => {
                          const next = new Set(current);
                          if (checked) next.delete(project.id);
                          else next.add(project.id);
                          return next;
                        });
                      }}
                    />{" "}
                    {project.id}{" "}
                  </label>
                ))
              : "Create a project first — a token is scoped to the projects it may reach."}
          </p>
          <div className="actions">
            <button
              type="submit"
              disabled={minting || selectedProjectIds.length === 0 || tokenName.trim().length === 0}
            >
              {minting ? "Creating…" : "Create personal access token"}
            </button>
          </div>
        </form>
      ) : (
        <p className="muted">Personal access tokens require an HTTPS deployment.</p>
      )}
    </main>
  );
}
