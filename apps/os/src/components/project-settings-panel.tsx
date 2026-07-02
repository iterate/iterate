import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { StreamDebugLink } from "~/components/stream-debug-link.tsx";
import type { Project } from "~/lib/project-server-fns.ts";
import type { PublicRouteConfig } from "~/lib/public-route-config.ts";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";
import { useItx } from "~/itx/itx-react.tsx";
import type { IntegrationProvider } from "~/next/types.ts";

export function ProjectSettingsPanel({
  project,
  routeConfig,
  userId,
}: {
  project: Project;
  routeConfig: PublicRouteConfig;
  userId: string | null;
}) {
  const base = normalizeProjectHostnameBase(routeConfig.projectHostnameBases[0] ?? "");
  const defaultHostname = base ? `${project.slug}.${base}` : project.slug;

  return (
    <section className="flex flex-col gap-6">
      <SettingsSection title="Project">
        <SettingsField label="Slug">
          <p className="font-medium">{project.slug}</p>
        </SettingsField>
        <SettingsField label="Project ID">
          <Identifier value={project.id} />
        </SettingsField>
        <SettingsField label="Streams">
          <StreamDebugLink label="Open project stream" projectSlug={project.slug} streamPath="/" />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="Hostname routing">
        {/* TODO(task #13): custom hostnames (updateConfig/ensureCustomHostname)
            have no next-engine surface yet — restore this section when they do. */}
        <SettingsField label="Custom hostname">
          <p className="text-xs text-muted-foreground">
            Custom hostnames return soon (TODO task #13). This project is served at{" "}
            <code className="text-xs">{defaultHostname}</code>.
          </p>
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="Connections">
        <ConnectionField label="Slack" project={project} provider="slack" userId={userId} />
        <ConnectionField label="Google" project={project} provider="google" userId={userId} />
      </SettingsSection>

      <SettingsSection title="Timestamps">
        <SettingsField label="Created">
          <p className="text-sm text-muted-foreground">{project.createdAt}</p>
        </SettingsField>
        <SettingsField label="Updated">
          <p className="text-sm text-muted-foreground">{project.updatedAt}</p>
        </SettingsField>
      </SettingsSection>
    </section>
  );
}

function ConnectionField({
  label,
  project,
  provider,
  userId,
}: {
  label: string;
  project: Project;
  provider: IntegrationProvider;
  userId: string | null;
}) {
  const itx = useItx();
  const queryClient = useQueryClient();
  const connectionQueryKey = ["itx", "integration-connection", project.id, provider];
  const connection = useQuery({
    queryKey: connectionQueryKey,
    queryFn: async () => await itx.integrations.getConnection({ provider }),
  });

  const connect = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("Sign in to connect integrations.");
      return await itx.integrations.startOAuthFlow({ provider, userId });
    },
    onSuccess: ({ authorizationUrl }) => window.location.assign(authorizationUrl),
  });
  const disconnect = useMutation({
    mutationFn: async () => await itx.integrations.disconnect({ provider }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectionQueryKey }),
  });

  const connected = connection.data?.connected === true;
  const error = connect.error ?? disconnect.error;

  return (
    <SettingsField label={label}>
      <div className="flex items-center gap-3">
        <p className="text-sm text-muted-foreground">
          {connection.isPending ? "Checking…" : connected ? "Connected" : "Not connected"}
        </p>
        {connected ? (
          <Button
            variant="outline"
            size="sm"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            Disconnect
          </Button>
        ) : (
          <Button size="sm" disabled={connect.isPending} onClick={() => connect.mutate()}>
            {connect.isPending ? "Redirecting…" : `Connect ${label}`}
          </Button>
        )}
      </div>
      {error == null ? null : (
        <p className="mt-1 text-xs text-destructive">{(error as Error).message}</p>
      )}
    </SettingsField>
  );
}

function SettingsSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-medium text-muted-foreground uppercase">{title}</h2>
      <div className="flex flex-col divide-y">{children}</div>
    </section>
  );
}

function SettingsField({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="grid gap-2 py-3 text-sm first:pt-0 last:pb-0">
      <p className="text-xs font-medium text-muted-foreground uppercase">{label}</p>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
