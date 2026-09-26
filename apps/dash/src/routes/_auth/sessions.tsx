// /sessions: every grant the signed-in user holds (browsers and connected apps, which are OAuth
// grants; personal access tokens and devices' keys), each endable on its own, and the one place in
// the Dash a personal access token is minted, in the New token sheet (`?token=1`): a name, the
// projects it may reach and when it expires → `api.grants.mint` → the key, shown ONCE in the sheet
// (the account keeps only its hash). The list is one page
// of `grants.list(cursor)` — the route's loader, `?cursor=` in the URL; a mint or an end
// invalidates the router, which reloads it. "Connected accounts" are the person's own connections
// (the `account` facet's live `integrations` on `session.user`): a sign-in with Google, Cloudflare or
// GitHub keeps one, and so does connecting Google, Cloudflare or Waitrose here (`?waitrose=1`). A project uses one when its
// Integrations page connects it there; disconnecting one here ends every project's use of it.
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { z } from "zod";
import type { GrantKind, GrantRecord } from "iterate/api";
import { Avatar, AvatarFallback, AvatarImage } from "@iterate-com/ui/components/avatar";
import { Button } from "@iterate-com/ui/components/button";
import { Checkbox } from "@iterate-com/ui/components/checkbox";
import { Input } from "@iterate-com/ui/components/input";
import { Label } from "@iterate-com/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { NotRecorded } from "@iterate-com/ui/components/not-recorded";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { Spinner } from "@iterate-com/ui/components/spinner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@iterate-com/ui/components/alert-dialog";
import { ConnectButton } from "@iterate-com/ui/components/connect-button";
import { useContextStub, useFacetLiveState } from "iterate/react";
import { Identifier } from "../../components/identifier.tsx";
import { AllowAccount } from "../../components/allow-account.tsx";

const GRANT_KIND_LABELS: Record<GrantKind, string> = {
  pending: "Pending sign-in",
  device: "Device",
  personal: "Personal access token",
  session: "Session",
};

export const Route = createFileRoute("/_auth/sessions")({
  validateSearch: z.object({
    cursor: z.string().optional().catch(undefined),
    /** The New token sheet. */
    token: z.literal(1).optional().catch(undefined),
    /** The sheet that connects your own Waitrose account. */
    waitrose: z.literal(1).optional().catch(undefined),
  }),
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

/** A date as a person reads it, the same on the server and in the browser. */
const dateOf = (at: number) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(new Date(at).getUTCFullYear() !== new Date().getUTCFullYear() && { year: "numeric" }),
    timeZone: "UTC",
  }).format(at);

/** A session row's details on two lines: what it is (its kind, host and projects), then when (since,
 *  last used, expiry). */
function metaOf(item: GrantRecord, slugOf: Map<string, string>) {
  const what = [
    item.resource === "mcp"
      ? `${GRANT_KIND_LABELS[item.kind]} (MCP)`
      : GRANT_KIND_LABELS[item.kind],
    item.clientDomain,
    item.projects?.map((id) => slugOf.get(id) ?? id).join(", "),
  ];
  const when = [
    `Since ${dateOf(item.createdAt)}`,
    item.lastUsedAt ? `used ${dateOf(item.lastUsedAt)}` : "not used yet",
    item.expired ? "expired" : item.expiresAt ? `expires ${dateOf(item.expiresAt)}` : undefined,
  ];
  return [what, when].map((line) => line.filter((part): part is string => Boolean(part)));
}

/** A personal access token as the form just minted it — held only in this page's state, shown
 *  once; a reload forgets it, as the server already has. */
type MintedPersonalAccessToken = { name: string; token: string; expiresAt: number | null };

