import { Suspense, useEffect, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthClient } from "@iterate-com/auth/client";
import { Alert, AlertDescription, AlertTitle } from "@iterate-com/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@iterate-com/ui/components/alert-dialog";
import { Button } from "@iterate-com/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@iterate-com/ui/components/item";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { Textarea } from "@iterate-com/ui/components/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@iterate-com/ui/components/sheet";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { Skeleton } from "@iterate-com/ui/components/skeleton";
import { toast } from "@iterate-com/ui/components/sonner";
import {
  Activity,
  AlertCircle,
  Brain,
  Circle,
  Cloud,
  ExternalLink,
  Github,
  KeyRound,
  Mail,
  MessageSquare,
  Plus,
  Search as SearchIcon,
  Send,
  UserRoundCheck,
  type LucideIcon,
  Unplug,
} from "lucide-react";
import { z } from "zod";
import { useItx, useItxQuery, useLiveState } from "iterate/sdk/itx/react";
import type { Project } from "../../../../itx-api.generated.ts";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import {
  breadcrumbLoaderData,
  streamBreadcrumb,
  streamPageStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

type Connection = Awaited<ReturnType<Project["integrations"]["getConnection"]>>;

/** One list() entry enriched with the built-in connection status (null for
 * provided integrations, whose status lives in project code). */
type ConnectionEntry = Awaited<ReturnType<Project["integrations"]["list"]>>[number] & {
  status: Connection | null;
};

const Search = StreamViewSearch.extend({
  error: z.string().optional(),
  /** Signed proof that GitHub user OAuth authorized moving an installation
   * currently claimed by another project. */
  githubSteal: z.string().optional(),
  /** Deep-link target: `?connect=<slug>` auto-starts that integration's connect
   * flow on mount, then clears itself so a refresh never re-triggers. */
  connect: z.string().optional(),
  /** Opens one connected Telegram bot's user-access editor. Denial messages
   * deep-link here so an owner can paste the supplied numeric id. */
  telegramAccess: z.string().optional(),
});

const BUILTIN_API_INTEGRATIONS = [
  {
    description:
      "First-party OpenAPI RPC target for Parallel Search, Extract, Task, FindAll, Monitor, and Chat.",
    docsUrl: "https://docs.parallel.ai/",
    icon: Brain,
    keyReference: 'x-api-key: getSecret({ platform: "integrations.parallel.apiKey" })',
    name: "Parallel",
    namespace: "itx.integrations.parallel",
  },
  {
    description:
      "Built-in Exa MCP client for web search and page fetch; API-key egress can use the Exa platform key when configured.",
    docsUrl: "https://exa.ai/docs/reference/getting-started",
    icon: SearchIcon,
    keyReference: 'x-api-key: getSecret({ platform: "integrations.exa.apiKey" })',
    name: "Exa",
    namespace: "itx.mcp.exa",
  },
  {
    description:
      "Workers AI binding for model calls at the edge. No secret placeholder is needed for the built-in target.",
    docsUrl: "https://developers.cloudflare.com/workers-ai/",
    icon: Cloud,
    keyReference: "Call itx.ai.run(model, body)",
    name: "Cloudflare Edge AI",
    namespace: "itx.ai",
  },
] as const;

export const Route = createFileRoute("/_app/projects/$projectSlug/integrations")({
  validateSearch: Search,
  staticData: streamPageStaticData(),
  ssr: false,
  loader: ({ context }) =>
    breadcrumbLoaderData({
      project: context.project,
      streamBreadcrumb: streamBreadcrumb(context.project, "/integrations"),
    }),
  component: ProjectIntegrationsContent,
});

function ProjectIntegrationsContent() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const { session } = useAuthClient();
  const userId = session?.authenticated ? session.user.id : null;
  const itx = useItx();
  const queryClient = useQueryClient();
  const connections = useItxQuery({
    key: ["integrations", project.slug],
    query: async (itx): Promise<ConnectionEntry[]> => {
      const entries = await itx.integrations.list();
      return await Promise.all(
        entries.map(async (entry) => ({
          ...entry,
          status:
            entry.source === "builtin"
              ? await itx.integrations.getConnection({
                  connection: entry.connection,
                  provider: entry.integration === "gmail" ? "google" : entry.integration,
                })
              : null,
        })),
      );
    },
  });
  // Narrow on `source` so the union guarantees a concrete connection name for
  // every row the built-in cards render.
  const builtinConnections = (connections ?? []).filter(
    (entry): entry is ConnectionEntry & { connection: string; source: "builtin" } =>
      entry.source === "builtin",
  );
  const slackConnections = builtinConnections.filter((entry) => entry.integration === "slack");
  const googleConnections = builtinConnections.filter((entry) => entry.integration === "gmail");
  const githubConnections = builtinConnections.filter((entry) => entry.integration === "github");
  const telegramConnections = builtinConnections.filter(
    (entry) => entry.integration === "telegram",
  );
  const telegramAccessConnection =
    telegramConnections.find(
      (entry) => entry.connection === search.telegramAccess && entry.status?.connected,
    )?.connection || null;
  const setTelegramAccessSheetOpen = (open: boolean) => {
    if (open) return;
    void navigate({
      replace: true,
      search: (previous) => ({ ...previous, telegramAccess: undefined }),
    });
  };
  const providedConnections = (connections ?? []).filter((entry) => entry.source === "provided");
  const githubStealState =
    search.error === "github_installation_already_claimed" ? search.githubSteal || null : null;
  const oauthErrorLabel =
    search.error && !githubStealState ? search.error.replaceAll("_", " ") : null;

  const startSlack = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("You must be signed in to connect Slack.");
      return await itx.integrations.startOAuthFlow({
        provider: "slack",
        callbackUrl: window.location.href,
      });
    },
    onSuccess: (result) => {
      window.location.href = result.authorizationUrl;
    },
    onError: (error) => toast.error(`Failed to connect Slack: ${error.message}`),
  });
  const disconnectSlack = useMutation({
    mutationFn: async (connection: string) =>
      await itx.integrations.disconnect({ connection, provider: "slack" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["itx", "integrations", project.slug] });
      toast.success("Slack disconnected");
    },
    onError: (error) => toast.error(`Failed to disconnect Slack: ${error.message}`),
  });
  const startGoogle = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("You must be signed in to connect Google.");
      return await itx.integrations.startOAuthFlow({
        provider: "google",
        callbackUrl: window.location.href,
      });
    },
    onSuccess: (result) => {
      window.location.href = result.authorizationUrl;
    },
    onError: (error) => toast.error(`Failed to connect Google: ${error.message}`),
  });
  const startGithub = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("You must be signed in to connect GitHub.");
      return await itx.integrations.startOAuthFlow({
        provider: "github",
        callbackUrl: window.location.href,
      });
    },
    onSuccess: (result) => {
      window.location.href = result.authorizationUrl;
    },
    onError: (error) => toast.error(`Failed to connect GitHub: ${error.message}`),
  });
  const disconnectGithub = useMutation({
    mutationFn: async (connection: string) =>
      await itx.integrations.disconnect({ connection, provider: "github" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["itx", "integrations", project.slug] });
      toast.success("GitHub disconnected");
    },
    onError: (error) => toast.error(`Failed to disconnect GitHub: ${error.message}`),
  });
  const stealGithub = useMutation({
    mutationFn: async (state: string) => await itx.integrations.confirmGithubSteal({ state }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["itx", "integrations", project.slug] });
      await navigate({
        replace: true,
        search: (previous) => ({ ...previous, error: undefined, githubSteal: undefined }),
      });
      toast.success("GitHub installation moved");
    },
    onError: (error) => toast.error(`Failed to move GitHub installation: ${error.message}`),
  });
  const disconnectGoogle = useMutation({
    mutationFn: async (connection: string) =>
      await itx.integrations.disconnect({ connection, provider: "google" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["itx", "integrations", project.slug] });
      toast.success("Google disconnected");
    },
    onError: (error) => toast.error(`Failed to disconnect Google: ${error.message}`),
  });
  const [telegramSheetOpen, setTelegramSheetOpen] = useState(false);
  const connectTelegram = useMutation({
    // No OAuth: Telegram's BotFather token IS the credential. The verb
    // validates it with getMe and points the bot's webhook at this deployment.
    mutationFn: async (input: { botToken: string; steal?: boolean }) =>
      await itx.integrations.connectTelegram(input),
    onSuccess: async (result) => {
      if (!result.ok) return; // already claimed — the steal dialog derives from .data
      setTelegramSheetOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["itx", "integrations", project.slug] });
      toast.success(
        `Telegram bot ${result.botUsername ? `@${result.botUsername}` : result.botId} connected`,
      );
    },
    onError: (error) => toast.error(`Failed to connect Telegram: ${error.message}`),
  });
  const disconnectTelegram = useMutation({
    mutationFn: async (connection: string) =>
      await itx.integrations.disconnect({ connection, provider: "telegram" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["itx", "integrations", project.slug] });
      toast.success("Telegram disconnected");
    },
    onError: (error) => toast.error(`Failed to disconnect Telegram: ${error.message}`),
  });

  // Deep link: `?connect=<slug>` auto-starts the matching connect flow — the same
  // mutation a click on that Connect button fires — then clears the param so a
  // refresh (or landing back here after the OAuth round-trip) never re-triggers it.
  // `mutate` is stable per mutation, so the effect depends on those rather than the
  // per-render mutation objects (which would re-run it before the param clears).
  const connectSlack = startSlack.mutate;
  const connectGoogle = startGoogle.mutate;
  const connectGithub = startGithub.mutate;
  useEffect(() => {
    const slug = search.connect;
    if (!slug) return;
    void navigate({ search: (previous) => ({ ...previous, connect: undefined }), replace: true });
    if (slug === "slack") connectSlack();
    else if (slug === "google") connectGoogle();
    else if (slug === "github") connectGithub();
    else if (slug === "telegram") setTelegramSheetOpen(true); // token paste, not a redirect
    // Unknown slug: ignored.
  }, [search.connect, navigate, connectSlack, connectGoogle, connectGithub]);

  // Connection journals are their own streams — open the canonical stream
  // page rather than stacking a second ProjectStreamView (which would share
  // this route's StreamViewSearch URL params with the /integrations feed).
  const openStream = (streamPath: string) => {
    void navigate(linkOptionsForStreamPath(params.projectSlug, streamPath));
  };
  const dismissGithubSteal = () => {
    void navigate({
      replace: true,
      search: (previous) => ({
        ...previous,
        error: undefined,
        githubSteal: undefined,
      }),
    });
  };

  // Same shell as secrets/agents/repos: ProjectStreamView owns the header
  // (path pill flush left, presence + RTT + stream state on the right) and the
  // live /integrations feed; the domain UI is the panel beside it.
  const panel = (
    <>
      <AlertDialog
        open={!!githubStealState}
        onOpenChange={(open) => {
          if (!open && !stealGithub.isPending) dismissGithubSteal();
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Steal this GitHub installation?</AlertDialogTitle>
            <AlertDialogDescription>
              This installation is already connected to another project. Stealing it disconnects
              that project and routes future GitHub activity here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stealGithub.isPending} onClick={dismissGithubSteal}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={stealGithub.isPending}
              onClick={() => {
                if (githubStealState) stealGithub.mutate(githubStealState);
              }}
            >
              {stealGithub.isPending ? <Spinner data-icon="inline-start" /> : null}
              {stealGithub.isPending ? "Stealing..." : "Steal it"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {oauthErrorLabel ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Integration failed</AlertTitle>
          <AlertDescription>{oauthErrorLabel}</AlertDescription>
        </Alert>
      ) : null}

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-base font-medium">Connectable integrations</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            OAuth and app-installation connections create their own stream at
            <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-xs">
              /integrations/&lt;provider&gt;/&lt;connection&gt;
            </code>
            for lifecycle facts, routed webhooks, and provider-specific activity.
          </p>
        </div>
        <ItemGroup className="grid gap-4">
          <ConnectableIntegrationCard
            connectionNoun="workspace"
            connections={slackConnections}
            description="Receive Slack events and call Slack Web API methods with project-scoped credentials."
            disconnecting={disconnectSlack.isPending}
            icon={MessageSquare}
            name="Slack"
            onDisconnect={(connection) => disconnectSlack.mutate(connection)}
            onConfigureAccess={null}
            onOpenFeed={openStream}
            provider="slack"
            connectControl={
              <Button size="sm" disabled={startSlack.isPending} onClick={() => startSlack.mutate()}>
                {startSlack.isPending ? <Spinner /> : <Plus className="size-4" />}
                Connect
              </Button>
            }
          />
          <ConnectableIntegrationCard
            connectionNoun="account"
            connections={googleConnections}
            description="Use Gmail API tools through a connected Google account."
            disconnecting={disconnectGoogle.isPending}
            icon={Mail}
            name="Google"
            onDisconnect={(connection) => disconnectGoogle.mutate(connection)}
            onConfigureAccess={null}
            onOpenFeed={openStream}
            provider="google"
            connectControl={
              <Button
                size="sm"
                disabled={startGoogle.isPending}
                onClick={() => startGoogle.mutate()}
              >
                {startGoogle.isPending ? <Spinner /> : <Plus className="size-4" />}
                Connect
              </Button>
            }
          />
          <ConnectableIntegrationCard
            connectionNoun="installation"
            connections={githubConnections}
            description="Use the GitHub REST API, route repo webhooks, and enable gh/git inside sandboxes."
            disconnecting={disconnectGithub.isPending}
            icon={Github}
            name="GitHub"
            onDisconnect={(connection) => disconnectGithub.mutate(connection)}
            onConfigureAccess={null}
            onOpenFeed={openStream}
            provider="github"
            connectControl={
              <Button
                size="sm"
                disabled={startGithub.isPending}
                onClick={() => startGithub.mutate()}
              >
                {startGithub.isPending ? <Spinner /> : <Plus className="size-4" />}
                Connect
              </Button>
            }
          />
          <ConnectableIntegrationCard
            connectionNoun="bot"
            connections={telegramConnections}
            description="Connect a Telegram bot (via @BotFather) so agents can chat in Telegram."
            disconnecting={disconnectTelegram.isPending}
            icon={Send}
            name="Telegram"
            onDisconnect={(connection) => disconnectTelegram.mutate(connection)}
            onConfigureAccess={(connection) => {
              void navigate({
                search: (previous) => ({ ...previous, telegramAccess: connection }),
              });
            }}
            onOpenFeed={openStream}
            provider="telegram"
            connectControl={
              <TelegramConnectSheet
                connect={connectTelegram}
                open={telegramSheetOpen}
                onOpenChange={setTelegramSheetOpen}
              />
            }
          />
          <AccountConnectionsItem />
        </ItemGroup>
        {!telegramAccessConnection ? null : (
          <Suspense
            fallback={<TelegramAccessSheetLoading onOpenChange={setTelegramAccessSheetOpen} />}
          >
            <TelegramAccessSheet
              connection={telegramAccessConnection}
              onOpenChange={setTelegramAccessSheetOpen}
              projectSlug={project.slug}
            />
          </Suspense>
        )}
      </section>

      {providedConnections.length ? (
        <section className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-base font-medium">Project integrations</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Mounted by this project through <code>provideCapability</code>; manage these in
              project code.
            </p>
          </div>
          <ItemGroup className="grid gap-4">
            {providedConnections.map((entry) => (
              <ProvidedIntegrationCard key={entry.path} entry={entry} onOpenFeed={openStream} />
            ))}
          </ItemGroup>
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-base font-medium">Built-in Integrations</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            iterate-managed capabilities are available without creating a connection. Keys stay
            server-side and usage is charged to this project.
          </p>
        </div>
        <ItemGroup className="grid gap-4">
          {BUILTIN_API_INTEGRATIONS.map((integration) => (
            <BuiltInApiIntegrationRow key={integration.name} integration={integration} />
          ))}
        </ItemGroup>
      </section>
    </>
  );

  return (
    <ProjectStreamView
      panel={panel}
      projectId={project.id}
      streamPath="/integrations"
      emptyLabel="No events on the integrations stream yet."
    />
  );
}

/** Journals persist after disconnect; only status-connected entries count. */
function connectedCount(entries: ConnectionEntry[]): number {
  return entries.filter((entry) => entry.status?.connected).length;
}

function BuiltInApiIntegrationRow({
  integration,
}: {
  integration: (typeof BUILTIN_API_INTEGRATIONS)[number];
}) {
  const Icon = integration.icon;

  return (
    <Item variant="outline" className="items-start justify-between gap-4 p-4">
      <ItemMedia variant="icon">
        <Icon className="size-4" />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>{integration.name}</ItemTitle>
        <code className="block w-fit max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {integration.namespace}
        </code>
        <ItemDescription>{integration.description}</ItemDescription>
        <div className="mt-2 flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
          <KeyRound className="mt-0.5 size-3.5 shrink-0" />
          <code className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] leading-relaxed text-foreground">
            {integration.keyReference}
          </code>
        </div>
      </ItemContent>
      <ItemActions>
        <a
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium whitespace-nowrap hover:bg-muted hover:text-foreground"
          href={integration.docsUrl}
          rel="noreferrer"
          target="_blank"
        >
          <ExternalLink className="size-3.5" />
          Docs
        </a>
      </ItemActions>
    </Item>
  );
}

function ConnectableIntegrationCard({
  connectControl,
  connectionNoun,
  connections,
  description,
  disconnecting,
  icon: Icon,
  name,
  onConfigureAccess,
  onDisconnect,
  onOpenFeed,
  provider,
}: {
  /** The provider's own connect affordance: a redirect button for the OAuth
   * providers, a token-paste sheet for Telegram. */
  connectControl: ReactNode;
  connectionNoun: string;
  connections: (ConnectionEntry & { connection: string; source: "builtin" })[];
  description: string;
  disconnecting: boolean;
  icon: LucideIcon;
  name: string;
  onConfigureAccess: ((connection: string) => void) | null;
  onDisconnect: (connection: string) => void;
  onOpenFeed: (streamPath: string) => void;
  provider: "github" | "google" | "slack" | "telegram";
}) {
  const connected = connectedCount(connections);
  const connectionSummary =
    connected > 0
      ? `${connected} connected ${connectionNoun}${connected === 1 ? "" : "s"}`
      : "Not connected";

  return (
    <Item variant="outline" className="min-w-0 items-start gap-4 p-4">
      <ItemMedia variant="icon">
        <Icon className="size-4" />
      </ItemMedia>
      <ItemContent className="min-w-0 gap-3">
        <div className="min-w-0 space-y-1">
          <ItemTitle>{name}</ItemTitle>
          <ItemDescription className="line-clamp-3">{description}</ItemDescription>
          <div className="text-xs text-muted-foreground">{connectionSummary}</div>
        </div>
        <div className="flex flex-wrap gap-2">{connectControl}</div>
        {connections.length ? (
          <div className="grid gap-0.5 border-t pt-2">
            {connections.map((entry) => (
              <ConnectionRow
                key={entry.path}
                disconnecting={disconnecting}
                entry={entry}
                onConfigureAccess={
                  !onConfigureAccess ? null : () => onConfigureAccess(entry.connection)
                }
                onDisconnect={() => onDisconnect(entry.connection)}
                onOpenFeed={() => onOpenFeed(entry.path)}
                provider={provider}
              />
            ))}
          </div>
        ) : null}
      </ItemContent>
    </Item>
  );
}

function ProvidedIntegrationCard({
  entry,
  onOpenFeed,
}: {
  entry: ConnectionEntry;
  onOpenFeed: (streamPath: string) => void;
}) {
  return (
    <Item variant="outline" className="min-w-0 items-start gap-4 p-4">
      <ItemMedia variant="icon">
        <Circle className="size-4" />
      </ItemMedia>
      <ItemContent className="min-w-0 gap-3">
        <div className="min-w-0 space-y-1">
          <ItemTitle>{entry.integration}</ItemTitle>
          <ItemDescription className="line-clamp-3">
            {!entry.connection
              ? "Integration-level mount provided by project code."
              : `Connection ${entry.connection} provided by project code.`}
          </ItemDescription>
        </div>
        <div className="grid gap-1.5 text-xs text-muted-foreground">
          <IntegrationMetadataRow label="Path" value={entry.path} />
          <IntegrationMetadataRow label="Source" value={entry.source} />
        </div>
        <Button
          className="w-fit"
          size="sm"
          variant="outline"
          onClick={() => onOpenFeed(entry.path)}
        >
          <Activity className="size-4" />
          Feed
        </Button>
      </ItemContent>
    </Item>
  );
}

function ConnectionRow({
  disconnecting,
  entry,
  onConfigureAccess,
  onDisconnect,
  onOpenFeed,
  provider,
}: {
  disconnecting: boolean;
  entry: ConnectionEntry;
  onConfigureAccess: (() => void) | null;
  onDisconnect: () => void;
  onOpenFeed: () => void;
  provider: "github" | "google" | "slack" | "telegram";
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-xs font-medium">{entry.connection}</div>
        <div className="truncate text-xs text-muted-foreground">{entry.path}</div>
        <IntegrationMetadata connection={entry.status ?? undefined} provider={provider} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {entry.status?.connected && onConfigureAccess ? (
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={`Configure ${entry.connection} user access`}
            onClick={onConfigureAccess}
          >
            <UserRoundCheck data-icon="inline-start" />
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="outline"
          aria-label={`Open ${entry.connection} feed`}
          onClick={onOpenFeed}
        >
          <Activity className="size-4" />
        </Button>
        {entry.status?.connected ? (
          <Button
            size="icon-sm"
            variant="outline"
            disabled={disconnecting}
            aria-label={`Disconnect ${entry.connection}`}
            onClick={onDisconnect}
          >
            {disconnecting ? <Spinner /> : <Unplug className="size-4" />}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function IntegrationMetadata({
  connection,
  provider,
}: {
  connection?: Connection;
  provider: "github" | "google" | "slack" | "telegram";
}) {
  if (!connection?.connected) return null;

  // The itx connection status carries identity + provider metadata;
  // token material never leaves the secret pipeline (it lives in a secret DO
  // with an egress allowlist), so unlike the pre-migration page there are no
  // token-expiry rows here.
  const scopes = typeof connection.metadata.scopes === "string" ? connection.metadata.scopes : null;
  const scopeCount = scopes ? countScopes(scopes, provider === "slack" ? "," : " ") : null;

  return (
    <div className="mt-2 grid gap-1.5 text-xs text-muted-foreground">
      <IntegrationMetadataRow label="External ID" value={connection.externalId ?? "Unknown"} />
      {connection.displayName ? (
        <IntegrationMetadataRow label="Account" value={connection.displayName} />
      ) : null}
      {!Number.isFinite(scopeCount) ? null : (
        <IntegrationMetadataRow
          label="Scopes"
          value={scopeCount === 1 ? "1 scope" : `${scopeCount} scopes`}
        />
      )}
    </div>
  );
}

function IntegrationMetadataRow({
  label,
  tone,
  value,
}: {
  label: string;
  tone?: "danger" | "ok" | "warning";
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Circle className={`size-2 shrink-0 fill-current ${toneClassName(tone)}`} />
      <span className="shrink-0 text-muted-foreground/80">{label}</span>
      <span className="truncate text-foreground">{value}</span>
    </div>
  );
}

function TelegramAccessSheet({
  connection,
  onOpenChange,
  projectSlug,
}: {
  connection: string;
  onOpenChange: (open: boolean) => void;
  projectSlug: string;
}) {
  const itx = useItx();
  const queryClient = useQueryClient();
  const access = useItxQuery({
    key: ["telegram-access", projectSlug, connection],
    query: (itx) => itx.integrations.getTelegramAccess({ connection }),
  });
  const saveAccess = useMutation({
    mutationFn: async (allowedUserIds: string[]) =>
      await itx.integrations.setTelegramAccess({ allowedUserIds, connection }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["itx", "telegram-access", projectSlug, connection],
      });
      toast.success("Telegram user access updated");
      onOpenChange(false);
    },
    onError: (error) => toast.error(`Failed to update Telegram access: ${error.message}`),
  });

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="overflow-y-auto">
        <form
          className="flex h-full flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget).get("allowedUserIds") || "");
            saveAccess.mutate(value.split(/[\s,]+/).filter(Boolean));
          }}
        >
          <SheetHeader>
            <SheetTitle>Telegram user access</SheetTitle>
            <SheetDescription>
              Only listed Telegram accounts can ask this bot to use project capabilities.
            </SheetDescription>
          </SheetHeader>
          <FieldGroup className="flex flex-1 flex-col gap-4 p-4">
            {!access ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <Field data-invalid={saveAccess.isError}>
                <FieldLabel htmlFor="telegram-allowed-user-ids">
                  Allowed Telegram user IDs
                </FieldLabel>
                <Textarea
                  id="telegram-allowed-user-ids"
                  name="allowedUserIds"
                  aria-invalid={saveAccess.isError}
                  autoComplete="off"
                  defaultValue={access.allowedUserIds.join("\n")}
                  placeholder="123456789"
                  rows={8}
                />
                <FieldDescription>
                  Enter one numeric user ID per line. Usernames are not accepted because they can
                  change owners. To find an ID, message the bot while unauthorized—the reply
                  includes the exact ID and a link back here.
                </FieldDescription>
                {saveAccess.error ? <FieldError>{saveAccess.error.message}</FieldError> : null}
              </Field>
            )}
          </FieldGroup>
          <SheetFooter>
            <Button type="submit" disabled={!access || saveAccess.isPending}>
              {saveAccess.isPending ? <Spinner /> : null}
              {saveAccess.isPending ? "Saving..." : "Save access"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function TelegramAccessSheetLoading({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Telegram user access</SheetTitle>
          <SheetDescription>Loading this bot's access policy…</SheetDescription>
        </SheetHeader>
        <div className="p-4">
          <Skeleton className="h-40 w-full" />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function toneClassName(tone: "danger" | "ok" | "warning" | undefined) {
  if (tone === "danger") return "text-destructive";
  if (tone === "ok") return "text-emerald-600";
  if (tone === "warning") return "text-amber-600";
  return "text-muted-foreground/50";
}

function countScopes(scopes: string | null, separator: "," | " ") {
  if (!scopes) return 0;
  return scopes
    .split(separator)
    .map((scope) => scope.trim())
    .filter((scope) => !!scope.length).length;
}

const ACCOUNT_CONNECTION_PATH = /^\/secrets\/integrations\/([^/]+)\/([^/]+)\/session$/;

const AccountConnectionForm = z.object({
  slug: z
    .string()
    .trim()
    .min(1, "Integration name is required")
    .regex(/^[a-z][a-z0-9-]*$/, "Lowercase letters, digits and dashes"),
  connection: z
    .string()
    .trim()
    .min(1, "Connection name is required")
    .regex(/^[a-z][a-z0-9-]*$/, "Lowercase letters, digits and dashes"),
  username: z.string().trim().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  loginUrl: z.string().trim().url("Must be a full URL"),
});

const ACCOUNT_CONNECTION_DEFAULTS = {
  slug: "waitrose",
  connection: "",
  username: "",
  password: "",
  // The one live example this spike ships with: Waitrose's session-login
  // endpoint. Any provider with the username/password → short-lived-session
  // shape works — point this at its login URL.
  loginUrl: "https://www.waitrose.com/api/graphql-prod/graph/live",
};

/**
 * The username/password connection lane (spike): providers with no OAuth —
 * accounts whose credential is a login that mints short-lived sessions (the
 * `waitrose-session` strategy). Creating one writes a single session secret:
 * material `{ username, password }`, egress pinned to the login URL's origin,
 * and the refresh strategy — the secret's own Durable Object logs in on first
 * use and re-logins on 401. The integration code that USES the connection
 * lives in the project repo (see integrations/waitrose/ there); this form
 * only homes the credential.
 */
/** A username/password account connection, parsed from its session secret's
 * path: `/secrets/integrations/<slug>/<connection>/session`. */
type AccountConnection = { connection: string; path: string; slug: string };

function AccountConnectionsItem() {
  const itx = useItx();
  const [sheetOpen, setSheetOpen] = useState(false);
  // The connections list is derived from the project processor's live secrets
  // state — the same push-based slice the secrets page reads. Two payoffs over
  // a second useItxQuery: it does not suspend a second time (which would bubble
  // to the route's `<Suspense>` boundary and flash the whole panel back to the
  // "Connecting…" placeholder), and a freshly-created session secret appears
  // here the instant its stream folds, with no manual invalidation to race.
  const secretsList = useLiveState(
    (itx) => itx.liveState,
    (state) => state.reduced,
    [],
  ).value?.secrets;
  const accounts: AccountConnection[] = (secretsList ?? []).flatMap((secret) => {
    const match = ACCOUNT_CONNECTION_PATH.exec(secret.path);
    return match ? [{ connection: match[2], path: secret.path, slug: match[1] }] : [];
  });

  const createConnection = useMutation({
    mutationFn: async (input: z.infer<typeof AccountConnectionForm>) => {
      const path = `/secrets/integrations/${input.slug}/${input.connection}/session`;
      // One create births the whole connection: credential material, the
      // egress pin (the login URL's origin), and the session-login refresh
      // strategy. The password is write-only from here on.
      await itx.secrets.get(path).create({
        egress: { urls: [new URL(input.loginUrl).origin] },
        material: { password: input.password, username: input.username },
        refresh: { graphqlUrl: input.loginUrl, kind: "waitrose-session" },
      });
      return input;
    },
    onSuccess: (input) => {
      form.reset();
      setSheetOpen(false);
      // No refetch: the new session secret lands in the live secrets state
      // above when its stream folds, so the account row appears on its own.
      toast.success(
        `Connected — address it as itx.worker.${input.slug}.${input.connection} from project code.`,
      );
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const form = useForm({
    defaultValues: ACCOUNT_CONNECTION_DEFAULTS,
    validators: {
      onChange: AccountConnectionForm,
      onSubmit: AccountConnectionForm,
    },
    onSubmit: async ({ value }) => {
      await createConnection.mutateAsync(AccountConnectionForm.parse(value));
    },
  });

  const fieldInput = (
    name: keyof typeof ACCOUNT_CONNECTION_DEFAULTS,
    label: string,
    options: { description?: string; placeholder?: string; type?: string } = {},
  ) => (
    <form.Field name={name}>
      {(field) => {
        const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

        return (
          <Field data-invalid={isInvalid}>
            <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
            <Input
              id={field.name}
              name={field.name}
              type={options.type ?? "text"}
              autoComplete="off"
              placeholder={options.placeholder}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              aria-invalid={isInvalid}
            />
            {options.description ? (
              <FieldDescription>{options.description}</FieldDescription>
            ) : null}
            {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
          </Field>
        );
      }}
    </form.Field>
  );

  return (
    <Item variant="outline" className="items-start justify-between gap-4 p-4">
      <ItemMedia variant="icon">
        <KeyRound className="size-4" />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>Account connections</ItemTitle>
        <ItemDescription>
          Username/password accounts for providers without OAuth. The credential lives in a
          write-only session secret; the secret logs itself in and re-logins when the session
          expires.
        </ItemDescription>
        {accounts.length ? (
          <div className="mt-2 grid gap-1.5 text-xs text-muted-foreground">
            {accounts.map((account) => (
              <IntegrationMetadataRow
                key={account.path}
                label={`${account.slug} / ${account.connection}`}
                value={`itx.worker.${account.slug}.${account.connection}`}
              />
            ))}
          </div>
        ) : null}
      </ItemContent>
      <ItemActions>
        <Sheet
          open={sheetOpen}
          onOpenChange={(open) => {
            setSheetOpen(open);
            if (!open) form.reset();
          }}
        >
          <SheetTrigger render={<Button type="button" size="sm" />}>Connect account</SheetTrigger>
          <SheetContent side="right" className="overflow-y-auto">
            <form
              className="flex h-full flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void form.handleSubmit();
              }}
            >
              <SheetHeader>
                <SheetTitle>Connect an account</SheetTitle>
                <SheetDescription>
                  For providers that log in with a username and password (like Waitrose). The
                  password is stored write-only and only ever leaves toward the login URL&apos;s
                  origin.
                </SheetDescription>
              </SheetHeader>
              <FieldGroup className="flex flex-1 flex-col gap-4 p-4">
                {fieldInput("slug", "Integration", {
                  description: "The integration this account belongs to.",
                  placeholder: "waitrose",
                })}
                {fieldInput("connection", "Connection name", {
                  description: "Your name for this account, e.g. personal or mum.",
                  placeholder: "personal",
                })}
                {fieldInput("username", "Username / email", {
                  placeholder: "you@example.com",
                })}
                {fieldInput("password", "Password", { type: "password" })}
                {fieldInput("loginUrl", "Login URL", {
                  description:
                    "The provider's session-login endpoint. Egress is pinned to this URL's origin.",
                })}
              </FieldGroup>
              <SheetFooter>
                <form.Subscribe
                  selector={(state) => [state.canSubmit, state.isSubmitting] as const}
                >
                  {([canSubmit, isSubmitting]) => (
                    <Button
                      type="submit"
                      disabled={!canSubmit || isSubmitting || createConnection.isPending}
                    >
                      {isSubmitting || createConnection.isPending ? "Connecting..." : "Connect"}
                    </Button>
                  )}
                </form.Subscribe>
              </SheetFooter>
            </form>
          </SheetContent>
        </Sheet>
      </ItemActions>
    </Item>
  );
}

/**
 * Telegram's connect affordance: no OAuth redirect — a token-paste sheet. The
 * BotFather token IS the credential; connectTelegram validates it with getMe,
 * points the bot's webhook at this deployment, and stores the token write-only
 * (it only ever leaves toward api.telegram.org).
 */
function TelegramConnectSheet({
  connect,
  onOpenChange,
  open,
}: {
  /** The connectTelegram mutation: `data`/`variables` drive the steal-confirm
   * dialog (an `ok: false` result means the bot is claimed by another
   * project), so no extra dialog state exists. */
  connect: {
    data: Awaited<ReturnType<Project["integrations"]["connectTelegram"]>> | undefined;
    isPending: boolean;
    mutate: (input: { botToken: string; steal?: boolean }) => void;
    reset: () => void;
    variables: { botToken: string; steal?: boolean } | undefined;
  };
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const stealPrompt = connect.data && !connect.data.ok ? connect.data : null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger render={<Button type="button" size="sm" />}>
        <Plus className="size-4" />
        Connect
      </SheetTrigger>
      <SheetContent side="right" className="overflow-y-auto">
        <form
          className="flex h-full flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const botToken = String(new FormData(event.currentTarget).get("botToken") || "");
            connect.mutate({ botToken });
          }}
        >
          <SheetHeader>
            <SheetTitle>Connect a Telegram bot</SheetTitle>
            <SheetDescription>
              First-time setup happens in Telegram — create the bot there, then come back with its
              token:
            </SheetDescription>
          </SheetHeader>
          {/* Abbreviated first-time setup: a user who has never made a Telegram
              bot lands here needing to be told the bot is created IN Telegram. */}
          <ol className="list-decimal space-y-1 py-2 pr-4 pl-9 text-sm text-muted-foreground">
            <li>
              Open Telegram and message{" "}
              <a
                className="font-medium text-foreground underline underline-offset-2"
                href="https://t.me/BotFather"
                rel="noreferrer"
                target="_blank"
              >
                @BotFather
              </a>
              .
            </li>
            <li>
              Send <code className="rounded bg-muted px-1 font-mono text-xs">/newbot</code> and
              follow the prompts (or{" "}
              <code className="rounded bg-muted px-1 font-mono text-xs">/token</code> for an
              existing bot).
            </li>
            <li>Copy the token BotFather gives you and paste it below.</li>
          </ol>
          <FieldGroup className="flex flex-1 flex-col gap-4 p-4">
            <Field>
              <FieldLabel htmlFor="telegram-bot-token">Bot token</FieldLabel>
              <Input
                id="telegram-bot-token"
                name="botToken"
                type="password"
                autoComplete="off"
                placeholder="123456789:AAF..."
                required
              />
              <FieldDescription>
                The token is stored write-only and only ever leaves toward api.telegram.org. Note:
                by default, bots in group chats only see commands and mentions (Telegram&apos;s
                privacy mode); direct messages always work.
              </FieldDescription>
            </Field>
          </FieldGroup>
          <SheetFooter>
            <Button type="submit" disabled={connect.isPending}>
              {connect.isPending ? <Spinner /> : null}
              {connect.isPending ? "Connecting..." : "Connect"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
      {/* A bot has exactly one webhook, so connecting it here would take it
          from wherever it lives now. Possession of the token is the
          authorization; this confirm is the foot-gun gate. */}
      <AlertDialog
        open={!!stealPrompt}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) connect.reset();
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Steal {stealPrompt?.botUsername ? `@${stealPrompt.botUsername}` : "this bot"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This bot is already connected to another project. Steal it? The other project will
              lose the connection.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => connect.reset()}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={connect.isPending}
              onClick={() => {
                if (connect.variables) {
                  connect.mutate({ botToken: connect.variables.botToken, steal: true });
                }
              }}
            >
              Steal it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
