import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import type { Project, ProjectCustomHostnameStatus } from "@iterate-com/os-contract";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
import { toast } from "@iterate-com/ui/components/sonner";
import { EventsDebugLink } from "~/components/events-debug-link.tsx";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";
import { projectCustomHostnameStatusQueryOptions } from "~/lib/project-route-query.ts";
import { getPublicRouteConfig, type PublicRouteConfig } from "~/lib/public-route-config.ts";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/settings")({
  loader: async ({ context }) => {
    const { project } = context;
    if (project.customHostname) {
      await context.queryClient.ensureQueryData(
        projectCustomHostnameStatusQueryOptions(project.id),
      );
    }

    return {
      breadcrumb: "Settings",
      project,
      routeConfig: await getPublicRouteConfig(),
    };
  },
  component: ProjectDetailPage,
});

function ProjectDetailPage() {
  const { project, routeConfig } = Route.useLoaderData();

  return <ProjectDetailContent project={project} routeConfig={routeConfig} />;
}

function ProjectDetailContent({
  project,
  routeConfig,
}: {
  project: Project;
  routeConfig: PublicRouteConfig;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [customHostname, setCustomHostname] = useState(project.customHostname ?? "");
  const [hostnameToActivate, setHostnameToActivate] = useState("");
  const dnsInstructions = customHostnameDnsInstructions({
    customHostname,
    project,
    projectHostnameBases: routeConfig.projectHostnameBases,
  });
  const customHostnameStatusQuery = useQuery({
    ...projectCustomHostnameStatusQueryOptions(project.id),
    enabled: Boolean(project.customHostname),
    refetchInterval: (query) =>
      query.state.data?.hostnames.some((hostname) => hostname.sslStatus !== "active")
        ? 10_000
        : false,
  });
  const updateConfig = useMutation(
    orpc.projects.updateConfig.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.projects.find.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.projects.findBySlug.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.projects.customHostnameStatus.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.projects.list.key() });
        void router.invalidate();
        toast.success("Project config saved.");
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const ensureCustomHostname = useMutation(
    orpc.projects.ensureCustomHostname.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.projects.customHostnameStatus.key() });
        toast.success("Custom hostname activated.");
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const handleUpdateConfig = useCallback(() => {
    updateConfig.mutate({
      id: project.id,
      customHostname: customHostname.trim() === "" ? null : customHostname,
    });
  }, [customHostname, project.id, updateConfig]);
  const handleActivateHostname = useCallback(() => {
    ensureCustomHostname.mutate({
      id: project.id,
      hostname: hostnameToActivate,
    });
  }, [ensureCustomHostname, hostnameToActivate, project.id]);

  return (
    <section className="space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{project.slug}</h2>
        <p className="text-sm text-muted-foreground">
          Update hostname routing and inspect the stored project fields.
        </p>
      </div>

      <div className="space-y-3 rounded-lg border bg-card p-4">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Slug</p>
          <p className="font-medium">{project.slug}</p>
        </div>

        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Project ID</p>
          <Identifier value={project.id} />
        </div>

        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Events namespace</p>
          <EventsDebugLink label="Open project in Streams" namespace={project.id} streamPath="/" />
        </div>

        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Custom hostname</p>
          <div className="flex gap-2">
            <Input
              placeholder="app.example.com"
              value={customHostname}
              onChange={(event) => setCustomHostname(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && handleUpdateConfig()}
            />
          </div>
          <CustomHostnameDnsInstructions instructions={dnsInstructions} />
          {project.customHostname ? (
            <div className="space-y-2">
              <CustomHostnameCloudflareStatus
                status={customHostnameStatusQuery.data}
                isPending={customHostnameStatusQuery.isPending}
              />
              <div className="flex gap-2">
                <Input
                  placeholder={`app1.${project.customHostname}`}
                  value={hostnameToActivate}
                  onChange={(event) => setHostnameToActivate(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && handleActivateHostname()}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleActivateHostname}
                  disabled={ensureCustomHostname.isPending || hostnameToActivate.trim() === ""}
                >
                  {ensureCustomHostname.isPending ? "Activating..." : "Activate"}
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <Button size="sm" onClick={handleUpdateConfig} disabled={updateConfig.isPending}>
          {updateConfig.isPending ? "Saving..." : "Save"}
        </Button>

        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Created</p>
          <p className="text-sm text-muted-foreground">{project.createdAt}</p>
        </div>

        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Updated</p>
          <p className="text-sm text-muted-foreground">{project.updatedAt}</p>
        </div>
      </div>

      <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/projects" />}>
        Back to projects
      </Button>
    </section>
  );
}

function CustomHostnameDnsInstructions({
  instructions,
}: {
  instructions: CustomHostnameDnsInstructionsData;
}) {
  if (instructions.kind === "empty") {
    return (
      <p className="text-xs text-muted-foreground">
        Optional. Use a custom hostname instead of{" "}
        <code className="text-xs">{instructions.defaultHostname}</code>.
      </p>
    );
  }

  if (instructions.kind === "missing-base") {
    return (
      <p className="text-xs text-muted-foreground">
        This deployment does not have a project hostname base configured, so DNS instructions cannot
        be generated here.
      </p>
    );
  }

  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <p>
        Point these DNS-only CNAME records to <code className="text-xs">{instructions.target}</code>
        :
      </p>
      <div className="space-y-1 font-mono text-xs text-foreground">
        <div>
          <span className="text-muted-foreground">CNAME</span> <code>{instructions.hostname}</code>
        </div>
        <div>
          <span className="text-muted-foreground">CNAME</span>{" "}
          <code>{instructions.wildcardHostname}</code>
        </div>
      </div>
      <p>
        If <code className="text-xs">{instructions.hostname}</code> is an apex/root domain, use your
        DNS provider's ALIAS, ANAME, or CNAME flattening feature for that record. Keep the wildcard
        as a normal CNAME. In Cloudflare-managed customer zones, leave both records DNS-only.
      </p>
      <p>
        Cloudflare still needs each app hostname activated below before it can serve requests for
        that hostname. Wildcard custom hostnames require a Cloudflare Enterprise entitlement on the
        provider zone.
      </p>
    </div>
  );
}

function CustomHostnameCloudflareStatus({
  isPending,
  status,
}: {
  isPending: boolean;
  status: ProjectCustomHostnameStatus | undefined;
}) {
  if (isPending) {
    return <p className="text-xs text-muted-foreground">Checking Cloudflare hostname status...</p>;
  }

  if (!status) return null;

  if (!status.cloudflareConfigured) {
    return status.message ? (
      <p className="text-xs text-muted-foreground">{status.message}</p>
    ) : null;
  }

  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <p>Cloudflare custom hostname certificates:</p>
      <div className="space-y-2">
        {status.hostnames.map((hostname) => (
          <div key={hostname.id} className="space-y-1">
            <div className="flex flex-wrap gap-x-2 gap-y-1">
              <code className="text-xs text-foreground">{hostname.hostname}</code>
              <span>{hostname.wildcard ? "wildcard enabled" : "wildcard disabled"}</span>
              <span>hostname: {hostname.hostnameStatus ?? "unknown"}</span>
              <span>ssl: {hostname.sslStatus ?? "unknown"}</span>
            </div>
            {hostname.ownershipVerificationName && hostname.ownershipVerificationValue ? (
              <DnsTextRecord
                label="Ownership TXT"
                name={hostname.ownershipVerificationName}
                value={hostname.ownershipVerificationValue}
              />
            ) : null}
            {hostname.validationRecords.map((record) => (
              <DnsTextRecord
                key={`${hostname.id}:${record.txtName}:${record.txtValue}`}
                label={record.status ? `Certificate TXT (${record.status})` : "Certificate TXT"}
                name={record.txtName}
                value={record.txtValue}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function DnsTextRecord({ label, name, value }: { label: string; name: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p>{label}</p>
      <div className="font-mono text-xs text-foreground">
        <span className="text-muted-foreground">TXT</span> <code>{name}</code> <code>{value}</code>
      </div>
    </div>
  );
}

type CustomHostnameDnsInstructionsData =
  | { defaultHostname: string; kind: "empty" }
  | { kind: "missing-base" }
  | {
      hostname: string;
      kind: "ready";
      target: string;
      wildcardHostname: string;
    };

function customHostnameDnsInstructions(input: {
  customHostname: string;
  project: Project;
  projectHostnameBases: readonly string[];
}): CustomHostnameDnsInstructionsData {
  const base = normalizeProjectHostnameBase(input.projectHostnameBases[0] ?? "");
  const defaultHostname = base ? `${input.project.slug}.${base}` : input.project.slug;
  const hostname = input.customHostname.trim().toLowerCase();

  if (!hostname) {
    return { defaultHostname, kind: "empty" };
  }

  if (!base) {
    return { kind: "missing-base" };
  }

  return {
    hostname,
    kind: "ready",
    target: `cname.${base}`,
    wildcardHostname: `*.${hostname}`,
  };
}
