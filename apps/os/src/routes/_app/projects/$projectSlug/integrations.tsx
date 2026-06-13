import { Suspense, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
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
import { AlertCircle, Circle, Mail, MessageSquare } from "lucide-react";
import { z } from "zod";
import { useItx } from "~/itx/use-itx.ts";
import type { Stubify } from "~/itx/types.ts";
import type { IntegrationsCapability } from "~/domains/secrets/entrypoints/integrations-capability.ts";

type IntegrationsCap = Stubify<
  Pick<IntegrationsCapability, "getConnection" | "startOAuthFlow" | "disconnect">
>;
type Connection = Awaited<ReturnType<IntegrationsCap["getConnection"]>>;

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
  const { session } = useAuthClient();
  const userId = session?.authenticated ? session.user.id : null;
  const itx = useItx(project.id);
  const integrations = itx.capability("integrations") as unknown as IntegrationsCap;
  const [slackConnection, setSlackConnection] = useState<Connection | undefined>(undefined);
  const [googleConnection, setGoogleConnection] = useState<Connection | undefined>(undefined);
  const oauthErrorLabel = search.error ? formatOAuthError(search.error) : null;

  async function refreshSlack() {
    try {
      setSlackConnection(await integrations.getConnection({ provider: "slack" }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }
  async function refreshGoogle() {
    try {
      setGoogleConnection(await integrations.getConnection({ provider: "google" }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      integrations.getConnection({ provider: "slack" }),
      integrations.getConnection({ provider: "google" }),
    ])
      .then(([slack, google]) => {
        if (cancelled) return;
        setSlackConnection(slack);
        setGoogleConnection(google);
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the itx handle identity changes (reconnect), not on every dep churn
  }, [itx]);

  const startSlack = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("You must be signed in to connect Slack.");
      return await integrations.startOAuthFlow({
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
    mutationFn: async () => await integrations.disconnect({ provider: "slack" }),
    onSuccess: async () => {
      await refreshSlack();
      toast.success("Slack disconnected");
    },
    onError: (error) => toast.error(`Failed to disconnect Slack: ${error.message}`),
  });
  const startGoogle = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("You must be signed in to connect Google.");
      return await integrations.startOAuthFlow({
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
    mutationFn: async () => await integrations.disconnect({ provider: "google" }),
    onSuccess: async () => {
      await refreshGoogle();
      toast.success("Google disconnected");
    },
    onError: (error) => toast.error(`Failed to disconnect Google: ${error.message}`),
  });

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
      </ItemGroup>
    </section>
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