function SessionsPage() {
  const data = Route.useLoaderData();
  const { cursor, token: tokenSheet } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
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
  // A minted key lives only while its sheet is open: closed any way (Back included), it is gone —
  // and one whose mint answers after its sheet closed is never shown (it is listed, to revoke).
  const tokenSheetOpen = useRef(false);
  tokenSheetOpen.current = Boolean(tokenSheet);
  useEffect(() => {
    if (!tokenSheet) setMinted(null);
  }, [tokenSheet]);
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
      if (tokenSheetOpen.current) setMinted({ name, token, expiresAt });
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

  const closeTokenSheet = () => {
    if (minting) return;
    setMinted(null);
    setError(null);
    void navigate({ search: { cursor }, replace: true });
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
      {error && !tokenSheet && (
        <p role="alert" data-type="error" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <section className="flex flex-col gap-2" aria-labelledby="sessions-heading">
        <div className="flex items-center justify-between gap-3">
          <h2 id="sessions-heading" className="font-medium">
            Signed in
          </h2>
          {canMintToken ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void navigate({ search: { cursor, token: 1 } })}
            >
              New token
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">Tokens need an HTTPS deployment</span>
          )}
        </div>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing on this page.</p>
        ) : (
          <ul className="flex flex-col divide-y border-y" aria-label="Sessions">
            {[...items]
              // this browser first, then by last use, newest first (a page of the list, as listed)
              .sort(
                (a, b) =>
                  Number(Boolean(b.current)) - Number(Boolean(a.current)) ||
                  (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) ||
                  b.createdAt - a.createdAt,
              )
              .map((item) => (
                <li key={item.id} className="flex items-center gap-3 py-3">
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
                  <div className="min-w-0 flex-1">
                    <p className="font-medium [overflow-wrap:anywhere]">
                      {item.name}
                      {item.current && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          This browser
                        </span>
                      )}
                    </p>
                    {metaOf(item, slugOf).map((line, lineIndex) => (
                      <p key={line[0]} className="text-xs text-muted-foreground">
                        {line.map((part, index) => (
                          <span key={part}>
                            {index > 0 ? " · " : ""}
                            {/* a host may break anywhere; a date stays whole */}
                            <span
                              className={
                                lineIndex === 0 ? "[overflow-wrap:anywhere]" : "whitespace-nowrap"
                              }
                            >
                              {part}
                            </span>
                          </span>
                        ))}
                      </p>
                    ))}
                    {item.impersonatedBy && (
                      <p className="text-xs text-muted-foreground">
                        Started by {item.impersonatedBy}, signed in as you
                      </p>
                    )}
                    {item.mintedBy && (
                      <p className="text-xs text-muted-foreground">
                        Made by{" "}
                        {items.find((session) => session.id === item.mintedBy)?.name ??
                          "a session no longer listed"}
                      </p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
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
                </li>
              ))}
          </ul>
        )}
        {(cursor || nextCursor) && (
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
        )}
      </section>

      <ConnectedAccounts projects={projects} />

      <Sheet
        open={Boolean(tokenSheet && canMintToken)}
        onOpenChange={(open) => !open && closeTokenSheet()}
      >
        <SheetContent
          side="right"
          showCloseButton={!minting}
          className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          {minted ? (
            // never in a session replay or autocapture: the key is shown once, here
            <NotRecorded role="status" data-testid="minted" className="flex h-full flex-col">
              <SheetHeader>
                <SheetTitle>{minted.name}</SheetTitle>
                <SheetDescription>
                  Copy it now: it isn't shown again.{" "}
                  {minted.expiresAt ? `Expires ${dateOf(minted.expiresAt)}.` : "No expiry."}
                </SheetDescription>
              </SheetHeader>
              <div className="flex items-start gap-2 px-4">
                <code
                  data-testid="minted-token"
                  className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1.5 text-xs break-all"
                >
                  {minted.token}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  title={copied ? "Copied" : "Copy token"}
                  onClick={copyMintedToken}
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </Button>
              </div>
              {error && (
                <p role="alert" data-type="error" className="px-4 text-sm text-destructive">
                  {error}
                </p>
              )}
              <SheetFooter className="border-t sm:flex-row sm:justify-end">
                <Button type="button" onClick={closeTokenSheet}>
                  Done
                </Button>
              </SheetFooter>
            </NotRecorded>
          ) : (
            <form onSubmit={mintPersonalAccessToken} className="flex h-full flex-col">
              <SheetHeader>
                <SheetTitle>New token</SheetTitle>
                <SheetDescription>
                  Acts as you on the projects you pick. Send it as{" "}
                  <code>Authorization: Bearer</code>.
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-1 flex-col gap-4 px-4 pb-4">
                <Label className="flex flex-col items-start gap-2">
                  Name
                  <Input
                    aria-label="Token name"
                    value={tokenName}
                    onChange={(event) => setTokenName(event.target.value)}
                    maxLength={100}
                    placeholder="My script"
                    required
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
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-2 text-sm font-medium">Projects</legend>
                  {projects.length > 0 ? (
                    projects.map((project) => (
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
                  ) : (
                    <p className="text-sm text-muted-foreground">Create a project first.</p>
                  )}
                </fieldset>
                {error && (
                  <p role="alert" data-type="error" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
              </div>
              <SheetFooter className="border-t sm:flex-row sm:justify-end">
                <Button
                  type="submit"
                  disabled={
                    minting || selectedProjectIds.length === 0 || tokenName.trim().length === 0
                  }
                >
                  {minting ? <Spinner data-icon="inline-start" /> : null}
                  Create token
                </Button>
              </SheetFooter>
            </form>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** The providers a person connects on their own account here (GitHub comes from signing in). */
const PERSONAL_CONNECT_PROVIDERS: ("google" | "cloudflare")[] = ["google", "cloudflare"];

/** The provider names a person's connection shows. */
const PROVIDER_TITLES: Record<string, string> = {
  slack: "Slack",
  google: "Google",
  cloudflare: "Cloudflare",
  github: "GitHub",
  waitrose: "Waitrose",
};

const AccountConnections = z.looseObject({
  integrations: z
    .record(
      z.string(),
      z.object({ provider: z.string(), connection: z.string(), account: z.string() }),
    )
    .default({}),
  /** The account's secrets, with the projects each one's connection is connected to (its lends). */
  secrets: z
    .record(
      z.string(),
      z.looseObject({ lends: z.record(z.string(), z.object({ to: z.string() })).optional() }),
    )
    .default({}),
});

/** THE PERSON'S CONNECTED ACCOUNTS: listed live with the projects using each, disconnected (every
 *  project's use ends with it), or connected here through iterate's app (Google, Cloudflare). */
function ConnectedAccounts({ projects }: { projects: { id: string; slug: string }[] }) {
  const { api, info } = Route.useRouteContext();
  const person = useContextStub(() => Promise.resolve(api.user), [api]);
  const live = useFacetLiveState(person.stub, "account");
  const state = AccountConnections.safeParse(live.value).data;
  const accounts = Object.values(state?.integrations ?? {});
  const slugOf = new Map(projects.map((project) => [project.id, project.slug]));
  /** The projects a connection is connected to, by slug. */
  const usedBy = (row: { provider: string; connection: string }) =>
    Object.values(state?.secrets[`/secrets/${row.provider}-${row.connection}`]?.lends ?? {}).map(
      (lend) => slugOf.get(lend.to) || lend.to,
    );
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const next = `${window.location.origin}/sessions`;
  const loadError = person.error || live.error;
  const { waitrose } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const closeWaitrose = () =>
    void navigate({ search: (prev) => ({ ...prev, waitrose: undefined }), replace: true });
  /** A Waitrose connect in flight: its sheet stays open until it answers. */
  const [waitrosePending, setWaitrosePending] = useState(false);
  return (
    <section className="flex flex-col gap-2" aria-labelledby="connected-accounts-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="connected-accounts-heading" className="font-medium">
          Connected accounts
        </h2>
        <div className="flex flex-wrap gap-2">
          {PERSONAL_CONNECT_PROVIDERS.filter((provider) =>
            info.iterateAppProviders.includes(provider),
          ).map((provider) => (
            <ConnectButton
              key={provider}
              provider={provider}
              variant="outline"
              size="sm"
              connect={async (input) =>
                z
                  .object({ authorizationUrl: z.string().url() })
                  .parse(await api.user.integrations.connect(input.provider, { next }))
              }
              onError={(caught) =>
                setError(caught instanceof Error ? caught.message : String(caught))
              }
            />
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void navigate({ search: (prev) => ({ ...prev, waitrose: 1 }) })}
          >
            Connect Waitrose
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" data-type="error" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {loadError ? (
        <p role="alert" data-type="error" className="text-sm text-destructive">
          Couldn't load your connected accounts: {loadError}
        </p>
      ) : !live.value ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading…
        </p>
      ) : accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">None yet.</p>
      ) : (
        <ul className="flex flex-col divide-y border-y" aria-label="Connected accounts">
          {accounts.map((row) => {
            const projectsUsing = usedBy(row);
            return (
              <li
                key={`${row.provider}-${row.connection}`}
                className="flex items-center gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium [overflow-wrap:anywhere]">{row.account}</p>
                  <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {PROVIDER_TITLES[row.provider] || row.provider}
                    {projectsUsing.length > 0 && ` · Used by ${projectsUsing.join(", ")}`}
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger
                    render={<Button variant="ghost" size="sm" />}
                    disabled={Boolean(disconnecting)}
                  >
                    {disconnecting === row.connection ? <Spinner data-icon="inline-start" /> : null}
                    Disconnect
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Disconnect {row.account}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        {projectsUsing.length > 0
                          ? `${projectsUsing.join(", ")} ${projectsUsing.length === 1 ? "stops" : "stop"} using it, and its token is deleted.`
                          : "Its token is deleted."}{" "}
                        Sign in with it or connect it again to get it back.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        onClick={async () => {
                          setError(null);
                          setDisconnecting(row.connection);
                          try {
                            await api.user.facets
                              .get("account")
                              .invoke([
                                [
                                  "disconnectIntegration",
                                  { provider: row.provider, connection: row.connection },
                                ],
                              ]);
                          } catch (caught) {
                            setError(caught instanceof Error ? caught.message : String(caught));
                          } finally {
                            setDisconnecting(null);
                          }
                        }}
                      >
                        Disconnect
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            );
          })}
        </ul>
      )}
      <Sheet
        open={Boolean(waitrose)}
        onOpenChange={(open) => !open && !waitrosePending && closeWaitrose()}
      >
        <SheetContent
          side="right"
          showCloseButton={!waitrosePending}
          className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          {waitrose && (
            <WaitroseForm
              onPendingChange={setWaitrosePending}
              onConnect={async ({ username, password }) => {
                // your own: the secret and its connection on your account, like a sign-in's
                const connection = crypto.randomUUID().slice(0, 8);
                const secretPath = `/secrets/waitrose-${connection}`;
                await api.user.secrets.set(
                  secretPath,
                  { username, password },
                  {
                    urls: [new URL(WAITROSE_GRAPHQL_URL).origin],
                    refresh: { kind: "waitrose-session", graphqlUrl: WAITROSE_GRAPHQL_URL },
                  },
                );
                await api.user.facets
                  .get("account")
                  .invoke([["connectWaitrose", { connection, account: username }]])
                  .catch(async (caught: unknown) => {
                    await api.user.secrets.delete(secretPath).catch(() => {});
                    throw caught;
                  });
                closeWaitrose();
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}

/** Where Waitrose logs in (apps/os/src/integrations/waitrose.ts): the connection's secret's pin. */
const WAITROSE_GRAPHQL_URL = "https://www.waitrose.com/api/graphql";

/** Your Waitrose username and password, for your own connection's secret. They go to the secret
 *  alone: the platform logs in with them on first use and whenever Waitrose answers 401. */
function WaitroseForm({
  onConnect,
  onPendingChange,
}: {
  onConnect: (credentials: { username: string; password: string }) => Promise<void>;
  /** Whether a connect is in flight, for the sheet around it (it stays open until the answer). */
  onPendingChange: (pending: boolean) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    onPendingChange(true);
    try {
      await onConnect({ username, password });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPending(false);
    } finally {
      onPendingChange(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex h-full flex-col">
      <SheetHeader>
        <SheetTitle>Connect Waitrose</SheetTitle>
        <SheetDescription>The password is only ever sent to waitrose.com.</SheetDescription>
      </SheetHeader>
      <div className="flex flex-1 flex-col gap-4 px-4 pb-4">
        <Label className="flex flex-col items-start gap-2">
          Email
          <Input
            type="email"
            autoComplete="off"
            required
            value={username}
            onChange={(event) => setUsername(event.target.value.trim())}
          />
        </Label>
        <Label className="flex flex-col items-start gap-2">
          Password
          <Input
            type="password"
            autoComplete="off"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Label>
        {error && (
          <p role="alert" data-type="error" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <SheetFooter className="border-t sm:flex-row sm:justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Connect
        </Button>
      </SheetFooter>
    </form>
  );
}
