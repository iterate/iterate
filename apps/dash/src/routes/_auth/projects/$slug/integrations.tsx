// /projects/<slug>/integrations — the project's connections to Slack, Google, Cloudflare and GitHub,
// and the signed-in person's own. The project's list is the `project` facet's live state on `/`
// (apps/os/src/project/contract.ts `integrations`, plus the secrets lent to it); the person's is the
// `account` facet's on `session.user` — a sign-in with Google, Cloudflare or GitHub keeps its token
// there. Connect is `itx.integrations.connect` on either (the ConnectButton), which sends the browser
// to the provider, whose callback finishes the connection and sends it back here. "Use your own app"
// is a sheet (`?own=<provider>&connection=<name>`): the URLs to paste into the provider's console,
// then the app's credentials into the connection's secret, then connect. "Lend" is a sheet
// (`?lend=<secret path>`): the person's connection lent to this project as one of its paths
// (`itx.secrets.lend`). An agent's `itx.integrations.requestFromUser` link (`?request=<provider>`)
// asks the person to connect, and then to lend. Waitrose has no consent: its sheet
// (`?waitrose=project|person`) writes the username and password into `/secrets/waitrose-<name>` with
// the `waitrose-session` strategy, then the owner facet's `connectWaitrose` records the connection.
// "Lent by this instance" lists the deployment's own keys its operator lent this project
// (`global:/secrets/<name>`, apps/os README "Instance lends").
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
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
import { Button } from "@iterate-com/ui/components/button";
import { ConnectButton } from "@iterate-com/ui/components/connect-button";
import { Field, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { SecretInput } from "@iterate-com/ui/components/not-recorded";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { useContextStub, useFacetLiveState } from "iterate/react";

const Provider = z.enum(["slack", "google", "cloudflare", "github", "waitrose"]);
type Provider = z.infer<typeof Provider>;
/** The providers connected through a consent (every one but Waitrose). */
const ConsentProvider = Provider.exclude(["waitrose"]);
type ConsentProvider = z.infer<typeof ConsentProvider>;
/** The providers with a project-app mode ("Use your own app"). */
const OwnAppProvider = z.enum(["slack", "google", "github"]);
type OwnAppProvider = z.infer<typeof OwnAppProvider>;

const Connection = z.object({
  provider: Provider,
  connection: z.string(),
  client: z.enum(["iterate", "project"]),
  account: z.string(),
});
type Connection = z.infer<typeof Connection>;

/** The project's connections and the secrets lent to it; the person's own connections (the
 *  account's state has the same `integrations`). */
const IntegrationsLive = z.looseObject({
  integrations: z.record(z.string(), Connection).default({}),
  secrets: z
    .record(
      z.string(),
      z.looseObject({
        borrowed: z
          .object({
            lender: z.object({
              email: z.string().optional(),
              instance: z.literal(true).optional(),
            }),
            integration: z.object({ provider: z.string(), account: z.string() }).optional(),
          })
          .optional(),
      }),
    )
    .default({}),
});

const PROVIDERS = [
  {
    provider: "slack",
    title: "Slack",
    noun: "workspace",
    description: "Agents read and post in the workspaces you connect.",
  },
  {
    provider: "google",
    title: "Google",
    noun: "account",
    description: "Agents use Gmail, Calendar, Drive and Docs as the accounts you connect.",
  },
  {
    provider: "cloudflare",
    title: "Cloudflare",
    noun: "account",
    description: "Agents deploy and manage the Cloudflare accounts you connect.",
  },
  {
    provider: "github",
    title: "GitHub",
    noun: "account",
    description: "Agents work in the repositories you install the app on.",
  },
  {
    provider: "waitrose",
    title: "Waitrose",
    noun: "account",
    description: "Agents shop as the Waitrose accounts you sign in with.",
  },
] as const;

/** Where Waitrose logs in (apps/os/src/integrations/waitrose.ts): the connection's secret's pin. */
const WAITROSE_GRAPHQL_URL = "https://www.waitrose.com/api/graphql";

export const Route = createFileRoute("/_auth/projects/$slug/integrations")({
  validateSearch: z.object({
    own: OwnAppProvider.optional().catch(undefined),
    connection: z.string().optional().catch(undefined),
    /** A person's connection's secret path, lent to this project from a sheet. */
    lend: z.string().optional().catch(undefined),
    /** An agent's ask (`itx.integrations.requestFromUser`): connect this provider, then lend it. */
    request: ConsentProvider.optional().catch(undefined),
    scopes: z.string().optional().catch(undefined),
    /** The path an agent asks the lend to be (`/secrets/<name>`, what its code spells). */
    lendTo: z.string().optional().catch(undefined),
    /** Back from the provider after an agent's ask: lend what was connected. */
    then: z.literal("lend").optional().catch(undefined),
    /** The Waitrose sheet, connecting the project's own account or the person's. */
    waitrose: z.enum(["project", "person"]).optional().catch(undefined),
  }),
  head: ({ params }) => ({ meta: [{ title: `Integrations · ${params.slug} · Dash` }] }),
  component: ProjectIntegrations,
});

function ProjectIntegrations() {
  const { api, info, project } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const context = useContextStub(() => api.projects.get(project.id), [api, project.id]).stub;
  const live = useFacetLiveState(context, "project");
  const projectState = IntegrationsLive.safeParse(live.value).data;
  const rows = Object.values(projectState?.integrations ?? {});
  const borrowed = Object.entries(projectState?.secrets ?? {}).flatMap(([path, row]) =>
    row.borrowed?.integration
      ? [{ path, ...row.borrowed, integration: row.borrowed.integration }]
      : [],
  );
  const lentByInstance = Object.entries(projectState?.secrets ?? {}).flatMap(([path, row]) =>
    row.borrowed?.lender.instance ? [path] : [],
  );
  // the person's own connections: a session without `account` (a device's key) opens none
  const personStub = useContextStub(
    info.scopes.includes("account") ? () => Promise.resolve(api.user) : null,
    [api, info.scopes],
  );
  const person = personStub.stub;
  const personLive = useFacetLiveState(person, "account");
  const personal = Object.values(
    IntegrationsLive.safeParse(personLive.value).data?.integrations ?? {},
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  const projectFacet = () => api.projects.get(project.id).facets.get("project");
  /** One verb at a time. A connect ends by leaving for the provider, so its spinner stays up until
   *  the browser has gone. */
  const run = async (key: string, work: () => Promise<unknown>) => {
    setError(null);
    setBusy(key);
    try {
      await work();
      if (!key.startsWith("connect:") && key !== "own") setBusy(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(null);
    }
  };
  const here = `${window.location.origin}/projects/${project.slug}/integrations`;
  const connect = async (input: Record<string, string>) => {
    const { authorizationUrl } = z
      .object({ authorizationUrl: z.string().url() })
      .parse(await projectFacet().invoke([["connectIntegration", { ...input, next: here }]]));
    window.location.assign(authorizationUrl);
  };
  /** `itx.integrations.connect` on the project, or on the person (`session.user`), coming back
   *  here — for a person asked by an agent, to lend what they connected. */
  const connectOn =
    (owner: "project" | "person", next = here) =>
    async (input: { provider: ConsentProvider; scopes?: string[]; connection?: string }) =>
      z.object({ authorizationUrl: z.string().url() }).parse(
        await (owner === "project" ? api.projects.get(project.id) : api.user).integrations.connect(
          input.provider,
          {
            scopes: input.scopes,
            connection: input.connection,
            next,
          },
        ),
      );
  const lendRow = search.lend
    ? personal.find((row) => `/secrets/${row.provider}-${row.connection}` === search.lend)
    : undefined;
  // back from an agent's ask: the connection the ask connected (named in `next`) is what they lend
  const asked =
    search.request &&
    personal.find((row) => row.provider === search.request && row.connection === search.connection);
  useEffect(() => {
    if (!asked || search.then !== "lend") return;
    void navigate({
      search: { lend: `/secrets/${asked.provider}-${asked.connection}`, lendTo: search.lendTo },
      replace: true,
    });
  }, [asked, search.then, search.lendTo, navigate]);
  const own =
    search.own && search.connection
      ? { provider: search.own, connection: search.connection }
      : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 p-4 md:p-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          {info.iterateAppProviders.length > 0
            ? "Connect this project through iterate's app in one click, or bring your own app."
            : "Connect this project with your own app: this deployment has none of iterate's."}
        </p>
      </div>
      {error && !own && (
        <p role="alert" data-type="error" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {PROVIDERS.map(({ provider, title, noun, description }) => {
        const connections = rows.filter((row) => row.provider === provider);
        return (
          <section
            key={provider}
            className="flex flex-col gap-3"
            aria-labelledby={`${provider}-heading`}
          >
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-col gap-1">
                <h2 id={`${provider}-heading`} className="text-lg font-semibold tracking-tight">
                  {title}
                </h2>
                <p className="text-sm text-muted-foreground">{description}</p>
              </div>
              <div className="flex gap-2">
                {provider === "waitrose" ? (
                  <Button
                    variant="outline"
                    disabled={Boolean(busy)}
                    onClick={() => void navigate({ search: { waitrose: "project" } })}
                  >
                    Sign in to Waitrose
                  </Button>
                ) : provider === "cloudflare" ? null : (
                  <Button
                    variant="outline"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void navigate({
                        search: { own: provider, connection: freshConnectionName() },
                      })
                    }
                  >
                    Use your own app
                  </Button>
                )}
                {provider !== "waitrose" && info.iterateAppProviders.includes(provider) && (
                  <ConnectButton
                    provider={provider}
                    disabled={Boolean(busy)}
                    connect={connectOn("project")}
                    onError={(caught) =>
                      setError(caught instanceof Error ? caught.message : String(caught))
                    }
                  />
                )}
              </div>
            </div>
            {!live.value ? null : connections.length === 0 &&
              !borrowed.some((row) => row.integration.provider === provider) ? (
              <p className="text-sm text-muted-foreground">No {noun}s connected.</p>
            ) : (
              <ul className="flex flex-col divide-y border-y">
                {borrowed
                  .filter((row) => row.integration.provider === provider)
                  .map((row) => (
                    <li
                      key={row.path}
                      className="flex flex-wrap items-center justify-between gap-2 py-3"
                    >
                      <div className="flex flex-col">
                        <span className="font-medium">{row.integration.account}</span>
                        <span className="text-xs text-muted-foreground">
                          Lent by {row.lender.email || "a member"} · <code>{row.path}</code>
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void run(`return:${row.path}`, () =>
                            api.projects.get(project.id).secrets.delete(row.path),
                          )
                        }
                      >
                        Return
                      </Button>
                    </li>
                  ))}
                {connections.map((row) => (
                  <ConnectionItem
                    key={row.connection}
                    row={row}
                    noun={noun}
                    busy={busy}
                    onDisconnect={() =>
                      run(`disconnect:${row.connection}`, () =>
                        projectFacet().invoke([
                          ["disconnectIntegration", { provider, connection: row.connection }],
                        ]),
                      )
                    }
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {lentByInstance.length > 0 && (
        <section className="flex flex-col gap-3" aria-labelledby="instance-heading">
          <div className="flex flex-col gap-1">
            <h2 id="instance-heading" className="text-lg font-semibold tracking-tight">
              Lent by this instance
            </h2>
            <p className="text-sm text-muted-foreground">
              Keys this deployment lends to this project. Agents use them by path; the key never
              leaves the deployment. Return one and this project stops using it.
            </p>
          </div>
          <ul className="flex flex-col divide-y border-y" aria-label="Lent by this instance">
            {lentByInstance.map((path) => (
              <li key={path} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <code className="text-sm">{path}</code>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run(`return:${path}`, () =>
                      api.projects.get(project.id).secrets.delete(path),
                    )
                  }
                >
                  Return
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {person || personStub.pending ? (
        <section className="flex flex-col gap-3" aria-labelledby="yours-heading">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 id="yours-heading" className="text-lg font-semibold tracking-tight">
                Your connections
              </h2>
              <p className="text-sm text-muted-foreground">
                Yours alone: signing in with Google, Cloudflare or GitHub keeps one, and so does
                connecting Waitrose. Lend one to this project and its agents use it; the token or
                password never leaves you.
              </p>
            </div>
            <div className="flex gap-2">
              {(["google", "cloudflare"] as const)
                .filter((provider) => info.iterateAppProviders.includes(provider))
                .map((provider) => (
                  <ConnectButton
                    key={provider}
                    provider={provider}
                    variant="outline"
                    disabled={Boolean(busy)}
                    connect={connectOn("person")}
                    onError={(caught) =>
                      setError(caught instanceof Error ? caught.message : String(caught))
                    }
                  >
                    Connect your {provider === "google" ? "Google" : "Cloudflare"}
                  </ConnectButton>
                ))}
              <Button
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => void navigate({ search: { waitrose: "person" } })}
              >
                Connect your Waitrose
              </Button>
            </div>
          </div>
          {!personLive.value ? (
            <p className="text-sm text-muted-foreground">Loading your connections…</p>
          ) : personal.length === 0 ? (
            <p className="text-sm text-muted-foreground">No connections of your own yet.</p>
          ) : (
            <ul className="flex flex-col divide-y border-y" aria-label="Your connections">
              {personal.map((row) => (
                <li
                  key={`${row.provider}-${row.connection}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-3"
                >
                  <div className="flex flex-col">
                    <span className="font-medium">{row.account}</span>
                    <span className="text-xs text-muted-foreground">
                      {PROVIDERS.find((known) => known.provider === row.provider)?.title}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void navigate({
                        search: { lend: `/secrets/${row.provider}-${row.connection}` },
                      })
                    }
                  >
                    Lend to this project
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      <Sheet
        open={Boolean(lendRow)}
        onOpenChange={(open) => !open && !busy && void navigate({ search: {}, replace: true })}
      >
        <SheetContent
          side="right"
          showCloseButton={!busy}
          initialFocus={firstField}
          className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          {lendRow && (
            <LendForm
              key={search.lend}
              row={lendRow}
              lendTo={search.lendTo}
              projectSlug={project.slug}
              firstField={firstField}
              pending={busy === "lend"}
              error={error}
              onSubmit={(as) =>
                run("lend", async () => {
                  await api.user.secrets.lend(search.lend!, { to: project.id, as });
                  setBusy(null);
                  await navigate({ search: {}, replace: true });
                })
              }
            />
          )}
        </SheetContent>
      </Sheet>
      <Sheet
        open={Boolean(search.request) && search.then !== "lend"}
        onOpenChange={(open) => !open && void navigate({ search: {}, replace: true })}
      >
        <SheetContent
          side="right"
          className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          {search.request && (
            <div className="flex h-full flex-col">
              <SheetHeader className="border-b">
                <SheetTitle>Connect your {search.request} account</SheetTitle>
                <SheetDescription>
                  An agent in {project.slug} asks to use your {search.request} account
                  {search.scopes ? ` (${search.scopes})` : ""}. Connect it, then lend it to this
                  project: the agent uses it, and the token stays yours.
                </SheetDescription>
              </SheetHeader>
              {error && (
                <p role="alert" data-type="error" className="p-4 text-sm text-destructive">
                  {error}
                </p>
              )}
              <SheetFooter className="mt-auto border-t sm:flex-row sm:justify-end">
                <SheetClose render={<Button type="button" variant="outline" />}>Cancel</SheetClose>
                <ConnectButton
                  provider={search.request}
                  scopes={search.scopes?.split(" ").filter(Boolean)}
                  connect={(input) => {
                    // named here, as itx.integrations.connect names it (the person's one
                    // connection of the provider, else a new one), so the way back lends this one
                    const held = personal.filter((row) => row.provider === input.provider);
                    const connection =
                      held.length === 1 ? held[0]!.connection : crypto.randomUUID().slice(0, 8);
                    return connectOn(
                      "person",
                      `${here}?${new URLSearchParams({ request: input.provider, connection, then: "lend", lendTo: search.lendTo || "" })}`,
                    )({ ...input, connection });
                  }}
                  onError={(caught) =>
                    setError(caught instanceof Error ? caught.message : String(caught))
                  }
                />
              </SheetFooter>
            </div>
          )}
        </SheetContent>
      </Sheet>
      <Sheet
        open={Boolean(search.waitrose)}
        onOpenChange={(open) => !open && !busy && void navigate({ search: {}, replace: true })}
      >
        <SheetContent
          side="right"
          showCloseButton={!busy}
          initialFocus={firstField}
          className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          {search.waitrose && (
            <WaitroseForm
              owner={search.waitrose === "project" ? project.slug : "your own account"}
              firstField={firstField}
              pending={busy === "waitrose"}
              error={error}
              onSubmit={({ username, password }) =>
                run("waitrose", async () => {
                  const owner =
                    search.waitrose === "project" ? api.projects.get(project.id) : api.user;
                  const connection = freshConnectionName();
                  const secretPath = `/secrets/waitrose-${connection}`;
                  await owner.secrets.set(
                    secretPath,
                    { username, password },
                    {
                      urls: [new URL(WAITROSE_GRAPHQL_URL).origin],
                      refresh: { kind: "waitrose-session", graphqlUrl: WAITROSE_GRAPHQL_URL },
                    },
                  );
                  await owner.facets
                    .get(search.waitrose === "project" ? "project" : "account")
                    .invoke([["connectWaitrose", { connection, account: username }]])
                    .catch(async (caught: unknown) => {
                      await owner.secrets.delete(secretPath).catch(() => {});
                      throw caught;
                    });
                  setBusy(null);
                  await navigate({ search: {}, replace: true });
                })
              }
            />
          )}
        </SheetContent>
      </Sheet>
      <Sheet
        open={Boolean(own)}
        onOpenChange={(open) => !open && !busy && void navigate({ search: {}, replace: true })}
      >
        <SheetContent
          side="right"
          showCloseButton={!busy}
          initialFocus={firstField}
          className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          {own && (
            <OwnAppForm
              key={own.connection}
              ownApp={ownAppOf(own.provider, info.platformOrigin, project.id, own.connection)}
              firstField={firstField}
              pending={busy === "own"}
              error={error}
              onSubmit={({ appSlug, ...credentials }) =>
                run("own", async () => {
                  const { pin } = ownAppOf(
                    own.provider,
                    info.platformOrigin,
                    project.id,
                    own.connection,
                  );
                  const secrets = () => api.projects.get(project.id).secrets;
                  const secretPath = `/secrets/${own.provider}-${own.connection}`;
                  await secrets().set(secretPath, credentials, { urls: pin });
                  await connect({
                    ...own,
                    client: "project",
                    ...(own.provider === "github" && {
                      appSlug: appSlug || "",
                      clientId: credentials.clientId || "",
                    }),
                  }).catch(async (caught: unknown) => {
                    // a new connection's secret goes with its failed connect; a connected one's stays
                    if (
                      !rows.some(
                        (row) => row.provider === own.provider && row.connection === own.connection,
                      )
                    )
                      await secrets()
                        .delete(secretPath)
                        .catch(() => {});
                    throw caught;
                  });
                })
              }
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** A new connection's name: short and random. It names the connection's secret
 *  (`/secrets/<provider>-<name>`) and a project app's webhook URL for life. */
function freshConnectionName() {
  return crypto.randomUUID().slice(0, 8);
}

function ConnectionItem({
  row,
  noun,
  busy,
  onDisconnect,
}: {
  row: z.infer<typeof IntegrationsLive>["integrations"][string];
  noun: string;
  busy: string | null;
  onDisconnect: () => Promise<void>;
}) {
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-2 py-3"
      data-connection={row.connection}
    >
      <div className="flex flex-col">
        <span className="font-medium">{row.account}</span>
        <span className="text-xs text-muted-foreground">
          Connected ·{" "}
          {row.provider === "waitrose"
            ? "username and password"
            : row.client === "iterate"
              ? "iterate's app"
              : "your own app"}
        </span>
      </div>
      <AlertDialog>
        <AlertDialogTrigger
          render={<Button variant="outline" size="sm" />}
          disabled={Boolean(busy)}
        >
          {busy === `disconnect:${row.connection}` ? "Disconnecting…" : "Disconnect"}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {row.account}?</AlertDialogTitle>
            <AlertDialogDescription>
              The token is revoked and deleted, and events from this {noun} stop arriving. You can
              connect it again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onDisconnect()}>Disconnect</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** What connecting with your own app takes, per provider: the URLs to paste into its console, the
 *  credentials the connection's secret holds, and the origins that secret is pinned to. */
function ownAppOf(
  provider: OwnAppProvider,
  platformOrigin: string,
  projectId: string,
  connection: string,
) {
  const callback = {
    label: "Redirect URL",
    value: `${platformOrigin}/api/integrations/${provider}/callback`,
    hint: "Where the provider sends the human back after consent.",
  };
  const webhook = {
    label: "Webhook URL",
    value: `${platformOrigin}/api/integrations/${provider}/webhook/${projectId}/${connection}`,
    hint: "Where the provider posts events for this connection.",
  };
  const secret = (name: string, label: string) => ({ name, label });
  switch (provider) {
    case "slack":
      return {
        title: "Slack",
        console:
          "Create an app at api.slack.com/apps; the webhook URL is Event Subscriptions' Request URL and the interactivity URL is Interactivity & Shortcuts' Request URL (Slack checks the first, so add it once connected).",
        urls: [
          callback,
          webhook,
          {
            label: "Interactivity URL",
            value: `${platformOrigin}/api/integrations/slack/interactivity-webhook/${projectId}/${connection}`,
            hint: "Where Slack posts button clicks and shortcuts for this connection.",
          },
        ],
        fields: [
          secret("clientId", "Client ID"),
          secret("clientSecret", "Client Secret"),
          secret("signingSecret", "Signing Secret"),
        ],
        pin: ["https://slack.com"],
      };
    case "google":
      return {
        title: "Google",
        console:
          "Create an OAuth client (Web application) in Google Cloud Console and add the redirect URL as an authorized redirect URI.",
        urls: [callback],
        fields: [secret("clientId", "Client ID"), secret("clientSecret", "Client secret")],
        pin: ["https://oauth2.googleapis.com"],
      };
    case "github":
      return {
        title: "GitHub",
        console:
          "Create a GitHub App: the redirect URL is its Callback URL, with “Request user authorization (OAuth) during installation” ticked; add the webhook URL and secret.",
        urls: [callback, webhook],
        fields: [
          secret("appId", "App ID"),
          secret("appSlug", "App slug (github.com/apps/<slug>)"),
          secret("clientId", "Client ID"),
          secret("clientSecret", "Client secret"),
          { ...secret("privateKey", "Private key (.pem)"), multiline: true },
          secret("webhookSecret", "Webhook secret"),
        ],
        pin: ["https://github.com", "https://api.github.com"],
      };
  }
}

function OwnAppForm({
  ownApp,
  firstField,
  pending,
  error,
  onSubmit,
}: {
  ownApp: ReturnType<typeof ownAppOf>;
  firstField: RefObject<HTMLInputElement | null>;
  pending: boolean;
  error: string | null;
  onSubmit: (credentials: Record<string, string>) => Promise<void>;
}) {
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit(credentials);
  };
  return (
    <form onSubmit={submit} className="flex h-full flex-col">
      <SheetHeader className="border-b">
        <SheetTitle>Connect {ownApp.title} with your own app</SheetTitle>
        <SheetDescription>{ownApp.console}</SheetDescription>
      </SheetHeader>
      <FieldGroup className="flex-1 p-4">
        {ownApp.urls.map((url) => (
          <div key={url.label} className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{url.label}</span>
            <div className="flex items-start justify-between gap-2">
              <code className="text-xs break-all">{url.value}</code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Copy ${url.label}`}
                onClick={() => void navigator.clipboard.writeText(url.value)}
              >
                Copy
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">{url.hint}</p>
          </div>
        ))}
        {ownApp.fields.map((field, index) => {
          const props = {
            id: `own-app-${field.name}`,
            value: credentials[field.name] || "",
            autoComplete: "off",
            spellCheck: false,
            required: true,
            className: "font-mono",
          };
          const set = (value: string) => setCredentials({ ...credentials, [field.name]: value });
          return (
            <Field key={field.name}>
              <FieldLabel htmlFor={props.id}>{field.label}</FieldLabel>
              {"multiline" in field ? (
                <Textarea {...props} rows={5} onChange={(event) => set(event.target.value)} />
              ) : (
                <Input
                  {...props}
                  ref={index === 0 ? firstField : undefined}
                  onChange={(event) => set(event.target.value.trim())}
                />
              )}
            </Field>
          );
        })}
        {error && (
          <p role="alert" data-type="error" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </FieldGroup>
      <SheetFooter className="border-t sm:flex-row sm:justify-end">
        <SheetClose disabled={pending} render={<Button type="button" variant="outline" />}>
          Cancel
        </SheetClose>
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Continue to {ownApp.title}
        </Button>
      </SheetFooter>
    </form>
  );
}

/** Waitrose's username and password, for the connection's secret. They go to the secret alone:
 *  the platform logs in with them on first use and whenever Waitrose answers 401. */
function WaitroseForm({
  owner,
  firstField,
  pending,
  error,
  onSubmit,
}: {
  owner: string;
  firstField: RefObject<HTMLInputElement | null>;
  pending: boolean;
  error: string | null;
  onSubmit: (credentials: { username: string; password: string }) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit({ username, password });
  };
  return (
    <form onSubmit={submit} className="flex h-full flex-col">
      <SheetHeader className="border-b">
        <SheetTitle>Connect Waitrose to {owner}</SheetTitle>
        <SheetDescription>
          The password is kept in a secret that only ever sends it to waitrose.com, to sign in when
          a session runs out. No one reads it back, agents included.
        </SheetDescription>
      </SheetHeader>
      <FieldGroup className="flex-1 p-4">
        <Field>
          <FieldLabel htmlFor="waitrose-username">Email</FieldLabel>
          <Input
            id="waitrose-username"
            ref={firstField}
            type="email"
            autoComplete="off"
            required
            value={username}
            onChange={(event) => setUsername(event.target.value.trim())}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="waitrose-password">Password</FieldLabel>
          <SecretInput
            id="waitrose-password"
            type="password"
            autoComplete="off"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" data-type="error" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </FieldGroup>
      <SheetFooter className="border-t sm:flex-row sm:justify-end">
        <SheetClose disabled={pending} render={<Button type="button" variant="outline" />}>
          Cancel
        </SheetClose>
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Connect
        </Button>
      </SheetFooter>
    </form>
  );
}

/** Lend one of the person's connections to this project, as the path its code spells. */
function LendForm({
  row,
  lendTo,
  projectSlug,
  firstField,
  pending,
  error,
  onSubmit,
}: {
  row: Connection;
  /** The path an agent asked for, if one did. */
  lendTo?: string;
  projectSlug: string;
  firstField: RefObject<HTMLInputElement | null>;
  pending: boolean;
  error: string | null;
  onSubmit: (as: string) => Promise<void>;
}) {
  const [name, setName] = useState(
    lendTo?.replace(/^\/secrets\//, "") ||
      `${row.provider}-${row.account
        .split("@")[0]!
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "-")}`,
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit(`/secrets/${name}`);
  };
  return (
    <form onSubmit={submit} className="flex h-full flex-col">
      <SheetHeader className="border-b">
        <SheetTitle>
          Lend {row.account} to {projectSlug}
        </SheetTitle>
        <SheetDescription>
          The project's code uses it as <code>getSecret("/secrets/{name}")</code>. Every use runs
          through your connection, which stays yours: revoke it any time, and it ends when you leave
          the project.
        </SheetDescription>
      </SheetHeader>
      <FieldGroup className="flex-1 p-4">
        <Field>
          <FieldLabel htmlFor="lend-as">Secret name in this project</FieldLabel>
          <Input
            id="lend-as"
            ref={firstField}
            value={name}
            required
            pattern="[a-zA-Z0-9._-]+"
            className="font-mono"
            onChange={(event) => setName(event.target.value.trim())}
          />
        </Field>
        {error && (
          <p role="alert" data-type="error" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </FieldGroup>
      <SheetFooter className="border-t sm:flex-row sm:justify-end">
        <SheetClose disabled={pending} render={<Button type="button" variant="outline" />}>
          Cancel
        </SheetClose>
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Lend
        </Button>
      </SheetFooter>
    </form>
  );
}
