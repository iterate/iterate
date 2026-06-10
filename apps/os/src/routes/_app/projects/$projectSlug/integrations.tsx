import { Suspense, useEffect, useState, type ComponentType } from "react";
import { createFileRoute } from "@tanstack/react-router";
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
import { AlertCircle, Circle, Mail, MessageSquare } from "lucide-react";
import { z } from "zod";
import type { ItxIntegrations } from "~/itx/facades.ts";
import { useItx } from "~/itx/use-itx.ts";
import { createBrowserOpenApiClient } from "~/orpc/client.ts";

type IntegrationConnection = Awaited<ReturnType<ItxIntegrations["getConnection"]>>;
type Provider = "google" | "slack";

const Search = z.object({
  error: z.string().optional(),
});

export const Route = createFileRoute("/_app/projects/$projectSlug/integrations")({
  validateSearch: Search,
  ssr: false,
  loader: ({ context }) => ({
    breadcrumb: "Integrations",
    project: context.project,
  }),
  component: ProjectIntegrationsPage,
});

function ProjectIntegrationsPage() {
  return (
    <Suspense
      fallback={<div className="p-4 text-sm text-muted-foreground">Connecting to itx...</div>}
    >
      <ProjectIntegrationsContent />
    </Suspense>
  );
}

function ProjectIntegrationsContent() {
  const search = Route.useSearch();
  const { project } = Route.useLoaderData();
  const itx = useItx(project.id);
  const [connections, setConnections] = useState<Partial<Record<Provider, IntegrationConnection>>>(
    {},
  );
  const [busyProvider, setBusyProvider] = useState<Provider>();
  const oauthErrorLabel = search.error ? formatOAuthError(search.error) : null;

  useEffect(() => {
    let cancelled = false;
    for (const provider of ["slack", "google"] as const) {
      itx.integrations
        .getConnection({ provider })
        .then(
          (connection) =>
            !cancelled && setConnections((previous) => ({ ...previous, [provider]: connection })),
        )
        .catch(
          (error: unknown) =>
            !cancelled && toast.error(error instanceof Error ? error.message : String(error)),
        );
    }
    return () => {
      cancelled = true;
    };
  }, [itx]);

  async function connect(provider: Provider) {
    setBusyProvider(provider);
    try {
      const { authorizationUrl } = await itx.integrations.startOAuthFlow({
        provider,
        callbackUrl: window.location.href,
      });
      window.location.href = authorizationUrl;
    } catch (error) {
      setBusyProvider(undefined);
      toast.error(
        `Failed to connect ${providerLabel(provider)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Disconnect still goes over oRPC: itx.integrations has no disconnect yet
  // (the flow appends provider-disconnected integration-stream events that
  // live in the oRPC router, not in a shared domain function).
  async function disconnect(provider: Provider) {
    setBusyProvider(provider);
    try {
      const integrations = createBrowserOpenApiClient().project.integrations;
      await (provider === "slack"
        ? integrations.disconnectSlack({ projectSlugOrId: project.id })
        : integrations.disconnectGoogle({ projectSlugOrId: project.id }));
      const connection = await itx.integrations.getConnection({ provider });
      setConnections((previous) => ({ ...previous, [provider]: connection }));
      toast.success(`${providerLabel(provider)} disconnected`);
    } catch (error) {
      toast.error(
        `Failed to disconnect ${providerLabel(provider)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setBusyProvider(undefined);
    }
  }

  return (
    <section className="max-w-md space-y-4 p-4">
      {oauthErrorLabel ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Integration failed</AlertTitle>
          <AlertDescription>{oauthErrorLabel}</AlertDescription>
        </Alert>
      ) : null}
      <ItemGroup className="space-y-3">
        <IntegrationItem
          provider="slack"
          icon={MessageSquare}
          connection={connections.slack}
          connectedDescription={(connection) =>
            `Connected to ${connection.displayName ?? connection.externalId}`
          }
          disconnectedDescription="Connect a Slack workspace to receive project webhooks and use Slack API tools."
          isBusy={busyProvider === "slack"}
          onConnect={() => void connect("slack")}
          onDisconnect={() => void disconnect("slack")}
        />
        <IntegrationItem
          provider="google"
          icon={Mail}
          connection={connections.google}
          connectedDescription={(connection) =>
            `Connected as ${connection.displayName ?? connection.externalId}`
          }
          disconnectedDescription="Connect Google for Gmail, Calendar, Docs, Sheets, and Drive API tools."
          isBusy={busyProvider === "google"}
          onConnect={() => void connect("google")}
          onDisconnect={() => void disconnect("google")}
        />
      </ItemGroup>
    </section>
  );
}

function IntegrationItem({
  connectedDescription,
  connection,
  disconnectedDescription,
  icon: Icon,
  isBusy,
  onConnect,
  onDisconnect,
  provider,
}: {
  connectedDescription: (connection: IntegrationConnection) => string;
  connection: IntegrationConnection | undefined;
  disconnectedDescription: string;
  icon: ComponentType<{ className?: string }>;
  isBusy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  provider: Provider;
}) {
  return (
    <Item variant="outline" className="items-start justify-between gap-4 p-4">
      <ItemMedia variant="icon">
        <Icon className="size-4" />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>{providerLabel(provider)}</ItemTitle>
        <ItemDescription>
          {connection?.connected ? connectedDescription(connection) : disconnectedDescription}
        </ItemDescription>
        <IntegrationMetadata connection={connection} provider={provider} />
      </ItemContent>
      <ItemActions>
        {connection?.connected ? (
          <Button size="sm" variant="outline" disabled={isBusy} onClick={onDisconnect}>
            {isBusy ? <Spinner /> : null}
            Disconnect
          </Button>
        ) : (
          <Button size="sm" disabled={isBusy} onClick={onConnect}>
            {isBusy ? <Spinner /> : null}
            Connect {providerLabel(provider)}
          </Button>
        )}
      </ItemActions>
    </Item>
  );
}

function providerLabel(provider: Provider) {
  return provider === "slack" ? "Slack" : "Google";
}

function IntegrationMetadata({
  connection,
  provider,
}: {
  connection?: IntegrationConnection;
  provider: Provider;
}) {
  if (!connection?.connected) return null;

  const token = connection.token;
  const scopeCount = countScopes(connection.scopes, provider === "slack" ? "," : " ");
  const expiry = token?.expiresAt ? formatExpiry(token.expiresAt) : null;

  return (
    <div className="mt-2 grid gap-1.5 text-xs text-muted-foreground">
      {expiry ? (
        <IntegrationMetadataRow label="Token expiry" value={expiry.label} tone={expiry.tone} />
      ) : (
        <IntegrationMetadataRow label="Token expiry" value="Not provided" />
      )}
      <IntegrationMetadataRow
        label="Access token"
        value={token?.hasMaterial ? "Stored" : "Missing"}
        tone={token?.hasMaterial ? "ok" : "danger"}
      />
      {provider === "google" || token?.refreshTokenStored ? (
        <IntegrationMetadataRow
          label="Refresh token"
          value={token?.refreshTokenStored ? "Stored" : "Not stored"}
          tone={provider === "google" && token?.refreshTokenStored ? "ok" : undefined}
        />
      ) : null}
      {token?.createdAt ? (
        <IntegrationMetadataRow label="Secret created" value={formatTimestamp(token.createdAt)} />
      ) : null}
      {token?.updatedAt ? (
        <IntegrationMetadataRow label="Secret updated" value={formatTimestamp(token.updatedAt)} />
      ) : null}
      <IntegrationMetadataRow label="External ID" value={connection.externalId ?? "Unknown"} />
      <IntegrationMetadataRow
        label="Scopes"
        value={scopeCount === 1 ? "1 scope" : `${scopeCount} scopes`}
      />
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

function formatExpiry(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return { label: value, tone: undefined };
  }

  const now = Date.now();
  const prefix = timestamp <= now ? "Expired" : "Expires";
  const tone: "danger" | "ok" | "warning" =
    timestamp <= now ? "danger" : timestamp - now < 10 * 60 * 1000 ? "warning" : "ok";
  return {
    label: `${prefix} ${formatTimestamp(value)}`,
    tone,
  };
}

function formatTimestamp(value: string) {
  const timestamp = Date.parse(value.endsWith("Z") || value.includes("T") ? value : `${value}Z`);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function formatOAuthError(value: string) {
  return value.replaceAll("_", " ");
}

function countScopes(scopes: string | null, separator: "," | " ") {
  if (!scopes) return 0;
  return scopes
    .split(separator)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0).length;
}
