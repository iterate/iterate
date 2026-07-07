import { useEffect } from "react";
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
import type { IntegrationProvider, ProjectRpcTarget } from "~/types.ts";

type Connection = Awaited<ReturnType<ProjectRpcTarget["integrations"]["getConnection"]>>;

const Search = StreamViewSearch.extend({
  error: z.string().optional(),
  /** Deep-link target: `?connect=<slug>` auto-starts that integration's connect
   * flow on mount, then clears itself so a refresh never re-triggers. */
  connect: z.string().optional(),
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
  const navigate = Route.useNavigate();
  const { project } = Route.useLoaderData();
  const { session } = useAuthClient();
  const userId = session?.authenticated ? session.user.id : null;
  const itx = useItx();
  const queryClient = useQueryClient();
  const connections = useItxQuery({
    key: ["integrations", project.slug],
    query: async (itx): Promise<{ slack: Connection; google: Connection }> => {
      const [slack, google] = await Promise.all([
        itx.integrations.getConnection({ provider: "slack" }),
        itx.integrations.getConnection({ provider: "google" }),
      ]);
      return { slack, google };
    },
  });
  const slackConnection = connections.slack;
  const googleConnection = connections.google;
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
    mutationFn: async () => await itx.integrations.disconnect({ provider: "slack" }),
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
  const disconnectGoogle = useMutation({
    mutationFn: async () => await itx.integrations.disconnect({ provider: "google" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["itx", "integrations", project.slug] });
      toast.success("Google disconnected");
    },
    onError: (error) => toast.error(`Failed to disconnect Google: ${error.message}`),
  });
  const startGithub = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("You must be signed in to connect GitHub.");
      return await itx.integrations.startOAuthFlow({
        // GitHub joins IntegrationProvider server-side in a parallel session;
        // wiring the button to the same startOAuthFlow path now means it connects
        // the moment that lands. Cast until "github" is in the union.
        provider: "github" as unknown as IntegrationProvider,
        userId,
        callbackUrl: window.location.href,
      });
    },
    onSuccess: (result) => {
      window.location.href = result.authorizationUrl;
    },
    onError: (error) => toast.error(`Failed to connect GitHub: ${error.message}`),
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
              {slackConnection?.connected
                ? `Connected to ${slackConnection.displayName ?? slackConnection.externalId}`
                : "Connect a Slack workspace to receive project webhooks and use Slack API tools."}
            </ItemDescription>
            <IntegrationMetadata connection={slackConnection} provider="slack" />
          </ItemContent>
          <ItemActions>
            {slackConnection?.connected ? (
              <Button
                size="sm"
                variant="outline"
                disabled={disconnectSlack.isPending}
                onClick={() => disconnectSlack.mutate()}
              >
                {disconnectSlack.isPending ? <Spinner /> : null}
                Disconnect
              </Button>
            ) : (
              <Button size="sm" disabled={startSlack.isPending} onClick={() => startSlack.mutate()}>
                {startSlack.isPending ? <Spinner /> : null}
                Connect Slack
              </Button>
            )}
          </ItemActions>
        </Item>

        <Item variant="outline" className="items-start justify-between gap-4 p-4">
          <ItemMedia variant="icon">
            <Mail className="size-4" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle>Google</ItemTitle>
            <ItemDescription>
              {googleConnection?.connected
                ? `Connected as ${googleConnection.displayName ?? googleConnection.externalId}`
                : "Connect Google for Gmail, Calendar, Docs, Sheets, and Drive API tools."}
            </ItemDescription>
            <IntegrationMetadata connection={googleConnection} provider="google" />
          </ItemContent>
          <ItemActions>
            {googleConnection?.connected ? (
              <Button
                size="sm"
                variant="outline"
                disabled={disconnectGoogle.isPending}
                onClick={() => disconnectGoogle.mutate()}
              >
                {disconnectGoogle.isPending ? <Spinner /> : null}
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={startGoogle.isPending}
                onClick={() => startGoogle.mutate()}
              >
                {startGoogle.isPending ? <Spinner /> : null}
                Connect Google
              </Button>
            )}
          </ItemActions>
        </Item>

        <Item variant="outline" className="items-start justify-between gap-4 p-4">
          <ItemMedia variant="icon">
            <Github className="size-4" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle>GitHub</ItemTitle>
            <ItemDescription>
              Connect GitHub to give agents repository access and receive repo webhooks.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button size="sm" disabled={startGithub.isPending} onClick={() => startGithub.mutate()}>
              {startGithub.isPending ? <Spinner /> : null}
              Connect GitHub
            </Button>
          </ItemActions>
        </Item>
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

function IntegrationMetadata({
  connection,
  provider,
}: {
  connection?: Connection;
  provider: "google" | "slack";
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
