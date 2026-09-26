// /projects/<slug>/integrations — the project's connections (the `project` facet's live state on
// `/`), each provider's Connect sheet and the forms it leads to. The flows themselves — a person's own
// account, iterate's app or your own, Waitrose's login, a GitHub installation's move — are apps/os
// README "Integrations" and "Sign-in keeps tokens". The sheet is one URL: `?connect=<provider>`
// (`&scopes=` from an agent's `requestFromUser`), `?own=<provider>&connection=<name>`, `?waitrose=1`,
// `?move=<offer>`.
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Blocks, CheckIcon, CopyIcon, ShoppingBasket } from "lucide-react";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
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
import { errorCode } from "iterate/lib";
import { useContextStub, useFacetLiveState } from "iterate/react";
import { httpOriginOf } from "../../../../lib/origins.ts";
import { stepUpUrl } from "../../../../lib/scopes.ts";
import { addGithubSignInHref } from "../../../../lib/origins.ts";

const Provider = z.enum(["slack", "google", "cloudflare", "github", "waitrose"]);
type Provider = z.infer<typeof Provider>;
/** The providers connected through a consent (every one but Waitrose). */
const ConsentProvider = Provider.exclude(["waitrose"]);
type ConsentProvider = z.infer<typeof ConsentProvider>;
/** The providers with a project-app mode ("Your own app"). */
const OwnAppProvider = z.enum(["slack", "google", "github"]);
type OwnAppProvider = z.infer<typeof OwnAppProvider>;

const Connection = z.object({
  provider: Provider,
  connection: z.string(),
  /** Which OAuth app: iterate's, or the project's own. */
  client: z.enum(["iterate", "project"]),
  account: z.string(),
  externalId: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  /** A member's own account, used by the project: whose. */
  ownerUserId: z.string().optional(),
  ownerEmail: z.string().optional(),
});
type Connection = z.infer<typeof Connection>;

/** The project's connections and the deployment's keys shared with it; a person's own connections
 *  (the account's state has the same `integrations`). */
const IntegrationsLive = z.looseObject({
  integrations: z.record(z.string(), Connection).default({}),
  secrets: z
    .record(
      z.string(),
      z.looseObject({
        borrowed: z
          .object({ lender: z.object({ instance: z.literal(true).optional() }).loose() })
          .optional(),
      }),
    )
    .default({}),
});

const PROVIDERS = [
  { provider: "slack", title: "Slack", noun: "workspace" },
  { provider: "google", title: "Google", noun: "account" },
  { provider: "cloudflare", title: "Cloudflare", noun: "account" },
  { provider: "github", title: "GitHub", noun: "account" },
  { provider: "waitrose", title: "Waitrose", noun: "account" },
] as const;

/** The providers a person has an account of their own with by signing in (apps/os identity.ts). */
const SIGN_IN_PROVIDERS: readonly Provider[] = ["google", "cloudflare", "github"];

/** Where Waitrose logs in (apps/os/src/integrations/waitrose.ts): the connection's secret's pin. */
const WAITROSE_GRAPHQL_URL = "https://www.waitrose.com/api/graphql";

export const Route = createFileRoute("/_auth/projects/$slug/integrations")({
  validateSearch: z.object({
    /** The Connect sheet of one provider — an agent's ask (`itx.integrations.requestFromUser`) too. */
    connect: Provider.optional().catch(undefined),
    /** What an agent's ask needs beyond iterate's app's own scopes, space-separated. */
    scopes: z.string().optional().catch(undefined),
    own: OwnAppProvider.optional().catch(undefined),
    connection: z.string().optional().catch(undefined),
    /** Another Waitrose account, signed in with a username and password. */
    waitrose: z.literal(1).optional().catch(undefined),
    /** GitHub's callback's offer to move an installation another project holds here (signed by the
     *  platform, apps/os integrations/github.ts `GithubMoveOffer`). */
    move: z.string().optional().catch(undefined),
    /** Another service: how to connect one this page has no row for. */
    other: z.literal(1).optional().catch(undefined),
    /** Why the issuer refused to add a GitHub sign-in (apps/os identity.ts, "ADD A SIGN-IN"). */
    error: z.string().optional().catch(undefined),
  }),
  staticData: { page: "Integrations" },
  head: ({ params }) => ({ meta: [{ title: `Integrations · ${params.slug} · Dash` }] }),
  component: ProjectIntegrations,
});

/** A provider's mark, beside its name. */
function ProviderLogo({ provider }: { provider: Provider }) {
  if (provider === "waitrose")
    return <ShoppingBasket aria-hidden="true" className="size-5 text-muted-foreground" />;
  return <img src={`/logos/${provider}.svg`} alt="" aria-hidden="true" className="size-5" />;
}

