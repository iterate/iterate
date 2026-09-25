// /sessions: every grant the signed-in user holds (browsers and connected apps, which are OAuth
// grants; personal access tokens and devices' keys), each endable on its own, and the one place in
// the Dash a personal access token is minted: a name, the projects it may reach and when it expires
// → `api.grants.mint` → the key, shown ONCE (the account keeps only its hash). The list is one page
// of `grants.list(cursor)` — the route's loader, `?cursor=` in the URL; a mint or an end
// invalidates the router, which reloads it.
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import type { GrantKind } from "iterate/api";
import { Avatar, AvatarFallback, AvatarImage } from "@iterate-com/ui/components/avatar";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Checkbox } from "@iterate-com/ui/components/checkbox";
import { Input } from "@iterate-com/ui/components/input";
import { Label } from "@iterate-com/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { NotRecorded } from "@iterate-com/ui/components/not-recorded";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";
import { Identifier } from "../../components/identifier.tsx";
import { AllowAccount } from "../../components/allow-account.tsx";

const GRANT_KIND_LABELS: Record<GrantKind, string> = {
  pending: "Pending sign-in",
  device: "Device",
  personal: "Personal access token",
  session: "Session",
};

export const Route = createFileRoute("/_auth/sessions")({
  validateSearch: z.object({ cursor: z.string().optional().catch(undefined) }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  staticData: { page: "Sessions" },
  // `account` is optional at consent: without it there is no list to load — the page offers the
  // step-up instead of the error the API would answer with.
  loader: async ({ context, deps }) =>
    context.info.scopes.includes("account") ? await context.api.grants.list(deps.cursor) : null,
  head: () => ({ meta: [{ title: "Sessions · Dash" }] }),
  component: SessionsPage,
});

/** How long a new key lives, in days; `never` mints one that ends only when it is revoked. */
const TOKEN_LIFETIMES = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "No expiry" },
];

/** A personal access token as the form just minted it — held only in this page's state, shown
 *  once; a reload forgets it, as the server already has. */
type MintedPersonalAccessToken = { name: string; token: string; expiresAt: number | null };

