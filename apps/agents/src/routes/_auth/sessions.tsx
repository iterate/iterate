// /sessions: every OAuth grant the signed-in user holds (browsers, connected apps, personal access
// tokens), each endable on its own, and the one place a personal access token is minted: a name and
// the projects it may reach → `api.grants.mint` → the token, shown ONCE (it is a finite provider
// access token, never stored readable). The list is one page of `grants.list(cursor)` — the route's
// loader, `?cursor=` in the URL; a mint or an end invalidates the router, which reloads it. Ported
// from apps/os-next's console page: every string, role and test id is the same.
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";

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
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8">
      <p className="text-sm">
        <Link to="/dashboard" className="underline underline-offset-4">
          Projects
        </Link>
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
      <p className="text-sm text-muted-foreground">
        Each browser, connected client, and personal access token can be signed out independently.
        Existing connections end within a minute.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.id}>
              <TableCell>
                {item.name}
                {item.current && " (this browser)"}
              </TableCell>
              <TableCell>{item.kind}</TableCell>
              <TableCell>
                {item.lastUsedAt ? new Date(item.lastUsedAt).toISOString() : "Not used yet"}
              </TableCell>
              <TableCell>
                {item.cleanupPending
                  ? "Access revoked; cleanup pending"
                  : item.expired
                    ? "Expired"
                    : item.expiresAt
                      ? new Date(item.expiresAt).toISOString()
                      : "—"}
              </TableCell>
              <TableCell>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
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
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!items.length && <p className="text-sm text-muted-foreground">No sessions on this page.</p>}
      <p className="flex gap-4 text-sm">
        {cursor && (
          <Link to="/sessions" search={{}} className="underline underline-offset-4">
            First page
          </Link>
        )}
        {nextCursor && (
          <Link
            to="/sessions"
            search={{ cursor: nextCursor }}
            className="underline underline-offset-4"
          >
            Next page
          </Link>
        )}
      </p>

      <h2 className="text-lg font-semibold tracking-tight">Personal access tokens</h2>
      <p className="text-sm text-muted-foreground">
        A personal access token is one OAuth grant: it acts as you, for the projects you choose, for
        30 days, and is shown once. Send it as <code>Authorization: Bearer</code> on{" "}
        <code>/api</code>, <code>/mcp</code> or a project host; revoke it from the list above.
      </p>
      {minted && (
        <p role="status" data-testid="minted" className="rounded-lg border bg-muted/40 p-3 text-sm">
          <strong>{minted.name}</strong> — copy it now; it is not shown again. Expires{" "}
          {new Date(minted.expiresAt).toISOString()}.{" "}
          <code data-testid="minted-token" className="break-all">
            {minted.token}
          </code>{" "}
          <Button type="button" variant="outline" size="sm" onClick={copyMintedToken}>
            {copied ? "Copied" : "Copy"}
          </Button>{" "}
          <Button type="button" variant="ghost" size="sm" onClick={() => setMinted(null)}>
            Dismiss
          </Button>
        </p>
      )}
      {canMintToken ? (
        <form onSubmit={mintPersonalAccessToken} className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm">
            Name{" "}
            <Input
              aria-label="Token name"
              value={tokenName}
              onChange={(event) => setTokenName(event.target.value)}
              maxLength={100}
              placeholder="My script"
              required
              className="max-w-xs"
            />
          </label>
          <p aria-label="Projects the token may reach" className="flex flex-wrap gap-3 text-sm">
            {projects.length > 0
              ? projects.map((project) => (
                  <label key={project.id} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      aria-label={project.id}
                      checked={!excludedProjectIds.has(project.id)}
                      disabled={minting}
                      className="size-4 accent-primary"
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
          <div>
            <Button
              type="submit"
              disabled={minting || selectedProjectIds.length === 0 || tokenName.trim().length === 0}
            >
              {minting ? "Creating…" : "Create personal access token"}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          Personal access tokens require an HTTPS deployment.
        </p>
      )}
    </main>
  );
}
