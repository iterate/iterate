import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthClient } from "@iterate-com/auth/client";
import { Alert, AlertDescription, AlertTitle } from "@iterate-com/ui/components/alert";
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@iterate-com/ui/components/sheet";
import { Spinner } from "@iterate-com/ui/components/spinner";
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
  Sparkles,
  type LucideIcon,
  Unplug,
} from "lucide-react";
import { z } from "zod";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { StreamPathPill } from "~/components/stream-path-pill.tsx";
import { breadcrumbLoaderData, streamBreadcrumb } from "~/lib/route-breadcrumbs.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";
import { useItx, useItxQuery } from "~/itx/itx-react.tsx";
import type { ProjectRpcTarget } from "~/types.ts";

type Connection = Awaited<ReturnType<ProjectRpcTarget["integrations"]["getConnection"]>>;

/** One list() entry enriched with the built-in connection status (null for
 * provided integrations, whose status lives in project code). */
type ConnectionEntry = Awaited<ReturnType<ProjectRpcTarget["integrations"]["list"]>>[number] & {
  status: Connection | null;
};

type FeedPanel = {
  emptyLabel: string;
  streamPath: string;
};

const Search = StreamViewSearch.extend({
  error: z.string().optional(),
  /** Deep-link target: `?connect=<slug>` auto-starts that integration's connect
   * flow on mount, then clears itself so a refresh never re-triggers. */
  connect: z.string().optional(),
});

const STREAM_VIEW_SEARCH_RESET = {
  event: undefined,
  filter: undefined,
  from: undefined,
  panel: undefined,
  preset: undefined,
  processor: undefined,
  q: undefined,
  tab: undefined,
  to: undefined,
  types: undefined,
} satisfies Partial<z.infer<typeof StreamViewSearch>>;

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
  {
    description:
      "OpenAI API calls through project egress or workers without storing a project-owned OpenAI key.",
    docsUrl: "https://platform.openai.com/docs/api-reference",
    icon: Sparkles,
    keyReference: 'Authorization: Bearer getSecret({ platform: "openAiApiKey" })',
    name: "OpenAI",
    namespace: "itx.egress.fetch",
  },
] as const;

export const Route = createFileRoute("/_app/projects/$projectSlug/integrations")({
  validateSearch: Search,
  ssr: false,
  loader: ({ context }) =>
    breadcrumbLoaderData({
      project: context.project,
      streamBreadcrumb: streamBreadcrumb(context.project, "/integrations"),
    }),
  component: ProjectIntegrationsPage,
});

function ProjectIntegrationsPage() {
  return (
    <ItxBoundary>
      <ProjectIntegrationsContent />
    </ItxBoundary>
  );
}