function ProjectIntegrations() {
  const { api, info, project } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const context = useContextStub(() => api.projects.get(project.id), [api, project.id]).stub;
  const live = useFacetLiveState(context, "project");
  const projectState = IntegrationsLive.safeParse(live.value).data;
  const rows = Object.values(projectState?.integrations ?? {});
  const fromDeployment = Object.entries(projectState?.secrets ?? {}).flatMap(([path, row]) =>
    row.borrowed?.lender.instance ? [path] : [],
  );
  // the person's own accounts: a session without `account` (a device's key) offers none
  const personStub = useContextStub(
    info.scopes.includes("account") ? () => Promise.resolve(api.user) : null,
    [api, info.scopes],
  );
  const personLive = useFacetLiveState(personStub.stub, "account");
  const yourAccounts = Object.values(
    IntegrationsLive.safeParse(personLive.value).data?.integrations ?? {},
  );
  const yourAccountsStatus = !info.scopes.includes("account")
    ? "no-access"
    : personStub.error || personLive.error
      ? "failed"
      : personLive.value
        ? "loaded"
        : "loading";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The account whose Use last failed and what its row says: a refusal's own words (it is meant for
   *  the person, and trying again won't change it), else "try again" (the raw reason goes to the
   *  console). */
  const [failedUse, setFailedUse] = useState<{ connection: string; message: string } | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  const projectFacet = () => api.projects.get(project.id).facets.get("project");
  /** One verb at a time. A connect that leaves for the provider keeps its spinner up until the
   *  browser has gone. */
  const run = async (key: string, work: () => Promise<"leaving" | void>) => {
    setError(null);
    setBusy(key);
    try {
      if ((await work()) !== "leaving") setBusy(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(null);
    }
  };
  const closeSheet = () => navigate({ search: {}, replace: true });
  const here = `${window.location.origin}/projects/${project.slug}/integrations`;
  const askedScopes = search.scopes?.split(" ").filter(Boolean);
  /** `itx.integrations.connect` on the project: another account through iterate's app. */
  const connectAnother = async (input: { provider: ConsentProvider; scopes?: string[] }) =>
    z
      .object({ authorizationUrl: z.string().url() })
      .parse(
        await api.projects
          .get(project.id)
          .integrations.connect(input.provider, { scopes: input.scopes, next: here }),
      );
  /** One of the person's own accounts connected to this project: at once, or through the
   *  provider's consent for what it lacks, back here. */
  const connectYourAccount = async (row: Connection) => {
    setError(null);
    setFailedUse(null);
    setBusy(`use:${row.connection}`);
    try {
      const { authorizationUrl } = z
        .object({ authorizationUrl: z.string().url().optional() })
        .parse(
          await api.projects.get(project.id).integrations.connect(row.provider, {
            account: row.account,
            scopes: askedScopes,
            next: here,
          }),
        );
      if (authorizationUrl) {
        window.location.assign(authorizationUrl);
        return;
      }
      setBusy(null);
      await closeSheet();
    } catch (caught) {
      console.error("Connecting your account failed", caught);
      const refused = ["FORBIDDEN", "INVALID_INPUT"].includes(errorCode(caught) ?? "");
      setFailedUse({
        connection: row.connection,
        message:
          refused && caught instanceof Error ? caught.message : "Couldn't connect it. Try again.",
      });
      setBusy(null);
    }
  };
  const own =
    search.own && search.connection
      ? { provider: search.own, connection: search.connection }
      : null;
  const connecting = search.connect
    ? PROVIDERS.find((known) => known.provider === search.connect)!
    : null;
  const moveOffer = search.move ? moveOfferOf(search.move) : null;
  /** A verb the sheet must stay open for: every one but a Use, which may be left to finish. */
  const blocking = Boolean(busy) && !busy?.startsWith("use:");
  /** Whether the person has an account of their own for the provider being connected: the other
   *  way to connect is "another" account only then. */
  const hasYourOwn = Boolean(
    connecting && yourAccounts.some((row) => row.provider === connecting.provider),
  );
  /** Where the step-up to the `account` scope comes back to: this sheet, an agent's ask kept. */
  const stepUpParams = new URLSearchParams(connecting ? { connect: connecting.provider } : {});
  if (search.scopes) stepUpParams.set("scopes", search.scopes);
  const stepUpNext = `/projects/${project.slug}/integrations?${stepUpParams}`;
  /** "another", or the article the next word takes when the person has none of their own. */
  const another = (nextWord: string) =>
    hasYourOwn ? "another" : /^[aeiou]/i.test(nextWord) ? "an" : "a";

  /** Whether the Connect sheet offers one of the person's own accounts not connected here yet: its
   *  Use is then the sheet's one primary action, and connecting another account is secondary. */
  const offersYourOwn = Boolean(
    connecting &&
    yourAccounts.some(
      (row) =>
        row.provider === connecting.provider &&
        !rows.some((here) => Boolean(here.ownerUserId) && here.connection === row.connection),
    ),
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
      {error && !own && !connecting && !search.waitrose && !moveOffer && (
        <p role="alert" data-type="error" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {live.error ? (
        <p role="alert" data-type="error" className="text-sm text-destructive">
          Couldn't load this project's connections: {live.error}
        </p>
      ) : !live.value ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading…
        </p>
      ) : null}
      <div className="flex flex-col divide-y border-y">
        {PROVIDERS.map(({ provider, title, noun }) => {
          const connections = rows.filter((row) => row.provider === provider);
          return (
            <section key={provider} className="py-3" aria-labelledby={`${provider}-heading`}>
              <div className="flex items-center gap-3">
                <ProviderLogo provider={provider} />
                <h2 id={`${provider}-heading`} className="flex-1 font-medium">
                  {title}
                </h2>
                {Boolean(live.value) && connections.length === 0 && (
                  <span className="text-xs text-muted-foreground">Not connected</span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={
                    connections.length > 0 ? `Connect another ${title} ${noun}` : `Connect ${title}`
                  }
                  disabled={Boolean(busy)}
                  onClick={() => {
                    setError(null);
                    setFailedUse(null);
                    // Waitrose with no account of your own: the sign-in form is the only choice
                    const noneOfYours =
                      yourAccountsStatus !== "loading" &&
                      !yourAccounts.some((row) => row.provider === "waitrose");
                    void navigate({
                      search:
                        provider === "waitrose" && noneOfYours
                          ? { waitrose: 1 }
                          : { connect: provider },
                    });
                  }}
                >
                  {connections.length > 0 ? "Connect another" : "Connect"}
                </Button>
              </div>
              {connections.length > 0 && (
                <ul className="mt-1 flex flex-col pl-8" aria-label={`${title} connections`}>
                  {connections.map((row) => (
                    <ConnectionItem
                      key={row.connection}
                      row={row}
                      yours={row.ownerUserId === info.principal.actor}
                      noun={noun}
                      busy={busy}
                      onDisconnect={() =>
                        run(`disconnect:${row.connection}`, async () => {
                          await projectFacet().invoke([
                            ["disconnectIntegration", { provider, connection: row.connection }],
                          ]);
                        })
                      }
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
        <section className="py-3" aria-labelledby="other-heading">
          <div className="flex items-center gap-3">
            <Blocks aria-hidden="true" className="size-5 text-muted-foreground" />
            <h2 id="other-heading" className="flex-1 font-medium">
              Other services
            </h2>
            <Button
              variant="outline"
              size="sm"
              aria-label="Connect another service"
              disabled={Boolean(busy)}
              onClick={() => void navigate({ search: { other: 1 } })}
            >
              Connect
            </Button>
          </div>
        </section>
      </div>
      {fromDeployment.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="deployment-heading">
          <h2 id="deployment-heading" className="font-medium">
            Shared by this deployment
          </h2>
          <ul className="flex flex-col divide-y border-y" aria-label="Shared by this deployment">
            {fromDeployment.map((path) => (
              <li key={path} className="flex items-center gap-3 py-2">
                <code className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{path}</code>
                <AlertDialog>
                  <AlertDialogTrigger
                    render={<Button variant="ghost" size="sm" />}
                    disabled={Boolean(busy)}
                  >
                    {busy === `remove:${path}` ? <Spinner data-icon="inline-start" /> : null}
                    Remove
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove {path}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Agents here stop using it. Only this deployment's operator can share it
                        again.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        onClick={() =>
                          void run(`remove:${path}`, async () => {
                            await api.projects.get(project.id).secrets.delete(path);
                          })
                        }
                      >
                        Remove
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            ))}
          </ul>
        </section>
      )}
      {/* ONE sheet: the Connect picker, and the forms it leads to (your own app, Waitrose) */}
      <Sheet
        open={Boolean(connecting || own || search.waitrose || moveOffer || search.other)}
        onOpenChange={(open) => !open && !blocking && void closeSheet()}
      >
        <SheetContent
          side="right"
          showCloseButton={!blocking}
          initialFocus={own || search.waitrose ? firstField : undefined}
          className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          {moveOffer && (
            <MoveOffer
              offer={moveOffer}
              pending={busy === "move"}
              error={error}
              onConfirm={() =>
                run("move", async () => {
                  await projectFacet().invoke([["confirmGithubMove", { offer: search.move }]]);
                  await closeSheet();
                })
              }
            />
          )}
          {search.other && !connecting && !own && !search.waitrose && !moveOffer && (
            <OtherService
              projectSlug={project.slug}
              mcpServer={mcpServerOf(info)}
              platformOrigin={httpOriginOf(info.platformOrigin)}
            />
          )}
          {connecting && !own && !search.waitrose && !moveOffer && (
            <div className="flex h-full flex-col">
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <ProviderLogo provider={connecting.provider} />
                  {rows.some((row) => row.provider === connecting.provider)
                    ? `Connect another ${connecting.title} ${connecting.noun}`
                    : `Connect ${connecting.title}`}
                </SheetTitle>
                {askedScopes && (
                  <SheetDescription>
                    {accessLabelOf(askedScopes)
                      ? `An agent needs ${accessLabelOf(askedScopes)} access.`
                      : `An agent needs a ${connecting.title} ${connecting.noun}.`}
                  </SheetDescription>
                )}
              </SheetHeader>
              <div className="flex flex-1 flex-col gap-6 px-4 pb-4">
                {error && (
                  <p role="alert" data-type="error" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
                <YourAccounts
                  provider={connecting.provider}
                  status={yourAccountsStatus}
                  accounts={yourAccounts.filter((row) => row.provider === connecting.provider)}
                  connectedHere={rows}
                  askedScopes={
                    // only Google's and Cloudflare's consents add scopes to your own account
                    connecting.provider === "google" || connecting.provider === "cloudflare"
                      ? [
                          ...(info.iterateAppScopes[connecting.provider] || []),
                          ...(askedScopes || []),
                        ]
                      : []
                  }
                  busy={busy}
                  failedUse={failedUse}
                  stepUpNext={stepUpNext}
                  onUse={(row) => void connectYourAccount(row)}
                />
                {connecting.provider === "github" &&
                  info.iterateAppProviders.includes("github") && (
                    <GithubInstallations
                      person={personStub.stub}
                      personState={personLive.value}
                      connectedHere={rows}
                      busy={busy}
                      onConnect={(installationId) =>
                        void run(`install:${installationId}`, async () => {
                          const { authorizationUrl } = z
                            .object({ authorizationUrl: z.string().url() })
                            .parse(
                              await projectFacet().invoke([
                                [
                                  "connectIntegration",
                                  {
                                    provider: "github",
                                    connection: freshConnectionName(),
                                    client: "iterate",
                                    installationId,
                                    platformOrigin: info.platformOrigin,
                                    next: here,
                                  },
                                ],
                              ]),
                            );
                          window.location.assign(authorizationUrl);
                          return "leaving";
                        })
                      }
                    />
                  )}
                <div className="flex flex-col gap-2">
                  {connecting.provider === "waitrose" ? (
                    <Button
                      variant={offersYourOwn ? "outline" : "default"}
                      disabled={Boolean(busy)}
                      onClick={() => void navigate({ search: { waitrose: 1 }, replace: true })}
                    >
                      Sign in to {another("Waitrose")} Waitrose account
                    </Button>
                  ) : info.iterateAppProviders.includes(connecting.provider) ? (
                    <ConnectButton
                      provider={connecting.provider}
                      variant={offersYourOwn ? "outline" : "default"}
                      scopes={askedScopes}
                      disabled={Boolean(busy)}
                      connect={connectAnother}
                      onError={(caught) =>
                        setError(caught instanceof Error ? caught.message : String(caught))
                      }
                    >
                      {connecting.provider === "github"
                        ? `Install on ${another("GitHub")} GitHub account`
                        : `Connect ${another(connecting.title)} ${connecting.title} ${connecting.noun}`}
                    </ConnectButton>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      This deployment has no {connecting.title} app. Use your own.
                    </p>
                  )}
                  {OwnAppProvider.safeParse(connecting.provider).success && (
                    <Button
                      variant="ghost"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void navigate({
                          search: {
                            own: OwnAppProvider.parse(connecting.provider),
                            connection: freshConnectionName(),
                            scopes: search.scopes,
                          },
                          replace: true,
                        })
                      }
                    >
                      Use your own {connecting.title} app
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
          {search.waitrose && (
            <WaitroseForm
              onBack={
                yourAccounts.some((row) => row.provider === "waitrose")
                  ? () => void navigate({ search: { connect: "waitrose" }, replace: true })
                  : undefined
              }
              firstField={firstField}
              pending={busy === "waitrose"}
              error={error}
              onSubmit={({ username, password }) =>
                run("waitrose", async () => {
                  const owner = api.projects.get(project.id);
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
                    .get("project")
                    .invoke([["connectWaitrose", { connection, account: username }]])
                    .catch(async (caught: unknown) => {
                      await owner.secrets.delete(secretPath).catch(() => {});
                      throw caught;
                    });
                  await closeSheet();
                })
              }
            />
          )}
          {own && (
            <OwnAppForm
              key={own.connection}
              ownApp={ownAppOf(own.provider, info.platformOrigin, project.id, own.connection)}
              onBack={() =>
                void navigate({
                  search: { connect: own.provider, scopes: search.scopes },
                  replace: true,
                })
              }
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
                  try {
                    const { authorizationUrl } = z
                      .object({ authorizationUrl: z.string().url() })
                      .parse(
                        await projectFacet().invoke([
                          [
                            "connectIntegration",
                            {
                              ...own,
                              client: "project",
                              // an agent's ask rides through to the consent
                              scopes: askedScopes,
                              next: here,
                              ...(own.provider === "github" && {
                                appSlug: appSlug || "",
                                clientId: credentials.clientId || "",
                              }),
                            },
                          ],
                        ]),
                      );
                    window.location.assign(authorizationUrl);
                    return "leaving";
                  } catch (caught) {
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
                  }
                })
              }
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** Google's two spellings of its identity scopes, so a sign-in's `email` counts as the app's
 *  `userinfo.email` (apps/os/src/integrations/rules.ts `missingScopes` decides; this only words it). */
const GOOGLE_SCOPE_ALIASES: Record<string, string> = {
  email: "https://www.googleapis.com/auth/userinfo.email",
  profile: "https://www.googleapis.com/auth/userinfo.profile",
};

/** What a person recognises a scope as — Gmail, Calendar, Docs, Drive — or null for one they
 *  would not (the identity, a Cloudflare permission's name). */
function scopeLabelOf(scope: string) {
  if (scope.includes("/auth/gmail")) return "Gmail";
  if (scope.includes("/auth/calendar")) return "Calendar";
  if (scope.includes("/auth/documents")) return "Docs";
  if (scope.includes("/auth/drive")) return "Drive";
  return null;
}

/** The identity scopes a person does not read as access (Google's, OpenID's, Cloudflare's). */
const IDENTITY_SCOPES = new Set([
  "openid",
  "email",
  "profile",
  "offline_access",
  "user-details.read",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
]);

/** What access `scopes` name, as a person reads them: the labels (Gmail, Calendar…), else each
 *  scope's last part ("contacts.readonly"), the identity left out — or "" when nothing is left. */
function accessLabelOf(scopes: string[]) {
  return [
    ...new Set(
      scopes
        .filter((scope) => !IDENTITY_SCOPES.has(scope))
        .map((scope) => scopeLabelOf(scope) || scope.split("/").at(-1) || scope),
    ),
  ].join(", ");
}

/** What `granted` lacks of `asked`, as a person reads it ("Gmail access", "contacts.readonly
 *  access"), "more access" for identity scopes alone, or null (Google's identity aliases counted
 *  once). */
function missingAccessOf(provider: Provider, granted: string[], asked: string[]) {
  const spelled = (scope: string) =>
    provider === "google" ? GOOGLE_SCOPE_ALIASES[scope] || scope : scope;
  const held = new Set(granted.map(spelled));
  const missing = asked.filter((scope) => !held.has(spelled(scope)));
  if (missing.length === 0) return null;
  const label = accessLabelOf(missing);
  return label ? `${label} access` : "more access";
}

/** A small label over one of the Connect sheet's lists. */
function ListLabel({ children }: { children: string }) {
  return <p className="text-xs font-medium text-muted-foreground">{children}</p>;
}

/** THE ACCOUNTS YOU ALREADY HAVE for a provider, each one click away: connected here already (and
 *  complete), connected but lacking what the project needs ("Add …"), or ready ("Use"). None, and
 *  the sheet says nothing about them. */
function YourAccounts({
  provider,
  status,
  accounts,
  connectedHere,
  askedScopes,
  busy,
  failedUse,
  stepUpNext,
  onUse,
}: {
  provider: Provider;
  status: "no-access" | "loading" | "failed" | "loaded";
  accounts: Connection[];
  connectedHere: Connection[];
  askedScopes: string[];
  busy: string | null;
  /** The account whose Use failed last. */
  failedUse: { connection: string; message: string } | null;
  /** Where the step-up to the `account` scope comes back to. */
  stepUpNext: string;
  onUse: (row: Connection) => void;
}) {
  const title = PROVIDERS.find((known) => known.provider === provider)!.title;
  if (status === "no-access")
    // only a sign-in provider has accounts of yours worth stepping up for
    return SIGN_IN_PROVIDERS.includes(provider) ? (
      <p className="text-sm text-muted-foreground">
        <a href={stepUpUrl(stepUpNext)} className="underline underline-offset-4">
          Show your {title} accounts
        </a>
      </p>
    ) : null;
  if (status === "loading")
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Your accounts
      </p>
    );
  if (status === "failed")
    return (
      <p role="alert" data-type="error" className="text-sm text-destructive">
        Couldn't load your accounts. Reload to try again.
      </p>
    );
  if (accounts.length === 0) return null;
  const connected = (row: Connection) =>
    connectedHere.some(
      (here) =>
        here.provider === row.provider &&
        Boolean(here.ownerUserId) &&
        here.connection === row.connection,
    );
  // one primary per sheet: the first account not connected here yet
  const primary = accounts.find((row) => !connected(row));
  return (
    <div className="flex flex-col gap-1">
      <ListLabel>Your accounts</ListLabel>
      <ul className="flex flex-col divide-y" aria-label="Your accounts">
        {accounts.map((row) => {
          const here = connected(row);
          const missing = missingAccessOf(provider, row.scopes || [], askedScopes);
          const meta = missing
            ? `${title} asks for ${missing}`
            : provider === "github" && !here
              ? "Acts as you"
              : null;
          return (
            <li key={row.connection} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="[overflow-wrap:anywhere]">{row.account}</p>
                {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
                {failedUse?.connection === row.connection && (
                  <p role="alert" data-type="error" className="text-xs text-destructive">
                    {failedUse.message}
                  </p>
                )}
              </div>
              {here && !missing ? (
                <span className="text-xs text-muted-foreground">Connected</span>
              ) : (
                <Button
                  size="sm"
                  variant={row === primary ? "default" : "outline"}
                  aria-label={here ? `Add ${missing} to ${row.account}` : `Use ${row.account}`}
                  disabled={Boolean(busy)}
                  onClick={() => onUse(row)}
                >
                  {busy === `use:${row.connection}` ? <Spinner data-icon="inline-start" /> : null}
                  {here ? "Add access" : "Use"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One of the project's connections: its account, whose it is and what it holds, and Disconnect —
 *  which, for a member's account, takes it out of this project alone. */
function ConnectionItem({
  row,
  yours,
  noun,
  busy,
  onDisconnect,
}: {
  row: Connection;
  yours: boolean;
  noun: string;
  busy: string | null;
  onDisconnect: () => Promise<void>;
}) {
  const whose = row.ownerUserId ? (yours ? "Yours" : `${row.ownerEmail || "A member"}'s`) : null;
  const detail =
    row.client === "project"
      ? "Your own app"
      : [...new Set((row.scopes || []).flatMap((scope) => scopeLabelOf(scope) || []))].join(", ");
  const meta = [whose, detail].filter(Boolean).join(" · ");
  return (
    <li className="flex items-center gap-3 py-2" data-connection={row.connection}>
      <div className="min-w-0 flex-1">
        <p className="text-sm [overflow-wrap:anywhere]">{row.account}</p>
        {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
      </div>
      <AlertDialog>
        <AlertDialogTrigger render={<Button variant="ghost" size="sm" />} disabled={Boolean(busy)}>
          {busy === `disconnect:${row.connection}` ? <Spinner data-icon="inline-start" /> : null}
          Disconnect
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {row.account}?</AlertDialogTitle>
            <AlertDialogDescription>
              {row.ownerUserId
                ? `Agents here stop using it. It stays connected to ${yours ? "you" : "its owner"}.`
                : row.provider === "waitrose"
                  ? "Its username and password are deleted, and agents here stop using it."
                  : row.provider === "slack" || row.provider === "github"
                    ? `Its token is deleted and events from this ${noun} stop.`
                    : "Its token is deleted."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void onDisconnect()}>
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** A new connection's name: short and random. It names the connection's secret
 *  (`/secrets/<provider>-<name>`) and a project app's webhook URL for life. */
function freshConnectionName() {
  return crypto.randomUUID().slice(0, 8);
}

/** What connecting with your own app takes, per provider: the URLs to paste into its console, the
 *  credentials the connection's secret holds, and the origins that secret is pinned to. */
function ownAppOf(
  provider: OwnAppProvider,
  platformOrigin: string,
  projectId: string,
  connection: string,
) {
  const callback = (hint: string) => ({
    label: "Redirect URL",
    value: `${platformOrigin}/api/integrations/${provider}/callback`,
    hint,
  });
  const webhook = (hint: string) => ({
    label: "Webhook URL",
    value: `${platformOrigin}/api/integrations/${provider}/webhook/${projectId}/${connection}`,
    hint,
  });
  const secret = (name: string, label: string) => ({ name, label });
  switch (provider) {
    case "slack":
      return {
        title: "Slack",
        console: "An app you create at api.slack.com/apps.",
        urls: [
          callback("OAuth & Permissions → Redirect URLs."),
          webhook("Event Subscriptions → Request URL. Slack checks it, so add it once connected."),
          {
            label: "Interactivity URL",
            value: `${platformOrigin}/api/integrations/slack/interactivity-webhook/${projectId}/${connection}`,
            hint: "Interactivity & Shortcuts → Request URL.",
          },
        ],
        fields: [
          secret("clientId", "Client ID"),
          secret("clientSecret", "Client Secret"),
          secret("signingSecret", "Signing Secret"),
        ],
        // the connection's whole pin up front (slack.com first: the connect reads it as the origin)
        pin: ["https://slack.com", "https://files.slack.com"],
      };
    case "google":
      return {
        title: "Google",
        console: "An OAuth client (Web application) you create in Google Cloud Console.",
        urls: [callback("The client's Authorized redirect URIs.")],
        fields: [secret("clientId", "Client ID"), secret("clientSecret", "Client secret")],
        // the connection's whole pin up front (the token origin first: the connect reads it as the origin)
        pin: [
          "https://oauth2.googleapis.com",
          "https://www.googleapis.com",
          "https://gmail.googleapis.com",
          "https://docs.googleapis.com",
        ],
      };
    case "github":
      return {
        title: "GitHub",
        console: "A GitHub App you create under Developer settings.",
        urls: [
          callback(
            "The App's Callback URL, with “Request user authorization (OAuth) during installation” ticked.",
          ),
          webhook("The App's Webhook URL, with the webhook secret below."),
        ],
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
  onBack,
  firstField,
  pending,
  error,
  onSubmit,
}: {
  ownApp: ReturnType<typeof ownAppOf>;
  /** Back to the Connect sheet it came from. */
  onBack: () => void;
  firstField: RefObject<HTMLInputElement | null>;
  pending: boolean;
  error: string | null;
  onSubmit: (credentials: Record<string, string>) => Promise<void>;
}) {
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit(credentials);
  };
  return (
    <form onSubmit={submit} className="flex h-full flex-col">
      <SheetHeader>
        <SheetTitle>Your own {ownApp.title} app</SheetTitle>
        <SheetDescription>{ownApp.console}</SheetDescription>
      </SheetHeader>
      <FieldGroup className="flex-1 px-4 pb-4">
        {ownApp.urls.map((url) => (
          <Field key={url.label}>
            <FieldLabel>{url.label}</FieldLabel>
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1.5 text-xs break-all">
                {url.value}
              </code>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                title={copied === url.label ? "Copied" : `Copy ${url.label}`}
                onClick={() =>
                  void navigator.clipboard.writeText(url.value).then(() => setCopied(url.label))
                }
              >
                {copied === url.label ? <CheckIcon /> : <CopyIcon />}
              </Button>
            </div>
            <FieldDescription>{url.hint}</FieldDescription>
          </Field>
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
        <Button type="button" variant="ghost" disabled={pending} onClick={onBack}>
          Back
        </Button>
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
  onBack,
  firstField,
  pending,
  error,
  onSubmit,
}: {
  /** Back to the Connect sheet, when there is one to go back to. */
  onBack?: () => void;
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
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <ProviderLogo provider="waitrose" />
          Connect Waitrose
        </SheetTitle>
        <SheetDescription>The password is only ever sent to waitrose.com.</SheetDescription>
      </SheetHeader>
      <FieldGroup className="flex-1 px-4 pb-4">
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
        {onBack && (
          <Button type="button" variant="ghost" disabled={pending} onClick={onBack}>
            Back
          </Button>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Connect
        </Button>
      </SheetFooter>
    </form>
  );
}

/** What the Dash reads of a move offer: the platform signed it, and the platform checks it again on
 *  the move; the page only words it. */
const MoveOfferShown = z.object({
  kind: z.literal("github-move"),
  account: z.string(),
  holderSlug: z.string().nullable(),
});

/** The offer's claims, off its signed token (base64url JSON before the signature), or null. */
function moveOfferOf(token: string) {
  try {
    const payload = token.split(".")[0]!.replaceAll("-", "+").replaceAll("_", "/");
    return MoveOfferShown.parse(JSON.parse(atob(payload)));
  } catch {
    return null;
  }
}

/** THE MOVE: an installation another project holds, which the person proved they administer — one
 *  sentence on what the other project loses, one button. */
function MoveOffer({
  offer,
  pending,
  error,
  onConfirm,
}: {
  offer: z.infer<typeof MoveOfferShown>;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <ProviderLogo provider="github" />
          Move {offer.account} here?
        </SheetTitle>
        <SheetDescription>
          {offer.account} is connected to {offer.holderSlug || "another project"}. Moving it here
          stops that project's GitHub access and events.
        </SheetDescription>
      </SheetHeader>
      {error && (
        <p role="alert" data-type="error" className="px-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <SheetFooter className="border-t sm:flex-row sm:justify-end">
        <SheetClose disabled={pending} render={<Button type="button" variant="outline" />}>
          Cancel
        </SheetClose>
        <Button variant="destructive" disabled={pending} onClick={onConfirm}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Move here
        </Button>
      </SheetFooter>
    </div>
  );
}

/** A GitHub installation as `GET /user/installations` answers it. */
const GithubInstallation = z.object({
  id: z.union([z.number(), z.string()]).transform(String),
  account: z.object({ login: z.string() }),
});

/** The person's own account state, as far as reaching their GitHub sign-in's token goes. */
const PersonGithub = z.looseObject({
  integrations: z.record(z.string(), z.object({ provider: z.string(), connection: z.string() })),
  secrets: z.record(z.string(), z.looseObject({ urls: z.array(z.string()) })),
});

/** WHERE iterate's GitHub App IS INSTALLED that the person reaches: `GET /user/installations` with
 *  their GitHub sign-in's token (a user token of iterate's App lists that App's installations),
 *  through their own egress. Each connects here without GitHub's configure page. */
function GithubInstallations({
  person,
  personState,
  connectedHere,
  busy,
  onConnect,
}: {
  person: { fetch(request: Request): Promise<Response> } | undefined;
  personState: unknown;
  connectedHere: Connection[];
  busy: string | null;
  onConnect: (installationId: string) => void;
}) {
  const state = PersonGithub.safeParse(personState).data;
  const signIn = Object.values(state?.integrations ?? {}).find((row) => row.provider === "github");
  const secretPath = signIn ? `/secrets/github-${signIn.connection}` : null;
  // the sign-in's secret is pinned to GitHub and its API: the API is the last origin
  const apiOrigin = secretPath ? state?.secrets[secretPath]?.urls.at(-1) : undefined;
  const [installations, setInstallations] = useState<
    z.infer<typeof GithubInstallation>[] | "loading" | "failed"
  >("loading");
  useEffect(() => {
    if (!person || !secretPath || !apiOrigin) return;
    let current = true;
    /** Every page of them (GitHub answers at most 100 a page). */
    const everyPage = async () => {
      const all: z.infer<typeof GithubInstallation>[] = [];
      for (let page = 1; ; page++) {
        const response = await person.fetch(
          new Request(`${apiOrigin}/user/installations?per_page=100&page=${page}`, {
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer getSecret("${secretPath}", { field: "accessToken" })`,
            },
          }),
        );
        if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
        const { installations } = z
          .object({ installations: z.array(GithubInstallation) })
          .parse(await response.json());
        all.push(...installations);
        if (installations.length < 100) return all;
      }
    };
    void everyPage()
      .then((installations) => current && setInstallations(installations))
      .catch(() => current && setInstallations("failed"));
    return () => {
      current = false;
    };
  }, [person, secretPath, apiOrigin]);
  const { info, project } = Route.useRouteContext();
  const { error } = Route.useSearch();
  // your account not read yet, or not readable by this session: "Your accounts" says which
  if (!state) return null;
  if (!secretPath || !apiOrigin) {
    // back to this sheet once the issuer has added it (or says why not)
    const addSignIn = info.signInProviders?.includes("github")
      ? addGithubSignInHref(
          info,
          `${window.location.origin}/projects/${project.slug}/integrations?connect=github`,
        )
      : null;
    return (
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">
          Your account has no GitHub sign-in, so where iterate's app is installed can't be listed.{" "}
          {addSignIn && (
            <a href={addSignIn} className="underline underline-offset-4">
              Add GitHub sign-in
            </a>
          )}
        </p>
        {error && (
          <p role="alert" data-type="error" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  }
  if (installations === "loading")
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Where iterate's app is installed
      </p>
    );
  if (installations === "failed")
    return (
      <p className="text-sm text-muted-foreground">
        Couldn't ask GitHub where iterate's app is installed.
      </p>
    );
  if (installations.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <ListLabel>iterate's app is installed on</ListLabel>
      <ul className="flex flex-col divide-y" aria-label="Where iterate's app is installed">
        {installations.map((installation) => {
          const here = connectedHere.some(
            (row) => row.provider === "github" && row.externalId === installation.id,
          );
          return (
            <li key={installation.id} className="flex items-center gap-3 py-2">
              <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {installation.account.login}
              </p>
              {here ? (
                <span className="text-xs text-muted-foreground">Connected</span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Connect ${installation.account.login}`}
                  disabled={Boolean(busy)}
                  onClick={() => onConnect(installation.id)}
                >
                  {busy === `install:${installation.id}` ? (
                    <Spinner data-icon="inline-start" />
                  ) : null}
                  Connect
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The project's MCP server, as the MCP page gives it: the deployment's own MCP origin, else `/mcp`
 *  on the platform's; null when the deployment reports neither as an http(s) origin. */
function mcpServerOf(info: { mcpOrigin: string; platformOrigin: string }) {
  const mcpOrigin = httpOriginOf(info.mcpOrigin);
  const platformOrigin = httpOriginOf(info.platformOrigin);
  return mcpOrigin ? `${mcpOrigin}/` : platformOrigin ? `${platformOrigin}/mcp` : null;
}

/** What a person pastes to their coding agent, once it reaches this project over MCP: connect
 *  `service` with the platform's own verbs, keys never in the chat. */
function agentPromptOf(service: string, projectSlug: string, platformOrigin: string | null) {
  const name = service.trim() || "<service>";
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "service";
  return [
    `Connect ${name} to my iterate project "${projectSlug}", using iterate's MCP server.`,
    `- API key: ask me for it with itx.secrets.collectFromUser({ path: "/secrets/${slug}", egress: { urls: [<${name}'s API origin>] } }) and send me the link, never in the chat.`,
    `- OAuth: tell me how to register an OAuth app${platformOrigin ? ` (redirect URL ${platformOrigin}/.secrets/oauth/callback)` : ""}, collect its client secret the same way, then send me the link from itx.secrets.beginOAuth("/secrets/${slug}", …).`,
    `- Put getSecret("/secrets/${slug}") wherever the key goes; the platform swaps the real key in on the way out.`,
    `- If ${name} has an MCP server or an OpenAPI document, use itx.connectToMcp(url, { headers }) or itx.connectToOpenApi(url, { headers }); else its npm SDK in the config repo.`,
    `Finish with one read-only call to ${name} that shows it works.`,
  ].join("\n");
}

/** ANOTHER SERVICE: the easiest way is the person's own coding agent, connected to this project over
 *  MCP and asked to connect it; the ways it would use are listed below for doing it by hand. */
function OtherService({
  projectSlug,
  mcpServer,
  platformOrigin,
}: {
  projectSlug: string;
  mcpServer: string | null;
  platformOrigin: string | null;
}) {
  const [service, setService] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const prompt = agentPromptOf(service, projectSlug, platformOrigin);
  const copy = (label: string, value: string) =>
    void navigator.clipboard.writeText(value).then(() => setCopied(label));
  return (
    <div className="flex h-full flex-col">
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <Blocks aria-hidden="true" className="size-5 text-muted-foreground" />
          Connect another service
        </SheetTitle>
        <SheetDescription>
          The easiest way: connect your coding agent to this project over MCP, then ask it to
          connect the service.
        </SheetDescription>
      </SheetHeader>
      <FieldGroup className="flex-1 px-4 pb-4">
        {mcpServer && (
          <Field>
            <FieldLabel>1. Add this project to Claude Code</FieldLabel>
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1.5 text-xs break-all">
                claude mcp add --transport http iterate {mcpServer}
              </code>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                title={copied === "mcp" ? "Copied" : "Copy the command"}
                onClick={() => copy("mcp", `claude mcp add --transport http iterate ${mcpServer}`)}
              >
                {copied === "mcp" ? <CheckIcon /> : <CopyIcon />}
              </Button>
            </div>
            <FieldDescription>
              Then run <code>/mcp</code> in Claude Code and sign in, ticking {projectSlug}. Other
              agents: the{" "}
              <Link
                to="/projects/$slug/mcp"
                params={{ slug: projectSlug }}
                className="underline underline-offset-4"
              >
                MCP page
              </Link>
              .
            </FieldDescription>
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="other-service">{mcpServer ? "2. " : ""}The service</FieldLabel>
          <Input
            id="other-service"
            placeholder="Linear, Stripe, Notion…"
            value={service}
            onChange={(event) => setService(event.target.value)}
          />
        </Field>
        <Field>
          <div className="flex items-center justify-between gap-2">
            <FieldLabel>{mcpServer ? "3. " : ""}Paste this to your agent</FieldLabel>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => copy("prompt", prompt)}
            >
              {copied === "prompt" ? (
                <CheckIcon data-icon="inline-start" />
              ) : (
                <CopyIcon data-icon="inline-start" />
              )}
              {copied === "prompt" ? "Copied" : "Copy"}
            </Button>
          </div>
          <pre className="rounded-md bg-muted px-3 py-2 text-xs whitespace-pre-wrap">{prompt}</pre>
        </Field>
        <div className="flex flex-col gap-2 text-sm">
          <p className="font-medium">By hand</p>
          <ul className="flex flex-col gap-1.5 text-muted-foreground">
            <li>
              <span className="text-foreground">An API key:</span> add it on the{" "}
              <Link
                to="/projects/$slug/secrets"
                params={{ slug: projectSlug }}
                className="underline underline-offset-4"
              >
                Secrets page
              </Link>
              , then send <code>getSecret("/secrets/name")</code> where the key goes.
            </li>
            <li>
              <span className="text-foreground">OAuth:</span> <code>itx.secrets.beginOAuth</code>
              {platformOrigin ? (
                <>
                  , redirect URL{" "}
                  <code className="break-all">{platformOrigin}/.secrets/oauth/callback</code>
                </>
              ) : null}
              .
            </li>
            <li>
              <span className="text-foreground">An MCP server:</span>{" "}
              <code>itx.connectToMcp(url, {"{ headers }"})</code>.
            </li>
            <li>
              <span className="text-foreground">An OpenAPI document:</span>{" "}
              <code>itx.connectToOpenApi(url, {"{ headers }"})</code>.
            </li>
            <li>
              <span className="text-foreground">An npm SDK:</span> a dependency in the config repo,
              with the placeholder as its token.
            </li>
          </ul>
        </div>
      </FieldGroup>
    </div>
  );
}