function SessionsPage() {
  const data = Route.useLoaderData();
  const { cursor } = Route.useSearch();
  const { api, info } = Route.useRouteContext();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState("");
  const [tokenLifetime, setTokenLifetime] = useState("30");
  const [excludedProjectIds, setExcludedProjectIds] = useState<Set<string>>(new Set());
  const [minted, setMinted] = useState<MintedPersonalAccessToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [minting, setMinting] = useState(false);
  // Ending THIS browser's grant is a sign-out: the app's own logout clears the session and its
  // cookie too (a bare redirect to `/` would bounce a still-cached token back into /projects).
  const logout = useRef<HTMLFormElement>(null);
  if (!data)
    return (
      <AllowAccount
        title="Sessions"
        next="/sessions"
        description="This session may not manage your sessions and personal access tokens."
        action="Allow the dash to manage them"
      />
    );
  const { items, cursor: nextCursor, projects, canMintToken } = data;
  const selectedProjectIds = projects
    .filter((project) => !excludedProjectIds.has(project.id))
    .map((project) => project.id);
  const slugOf = new Map(projects.map((project) => [project.id, project.slug]));

  const mintPersonalAccessToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = tokenName.trim();
    setError(null);
    setMinting(true);
    try {
      const { token, expiresAt } = await api.grants.mint({
        name,
        projects: selectedProjectIds,
        expiresAt:
          tokenLifetime === "never"
            ? undefined
            : Date.now() + Number(tokenLifetime) * 24 * 3600_000,
      });
      setMinted({ name, token, expiresAt });
      setCopied(false);
      setTokenName("");
      await router.invalidate({ sync: true });
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
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 md:p-8">
      <form ref={logout} method="post" action="/.auth/logout" hidden />
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
        {/* whose: the address and the person's id, copyable */}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {info.principal.email ? <span>{info.principal.email}</span> : null}
          <Identifier value={info.principal.actor} textClassName="text-xs" />
        </p>
      </div>
      {error && (
        <p role="alert" data-type="error" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border">
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
                <TableCell className="font-medium">
                  <div className="flex items-center gap-3">
                    <Avatar className="rounded-md after:rounded-md" aria-hidden="true">
                      {/* Base UI applies the prop to its preloader; render also sets it on the visible image. */}
                      <AvatarImage
                        src={item.logoUri}
                        alt=""
                        referrerPolicy="no-referrer"
                        render={<img alt="" referrerPolicy="no-referrer" />}
                        className="rounded-md object-contain"
                      />
                      <AvatarFallback className="rounded-md text-xs">
                        {item.name.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col gap-0.5">
                      <span>
                        {item.name}
                        {item.current && (
                          <Badge variant="secondary" className="ml-2">
                            this browser
                          </Badge>
                        )}
                      </span>
                      {item.clientDomain && (
                        <span
                          className="max-w-64 truncate text-xs font-normal text-muted-foreground"
                          title={item.clientDomain}
                        >
                          {item.clientDomain}
                        </span>
                      )}
                      {item.projects && (
                        <span className="max-w-64 truncate font-mono text-xs font-normal text-muted-foreground">
                          {item.projects.map((id) => slugOf.get(id) ?? id).join(", ")}
                        </span>
                      )}
                      {item.mintedBy && (
                        <span className="max-w-64 truncate text-xs font-normal text-muted-foreground">
                          Minted by{" "}
                          {items.find((session) => session.id === item.mintedBy)?.name ??
                            "a session no longer listed"}
                        </span>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  {GRANT_KIND_LABELS[item.kind]}
                  {item.resource && (
                    <span className="text-muted-foreground">
                      {" · "}
                      {item.resource === "mcp" ? "MCP" : "API"}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {item.lastUsedAt ? new Date(item.lastUsedAt).toISOString() : "Not used yet"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {item.expired
                    ? "Expired"
                    : item.expiresAt
                      ? new Date(item.expiresAt).toISOString()
                      : "Never"}
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
                        if (item.current) logout.current?.requestSubmit();
                        else await router.invalidate();
                      } catch (caught) {
                        setError(caught instanceof Error ? caught.message : String(caught));
                      }
                    }}
                  >
                    {item.expired
                      ? "Remove"
                      : item.kind === "personal" || item.kind === "device"
                        ? "Revoke"
                        : "Log out"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {!items.length && <p className="text-sm text-muted-foreground">No sessions on this page.</p>}
      <p className="flex gap-3 text-sm">
        {cursor && (
          <Link to="/sessions" search={{}} className="underline-offset-4 hover:underline">
            First page
          </Link>
        )}
        {nextCursor && (
          <Link
            to="/sessions"
            search={{ cursor: nextCursor }}
            className="underline-offset-4 hover:underline"
          >
            Next page
          </Link>
        )}
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Personal access tokens</CardTitle>
          <CardDescription>
            A personal access token is your API key: it acts as you, on the projects you choose,
            until it expires or you revoke it from the list above. It is shown once. Send it as{" "}
            <code>Authorization: Bearer</code> to <code>/api</code>, to <code>/mcp</code> from an
            MCP client, or to your projects' hosts.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {minted && (
            // never in a session replay or autocapture: the key is shown once, here
            <NotRecorded
              role="status"
              data-testid="minted"
              className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm"
            >
              <strong>{minted.name}</strong> — copy it now; it is not shown again.{" "}
              {minted.expiresAt
                ? `Expires ${new Date(minted.expiresAt).toISOString()}.`
                : "It never expires."}{" "}
              <code data-testid="minted-token" className="break-all">
                {minted.token}
              </code>
              <Button type="button" size="sm" variant="outline" onClick={copyMintedToken}>
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setMinted(null)}>
                Dismiss
              </Button>
            </NotRecorded>
          )}
          {canMintToken ? (
            <form onSubmit={mintPersonalAccessToken} className="flex flex-col gap-4">
              <Label className="flex flex-col items-start gap-2">
                Name
                <Input
                  aria-label="Token name"
                  value={tokenName}
                  onChange={(event) => setTokenName(event.target.value)}
                  maxLength={100}
                  placeholder="My script"
                  required
                  className="max-w-sm"
                />
              </Label>
              <Label className="flex flex-col items-start gap-2">
                Expires
                <NativeSelect
                  aria-label="Token expiry"
                  value={tokenLifetime}
                  disabled={minting}
                  onChange={(event) => setTokenLifetime(event.target.value)}
                >
                  {TOKEN_LIFETIMES.map((lifetime) => (
                    <NativeSelectOption key={lifetime.value} value={lifetime.value}>
                      {lifetime.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Label>
              <div
                aria-label="Projects the token may reach"
                className="flex flex-wrap gap-x-5 gap-y-2 text-sm"
              >
                {projects.length > 0
                  ? projects.map((project) => (
                      <Label key={project.id} className="gap-2 font-mono font-normal">
                        <Checkbox
                          checked={!excludedProjectIds.has(project.id)}
                          disabled={minting}
                          onCheckedChange={(checked) => {
                            setExcludedProjectIds((current) => {
                              const next = new Set(current);
                              if (checked) next.delete(project.id);
                              else next.add(project.id);
                              return next;
                            });
                          }}
                        />
                        {project.slug}
                      </Label>
                    ))
                  : "Create a project first — a token is scoped to the projects it may reach."}
              </div>
              <div>
                <Button
                  type="submit"
                  disabled={
                    minting || selectedProjectIds.length === 0 || tokenName.trim().length === 0
                  }
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
        </CardContent>
      </Card>
    </div>
  );
}
