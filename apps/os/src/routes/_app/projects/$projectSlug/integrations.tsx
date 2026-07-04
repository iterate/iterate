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
import { Spinner } from "@iterate-com/ui/components/spinner";
import { toast } from "@iterate-com/ui/components/sonner";
import { AlertCircle, Circle, Github, Mail, MessageSquare } from "lucide-react";
import { z } from "zod";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
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

const Search = StreamViewSearch.extend({
  error: z.string().optional(),
});

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

  const panel = (
    <>
      {oauthErrorLabel ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Integration failed</AlertTitle>
          <AlertDescription>{oauthErrorLabel}</AlertDescription>
        </Alert>
      ) : null}
      <ItemGroup className="space-y-3">
        <Item variant="outline" className="items-start justify-between gap-4 p-4">
          <ItemMedia variant="icon">
            <MessageSquare className="size-4" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle>Slack</ItemTitle>
            <ItemDescription>
              {connectedCount(slackConnections) > 0
                ? `${connectedCount(slackConnections)} connected workspace${connectedCount(slackConnections) === 1 ? "" : "s"}`
                : "Connect a Slack workspace to receive project webhooks and use Slack API tools."}
            </ItemDescription>
            {slackConnections.map((entry) => (
              <ConnectionRow
                key={entry.path}
                entry={entry}
                provider="slack"
                disconnecting={disconnectSlack.isPending}
                onDisconnect={() => disconnectSlack.mutate(entry.connection)}
              />
            ))}
          </ItemContent>
          <ItemActions>
            <Button size="sm" disabled={startSlack.isPending} onClick={() => startSlack.mutate()}>
              {startSlack.isPending ? <Spinner /> : null}
              Connect Slack
            </Button>
          </ItemActions>
        </Item>

        <Item variant="outline" className="items-start justify-between gap-4 p-4">
          <ItemMedia variant="icon">
            <Mail className="size-4" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle>Google</ItemTitle>
            <ItemDescription>
              {connectedCount(googleConnections) > 0
                ? `${connectedCount(googleConnections)} connected account${connectedCount(googleConnections) === 1 ? "" : "s"}`
                : "Connect Google for Gmail API tools."}
            </ItemDescription>
            {googleConnections.map((entry) => (
              <ConnectionRow
                key={entry.path}
                entry={entry}
                provider="google"
                disconnecting={disconnectGoogle.isPending}
                onDisconnect={() => disconnectGoogle.mutate(entry.connection)}
              />
            ))}
          </ItemContent>
          <ItemActions>
            <Button size="sm" disabled={startGoogle.isPending} onClick={() => startGoogle.mutate()}>
              {startGoogle.isPending ? <Spinner /> : null}
              Connect Google
            </Button>
          </ItemActions>
        </Item>

        <Item variant="outline" className="items-start justify-between gap-4 p-4">
          <ItemMedia variant="icon">
            <Github className="size-4" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle>GitHub</ItemTitle>
            <ItemDescription>
              {connectedCount(githubConnections) > 0
                ? `${connectedCount(githubConnections)} connected account${connectedCount(githubConnections) === 1 ? "" : "s"}`
                : "Connect GitHub for the REST API and gh/git inside sandboxes."}
            </ItemDescription>
            {githubConnections.map((entry) => (
              <ConnectionRow
                key={entry.path}
                entry={entry}
                provider="github"
                disconnecting={disconnectGithub.isPending}
                onDisconnect={() => disconnectGithub.mutate(entry.connection)}
              />
            ))}
          </ItemContent>
          <ItemActions>
            <Button size="sm" disabled={startGithub.isPending} onClick={() => startGithub.mutate()}>
              {startGithub.isPending ? <Spinner /> : null}
              Connect GitHub
            </Button>
          </ItemActions>
        </Item>

        {providedConnections.length > 0 ? (
          <Item variant="outline" className="items-start justify-between gap-4 p-4">
            <ItemMedia variant="icon">
              <Circle className="size-4" />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle>Project integrations</ItemTitle>
              <ItemDescription>
                Mounted by this project through provideCapability; manage them in project code.
              </ItemDescription>
              <div className="mt-2 grid gap-1.5 text-xs text-muted-foreground">
                {providedConnections.map((entry) => (
                  <IntegrationMetadataRow
                    key={entry.path}
                    label={entry.integration}
                    value={entry.path}
                  />
                ))}
              </div>
            </ItemContent>
          </Item>
        ) : null}
      </ItemGroup>
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

function ConnectionRow({
  disconnecting,
  entry,
  onDisconnect,
  provider,
}: {
  disconnecting: boolean;
  entry: ConnectionEntry;
  onDisconnect: () => void;
  provider: "github" | "google" | "slack";
}) {
  return (
    <div className="mt-2 flex items-start justify-between gap-2 rounded-md border p-2">
      <div className="min-w-0">
        <div className="truncate text-xs font-medium">{entry.connection}</div>
        <div className="truncate text-xs text-muted-foreground">{entry.path}</div>
        <IntegrationMetadata connection={entry.status ?? undefined} provider={provider} />
      </div>
      {entry.status?.connected ? (
        <Button size="sm" variant="outline" disabled={disconnecting} onClick={onDisconnect}>
          {disconnecting ? <Spinner /> : null}
          Disconnect
        </Button>
      ) : null}
    </div>
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