function ProjectIntegrationsContent() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
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
                  provider: entry.integration,
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
  const googleConnections = builtinConnections.filter((entry) => entry.integration === "google");
  const githubConnections = builtinConnections.filter((entry) => entry.integration === "github");
  const providedConnections = (connections ?? []).filter((entry) => entry.source === "provided");
  const oauthErrorLabel = search.error ? search.error.replaceAll("_", " ") : null;
  const [feedPanel, setFeedPanel] = useState<FeedPanel | null>(null);

  const startSlack = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("You must be signed in to connect Slack.");
      return await itx.integrations.startOAuthFlow({
        provider: "slack",
        userId,
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
        userId,
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
        userId,
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
  const disconnectGoogle = useMutation({
    mutationFn: async (connection: string) =>
      await itx.integrations.disconnect({ connection, provider: "google" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["itx", "integrations", project.slug] });
      toast.success("Google disconnected");
    },
    onError: (error) => toast.error(`Failed to disconnect Google: ${error.message}`),
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
    // Unknown slug: ignored.
  }, [search.connect, navigate, connectSlack, connectGoogle, connectGithub]);

  const resetFeedViewSearch = () => {
    return navigate({
      search: (previous) => ({ ...previous, ...STREAM_VIEW_SEARCH_RESET }),
      replace: true,
    });
  };
  const openFeed = async (panel: FeedPanel) => {
    if (feedPanel == null || feedPanel.streamPath !== panel.streamPath) {
      await resetFeedViewSearch();
    }
    setFeedPanel(panel);
  };
  const openProjectFeed = () =>
    openFeed({
      emptyLabel: "No events on the integrations stream yet.",
      streamPath: "/integrations",
    });

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-5 md:px-6">
        <header className="flex items-center pb-2">
          <StreamPathPill
            streamPath="/integrations"
            title="/integrations — open stream feed"
            onClick={openProjectFeed}
          />
        </header>

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
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
              OAuth and app-installation connections create their own stream at
              <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-xs">
                /integrations/&lt;provider&gt;/&lt;connection&gt;
              </code>
              for lifecycle facts, routed webhooks, and provider-specific activity.
            </p>
          </div>
          <ItemGroup className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <ConnectableIntegrationCard
              connectionNoun="workspace"
              connections={slackConnections}
              description="Receive Slack events and call Slack Web API methods with project-scoped credentials."
              disconnecting={disconnectSlack.isPending}
              icon={MessageSquare}
              name="Slack"
              onConnect={() => startSlack.mutate()}
              onDisconnect={(connection) => disconnectSlack.mutate(connection)}
              onOpenFeed={openFeed}
              provider="slack"
              startPending={startSlack.isPending}
            />
            <ConnectableIntegrationCard
              connectionNoun="account"
              connections={googleConnections}
              description="Use Gmail API tools through a connected Google account."
              disconnecting={disconnectGoogle.isPending}
              icon={Mail}
              name="Google"
              onConnect={() => startGoogle.mutate()}
              onDisconnect={(connection) => disconnectGoogle.mutate(connection)}
              onOpenFeed={openFeed}
              provider="google"
              startPending={startGoogle.isPending}
            />
            <ConnectableIntegrationCard
              connectionNoun="installation"
              connections={githubConnections}
              description="Use the GitHub REST API, route repo webhooks, and enable gh/git inside sandboxes."
              disconnecting={disconnectGithub.isPending}
              icon={Github}
              name="GitHub"
              onConnect={() => startGithub.mutate()}
              onDisconnect={(connection) => disconnectGithub.mutate(connection)}
              onOpenFeed={openFeed}
              provider="github"
              startPending={startGithub.isPending}
            />
          </ItemGroup>
        </section>

        {providedConnections.length > 0 ? (
          <section className="space-y-3">
            <div className="space-y-1">
              <h2 className="text-base font-medium">Project integrations</h2>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                Mounted by this project through <code>provideCapability</code>; manage these in
                project code.
              </p>
            </div>
            <ItemGroup className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {providedConnections.map((entry) => (
                <ProvidedIntegrationCard key={entry.path} entry={entry} onOpenFeed={openFeed} />
              ))}
            </ItemGroup>
          </section>
        ) : null}

        <section className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-base font-medium">Built-in Integrations</h2>
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
              Iterate-managed capabilities are available without creating a connection. Keys stay
              server-side and usage is charged to this project.
            </p>
          </div>
          <ItemGroup className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {BUILTIN_API_INTEGRATIONS.map((integration) => (
              <BuiltInApiIntegrationRow key={integration.name} integration={integration} />
            ))}
          </ItemGroup>
        </section>
      </div>

      <IntegrationFeedSheet
        feedPanel={feedPanel}
        onOpenChange={(open) => {
          if (!open) {
            void resetFeedViewSearch();
            setFeedPanel(null);
          }
        }}
        projectId={project.id}
      />
    </main>
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
  connectionNoun,
  connections,
  description,
  disconnecting,
  icon: Icon,
  name,
  onConnect,
  onDisconnect,
  onOpenFeed,
  provider,
  startPending,
}: {
  connectionNoun: string;
  connections: (ConnectionEntry & { connection: string; source: "builtin" })[];
  description: string;
  disconnecting: boolean;
  icon: LucideIcon;
  name: string;
  onConnect: () => void;
  onDisconnect: (connection: string) => void;
  onOpenFeed: (panel: FeedPanel) => void;
  provider: "github" | "google" | "slack";
  startPending: boolean;
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
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={startPending} onClick={onConnect}>
            {startPending ? <Spinner /> : <Plus className="size-4" />}
            Connect
          </Button>
        </div>
        {connections.length > 0 ? (
          <div className="grid gap-0.5 border-t pt-2">
            {connections.map((entry) => (
              <ConnectionRow
                key={entry.path}
                disconnecting={disconnecting}
                entry={entry}
                onDisconnect={() => onDisconnect(entry.connection)}
                onOpenFeed={() =>
                  onOpenFeed({
                    emptyLabel: `No events on ${entry.path} yet.`,
                    streamPath: entry.path,
                  })
                }
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
  onOpenFeed: (panel: FeedPanel) => void;
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
            {entry.connection == null
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
          onClick={() =>
            onOpenFeed({
              emptyLabel: `No events on ${entry.path} yet.`,
              streamPath: entry.path,
            })
          }
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
  onDisconnect,
  onOpenFeed,
  provider,
}: {
  disconnecting: boolean;
  entry: ConnectionEntry;
  onDisconnect: () => void;
  onOpenFeed: () => void;
  provider: "github" | "google" | "slack";
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-xs font-medium">{entry.connection}</div>
        <div className="truncate text-xs text-muted-foreground">{entry.path}</div>
        <IntegrationMetadata connection={entry.status ?? undefined} provider={provider} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
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

function IntegrationFeedSheet({
  feedPanel,
  onOpenChange,
  projectId,
}: {
  feedPanel: FeedPanel | null;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}) {
  return (
    <Sheet open={feedPanel != null} onOpenChange={onOpenChange}>
      {feedPanel == null ? null : (
        <SheetContent className="w-full gap-0 data-[side=right]:sm:w-[min(92vw,56rem)] data-[side=right]:sm:max-w-[min(92vw,56rem)]">
          <SheetHeader className="sr-only">
            <SheetTitle>{feedPanel.streamPath} feed</SheetTitle>
          </SheetHeader>
          <div className="flex min-h-0 flex-1">
            <ProjectStreamView
              showHeader={false}
              projectId={projectId}
              streamPath={feedPanel.streamPath}
              emptyLabel={feedPanel.emptyLabel}
            />
          </div>
        </SheetContent>
      )}
    </Sheet>
  );
}

function IntegrationMetadata({
  connection,
  provider,
}: {
  connection?: Connection;
  provider: "github" | "google" | "slack";
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
      {scopeCount === null ? null : (
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
    .filter((scope) => scope.length > 0).length;
}
