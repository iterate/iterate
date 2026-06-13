import { Suspense, useCallback, useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import type { Project } from "@iterate-com/os-contract";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
import { toast } from "@iterate-com/ui/components/sonner";
import { StreamDebugLink } from "~/components/stream-debug-link.tsx";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";
import { getPublicRouteConfig, type PublicRouteConfig } from "~/lib/public-route-config.ts";
import { useItx } from "~/itx/use-itx.ts";
import type { ItxProjects } from "~/itx/handle.ts";

type CustomHostnameStatus = Awaited<ReturnType<ItxProjects["customHostnameStatus"]>>;

export const Route = createFileRoute("/_app/projects/$projectSlug/settings")({
  ssr: false,
  loader: async ({ context }) => ({
    breadcrumb: "Settings",
    project: context.project,
    routeConfig: await getPublicRouteConfig(),
  }),
  component: ProjectDetailPage,
});

function ProjectDetailPage() {
  const { project, routeConfig } = Route.useLoaderData();

  return (
    <Suspense
      fallback={<div className="p-4 text-sm text-muted-foreground">Connecting to itx...</div>}
    >
      <ProjectDetailContent project={project} routeConfig={routeConfig} />
    </Suspense>
  );
}

function ProjectDetailContent({
  project,
  routeConfig,
}: {
  project: Project;
  routeConfig: PublicRouteConfig;
}) {
  const router = useRouter();
  // Hostname operations live on the GLOBAL itx handle's `projects` surface.
  const itx = useItx();
  const [customHostname, setCustomHostname] = useState(project.customHostname ?? "");
  const [hostnameToActivate, setHostnameToActivate] = useState("");
  const [hostnameStatus, setHostnameStatus] = useState<CustomHostnameStatus | undefined>(undefined);
  const [statusPending, setStatusPending] = useState(Boolean(project.customHostname));
  const dnsInstructions = customHostnameDnsInstructions({
    customHostname,
    project,
    projectHostnameBases: routeConfig.projectHostnameBases,
  });

  const refreshStatus = useCallback(async () => {
    if (!project.customHostname) return;
    try {
      const status = await itx.projects.customHostnameStatus({ id: project.id });
      setHostnameStatus(status);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setStatusPending(false);
    }
  }, [itx, project.customHostname, project.id]);

  useEffect(() => {
    if (!project.customHostname) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = async () => {
      if (cancelled) return;
      await refreshStatus();
    };
    void tick();
    // Poll while any hostname certificate is not yet active.
    timer = setInterval(() => {
      if (hostnameStatus?.hostnames.some((hostname) => hostname.sslStatus !== "active")) {
        void tick();
      }
    }, 10_000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the itx handle identity changes (reconnect), not on every dep churn
  }, [itx, project.customHostname]);

  const updateConfig = useMutation({
    mutationFn: async (input: { id: string; customHostname: string | null }) => {
      return await itx.projects.updateConfig(input);
    },
    onSuccess: async () => {
      await refreshStatus();
      void router.invalidate();
      toast.success("Project config saved.");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const ensureCustomHostname = useMutation({
    mutationFn: async (input: { id: string; hostname: string }) => {
      return await itx.projects.ensureCustomHostname(input);
    },
    onSuccess: async () => {
      await refreshStatus();
      toast.success("Custom hostname activated.");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

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
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Stream namespace</p>
          <StreamDebugLink label="Open project stream" projectSlug={project.slug} streamPath="/" />
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
              <CustomHostnameCloudflareStatus status={hostnameStatus} isPending={statusPending} />
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
  status: CustomHostnameStatus | undefined;
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
